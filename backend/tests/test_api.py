import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import httpx

import app.services.steam as steam_service
from app.main import InMemoryRateLimiter, app, fastapi_app

STEAM_ID = "76561199548509683"


async def request_app(
    path,
    *,
    method="GET",
    headers=None,
    client_ip="127.0.0.1",
    client_port=5173,
):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=(client_ip, client_port)),
        base_url="http://test",
    ) as client:
        return await client.request(method, path, headers=headers)


class CorsTests(unittest.IsolatedAsyncioTestCase):
    async def test_localhost_ip_is_allowed_for_development(self):
        response = await request_app(
            "/api/steam/search",
            method="OPTIONS",
            headers={
                "Origin": "http://127.0.0.1:5173",
                "Access-Control-Request-Method": "GET",
            },
        )

        self.assertEqual(
            response.headers.get("access-control-allow-origin"),
            "http://127.0.0.1:5173",
        )


class ApiCompatibilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_existing_steam_routes_keep_their_response_shapes(self):
        profile = {"response": {"players": [{"steamid": STEAM_ID}]}}
        games = {"response": {"games": [{"appid": 10, "name": "Example"}]}}
        achievements = {"game": {"appid": 10}, "achievements": [], "available": True}
        with (
            patch("app.main.search_steam_profile", new=AsyncMock(return_value=profile)),
            patch("app.main.get_steam_profile", new=AsyncMock(return_value=profile)),
            patch("app.main.get_owned_games", new=AsyncMock(return_value=games)),
            patch("app.main.get_player_achievements", new=AsyncMock(return_value=achievements)),
        ):
            responses = await asyncio.gather(
                request_app("/api/steam/search?q=example", client_port=5201),
                request_app(f"/api/steam/profile?steam_id={STEAM_ID}", client_port=5202),
                request_app(f"/api/steam/profile/{STEAM_ID}/games", client_port=5203),
                request_app(
                    f"/api/steam/profile/{STEAM_ID}/games/10/achievements",
                    client_port=5204,
                ),
            )

        self.assertEqual([response.status_code for response in responses], [200] * 4)
        self.assertEqual(
            [response.json() for response in responses],
            [profile, profile, games, achievements],
        )

    async def test_force_refresh_parameter_is_optional_and_forwarded(self):
        with patch(
            "app.main.get_player_achievements",
            new=AsyncMock(return_value={"available": True}),
        ) as mocked:
            response = await request_app(
                f"/api/steam/profile/{STEAM_ID}/games/10/achievements?force_refresh=true",
                client_port=5210,
            )

        self.assertEqual(response.status_code, 200)
        mocked.assert_awaited_once_with(STEAM_ID, 10, force_refresh=True)

    async def test_health_is_fast_and_does_not_call_steam(self):
        with (
            patch("app.main.search_steam_profile", new=AsyncMock(side_effect=AssertionError)),
            patch("app.main.get_steam_profile", new=AsyncMock(side_effect=AssertionError)),
            patch("app.main.get_owned_games", new=AsyncMock(side_effect=AssertionError)),
            patch("app.main.get_player_achievements", new=AsyncMock(side_effect=AssertionError)),
        ):
            async with fastapi_app.router.lifespan_context(fastapi_app):
                response = await request_app("/api/health", client_port=5220)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertIsNone(steam_service._http_client)

    async def test_steam_api_key_is_not_returned_or_logged_on_upstream_failure(self):
        secret = "never-log-this-secret"
        request = httpx.Request(
            "GET",
            f"https://api.steampowered.com/?key={secret}",
        )
        response = httpx.Response(500, request=request)
        error = httpx.HTTPStatusError("upstream error", request=request, response=response)
        with (
            patch("app.main.search_steam_profile", new=AsyncMock(side_effect=error)),
            self.assertLogs("app.main", level="WARNING") as logs,
        ):
            result = await request_app("/api/steam/search?q=example", client_port=5230)

        self.assertEqual(result.status_code, 502)
        self.assertNotIn(secret, result.text)
        self.assertNotIn(secret, "\n".join(logs.output))

    async def test_upstream_429_is_logged_and_returned_as_cors_enabled_502(self):
        upstream_request = httpx.Request("GET", "https://api.steampowered.com/")
        upstream_response = httpx.Response(429, request=upstream_request)
        upstream_error = httpx.HTTPStatusError(
            "Steam rate limit",
            request=upstream_request,
            response=upstream_response,
        )
        with (
            patch(
                "app.main.get_player_achievements",
                new=AsyncMock(side_effect=upstream_error),
            ),
            self.assertLogs("app.main", level="WARNING") as logs,
        ):
            response = await request_app(
                f"/api/steam/profile/{STEAM_ID}/games/952060/achievements",
                headers={"Origin": "https://jpergon251.github.io"},
                client_ip="127.0.0.31",
            )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(
            response.headers.get("access-control-allow-origin"),
            "https://jpergon251.github.io",
        )
        self.assertIn("original_status=429", "\n".join(logs.output))
        self.assertIn("final_status=502", "\n".join(logs.output))
        self.assertIn("reason=steam_rate_limited", "\n".join(logs.output))

    async def test_backend_rate_limit_429_includes_cors_and_reason(self):
        with (
            patch("app.main.settings.rate_limit_search", 1),
            patch("app.main.search_steam_profile", new=AsyncMock(return_value={"ok": True})),
        ):
            await request_app(
                "/api/steam/search?q=first",
                headers={"Origin": "https://jpergon251.github.io"},
                client_ip="127.0.0.32",
            )
            with self.assertLogs("app.main", level="WARNING") as logs:
                response = await request_app(
                    "/api/steam/search?q=second",
                    headers={"Origin": "https://jpergon251.github.io"},
                    client_ip="127.0.0.32",
                )

        self.assertEqual(response.status_code, 429)
        self.assertEqual(
            response.headers.get("access-control-allow-origin"),
            "https://jpergon251.github.io",
        )
        self.assertEqual(
            response.headers.get("x-ratelimit-reason"),
            "search_requests_per_ip",
        )
        self.assertIn("reason=rate_limit", "\n".join(logs.output))

    async def test_achievement_rate_limit_logs_app_and_returns_cors_429(self):
        with (
            patch("app.main.settings.rate_limit_achievements", 1),
            patch(
                "app.main.get_player_achievements",
                new=AsyncMock(return_value={"available": True}),
            ),
        ):
            await request_app(
                f"/api/steam/profile/{STEAM_ID}/games/952060/achievements",
                headers={"Origin": "https://jpergon251.github.io"},
                client_ip="127.0.0.35",
            )
            with self.assertLogs("app.main", level="WARNING") as logs:
                response = await request_app(
                    f"/api/steam/profile/{STEAM_ID}/games/952060/achievements",
                    headers={"Origin": "https://jpergon251.github.io"},
                    client_ip="127.0.0.35",
                )

        self.assertEqual(response.status_code, 429)
        self.assertEqual(
            response.headers.get("access-control-allow-origin"),
            "https://jpergon251.github.io",
        )
        self.assertEqual(
            response.headers.get("x-ratelimit-reason"),
            "achievements_requests_per_ip",
        )
        output = "\n".join(logs.output)
        self.assertIn("appid=952060", output)
        self.assertIn("steam_id=…9683", output)
        self.assertIn("final_status=429", output)

    async def test_backend_400_and_502_errors_include_cors_headers(self):
        invalid_profile = await request_app(
            "/api/steam/profile/123/games",
            headers={"Origin": "https://jpergon251.github.io"},
            client_ip="127.0.0.33",
        )
        with patch(
            "app.main.search_steam_profile",
            new=AsyncMock(side_effect=RuntimeError("upstream unavailable")),
        ):
            upstream_failure = await request_app(
                "/api/steam/search?q=example",
                headers={"Origin": "https://jpergon251.github.io"},
                client_ip="127.0.0.34",
            )

        for response, status in ((invalid_profile, 400), (upstream_failure, 502)):
            self.assertEqual(response.status_code, status)
            self.assertEqual(
                response.headers.get("access-control-allow-origin"),
                "https://jpergon251.github.io",
            )

    async def test_metrics_mask_full_steam_id(self):
        with (
            patch(
                "app.main.get_steam_profile",
                new=AsyncMock(return_value={"response": {"players": [{"steamid": STEAM_ID}]}}),
            ),
            self.assertLogs("app.main", level="INFO") as logs,
        ):
            response = await request_app(
                f"/api/steam/profile?steam_id={STEAM_ID}",
                client_port=5231,
            )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn(STEAM_ID, "\n".join(logs.output))
        self.assertIn("…9683", "\n".join(logs.output))


class RateLimitTests(unittest.TestCase):
    def test_rate_limiter_rejects_requests_after_limit(self):
        limiter = InMemoryRateLimiter()
        self.assertEqual(limiter.check("192.0.2.1", "search", 1), (True, 0))
        allowed, retry_after = limiter.check("192.0.2.1", "search", 1)
        self.assertFalse(allowed)
        self.assertGreaterEqual(retry_after, 1)


class RateLimitMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def test_search_limit_returns_429(self):
        with (
            patch("app.main.settings.rate_limit_search", 1),
            patch("app.main.search_steam_profile", new=AsyncMock(return_value={"ok": True})),
        ):
            first = await request_app(
                "/api/steam/search?q=first",
                client_ip="127.0.0.9",
                client_port=5251,
            )
            second = await request_app(
                "/api/steam/search?q=second",
                client_ip="127.0.0.9",
                client_port=5252,
            )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 429)
        self.assertIn("Retry-After", second.headers)


if __name__ == "__main__":
    unittest.main()
