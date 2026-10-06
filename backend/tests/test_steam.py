import asyncio
import time
import unittest
from unittest.mock import AsyncMock, patch

import httpx

import app.services.steam as steam_service
from app.cache import AsyncTTLCache
from app.config import settings
from app.services.steam import (
    SteamConcurrencyLimiter,
    get_player_achievements,
    steam_request,
)


class GetPlayerAchievementsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        steam_service.steam_cache = AsyncTTLCache(settings.cache_max_entries)

    async def test_no_stats_response_is_unavailable_not_an_error(self):
        response = httpx.Response(
            400,
            json={
                "playerstats": {
                    "error": "Requested app has no stats",
                    "success": False,
                }
            },
        )
        request_error = httpx.HTTPStatusError(
            "Bad Request",
            request=httpx.Request("GET", "https://api.steampowered.com/"),
            response=response,
        )

        with patch("app.services.steam.steam_request", new=AsyncMock(side_effect=request_error)):
            result = await get_player_achievements("76561199548509683", 961200)

        self.assertEqual(result["available"], False)
        self.assertEqual(result["reason"], "no_stats")
        self.assertEqual(result["achievements"], [])
        self.assertEqual(result["achievement_count"], 0)

    async def test_other_http_errors_are_propagated(self):
        response = httpx.Response(
            500,
            request=httpx.Request("GET", "https://api.steampowered.com/"),
        )
        request_error = httpx.HTTPStatusError(
            "Server Error",
            request=response.request,
            response=response,
        )

        with patch("app.services.steam.steam_request", new=AsyncMock(side_effect=request_error)):
            with self.assertRaises(httpx.HTTPStatusError):
                await get_player_achievements("76561199548509683", 961200)


class SteamTransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        steam_service.steam_cache = AsyncTTLCache(settings.cache_max_entries)
        self.client = None
        self.original_retries = settings.steam_max_retries
        self.original_api_key = settings.steam_api_key
        settings.steam_api_key = "test-secret"

    async def asyncTearDown(self):
        steam_service.configure_steam_runtime(None, None)
        if self.client:
            await self.client.aclose()
        settings.steam_max_retries = self.original_retries
        settings.steam_api_key = self.original_api_key

    async def test_retry_occurs_for_temporary_status_only(self):
        calls = 0

        async def handler(request):
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(503, request=request)
            return httpx.Response(200, json={"ok": True}, request=request)

        settings.steam_max_retries = 2
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        steam_service.configure_steam_runtime(self.client, SteamConcurrencyLimiter(2))

        with patch("app.services.steam.asyncio.sleep", new=AsyncMock()):
            result = await steam_request("test/retry", {"id": "retry-case"})

        self.assertEqual(result, {"ok": True})
        self.assertEqual(calls, 2)

    async def test_404_is_negatively_cached_without_retry(self):
        calls = 0

        async def handler(request):
            nonlocal calls
            calls += 1
            return httpx.Response(404, request=request)

        settings.steam_max_retries = 2
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        steam_service.configure_steam_runtime(self.client, SteamConcurrencyLimiter(1))

        with self.assertRaises(httpx.HTTPStatusError):
            await steam_request("test/not-found", {"id": "missing"})
        with self.assertRaises(httpx.HTTPStatusError):
            await steam_request("test/not-found", {"id": "missing"})

        self.assertEqual(calls, 1)

    async def test_semaphore_limits_concurrent_steam_requests(self):
        active = 0
        maximum_active = 0

        async def handler(request):
            nonlocal active, maximum_active
            active += 1
            maximum_active = max(maximum_active, active)
            await asyncio.sleep(0.01)
            active -= 1
            return httpx.Response(200, json={"ok": True}, request=request)

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        steam_service.configure_steam_runtime(self.client, SteamConcurrencyLimiter(2))

        await asyncio.gather(*(
            steam_request("test/concurrency", {"id": str(index)})
            for index in range(8)
        ))

        self.assertEqual(maximum_active, 2)

    async def test_simulated_300_game_profile_reuses_cache_and_caps_concurrency(self):
        calls = 0
        active = 0
        maximum_active = 0

        async def handler(request):
            nonlocal calls, active, maximum_active
            calls += 1
            active += 1
            maximum_active = max(maximum_active, active)
            await asyncio.sleep(0.001)
            active -= 1
            return httpx.Response(200, json={"ok": True}, request=request)

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        steam_service.configure_steam_runtime(self.client, SteamConcurrencyLimiter(8))
        requests = [
            steam_request(
                "IPlayerService/GetOwnedGames/v1/",
                {
                    "steamid": f"7656119954850{app_id % 3:04d}",
                    "appid": str(app_id),
                },
            )
            for app_id in range(300)
        ]

        cold_started = time.perf_counter()
        await asyncio.gather(*requests)
        cold_duration_ms = (time.perf_counter() - cold_started) * 1000
        self.assertEqual(calls, 300)
        self.assertLessEqual(maximum_active, 8)

        warm_started = time.perf_counter()
        await asyncio.gather(*(
            steam_request(
                "IPlayerService/GetOwnedGames/v1/",
                {
                    "steamid": f"7656119954850{app_id % 3:04d}",
                    "appid": str(app_id),
                },
            )
            for app_id in range(300)
        ))
        warm_duration_ms = (time.perf_counter() - warm_started) * 1000
        self.assertEqual(calls, 300)
        stats = await steam_service.steam_cache.stats()
        self.assertGreaterEqual(stats["hits"], 300)
        print(
            "Mock load: users=3 games=300 cold_upstream=300 warm_upstream=0 "
            f"max_concurrency={maximum_active} cache_hits={stats['hits']} "
            f"cold_ms={cold_duration_ms:.1f} warm_ms={warm_duration_ms:.1f}"
        )

    async def test_same_achievement_request_is_coalesced(self):
        async def mocked_request(endpoint, params, **kwargs):
            await asyncio.sleep(0.01)
            if "GetPlayerAchievements" in endpoint:
                return {
                    "playerstats": {
                        "success": True,
                        "gameName": "Example",
                        "achievements": [{"apiname": "ONE", "achieved": 1}],
                    }
                }
            return {
                "achievementpercentages": {
                    "achievements": [{"name": "ONE", "percent": "50"}]
                }
            }

        request = AsyncMock(side_effect=mocked_request)
        with patch("app.services.steam.steam_request", new=request):
            first, second = await asyncio.gather(
                get_player_achievements("76561199548509684", 12345),
                get_player_achievements("76561199548509684", 12345),
            )

        self.assertEqual(first, second)
        self.assertEqual(request.await_count, 2)
        self.assertEqual(first["achievements"][0]["global_percent"], "50")

    async def test_force_refresh_bypasses_player_cache_but_keeps_global_cache_path(self):
        response = {
            "playerstats": {
                "success": True,
                "gameName": "Example",
                "achievements": [],
            }
        }
        global_response = {"achievementpercentages": {"achievements": []}}
        request = AsyncMock(side_effect=[response, global_response, response, global_response])

        with patch("app.services.steam.steam_request", new=request):
            await get_player_achievements("76561199548509685", 12346)
            await get_player_achievements(
                "76561199548509685",
                12346,
                force_refresh=True,
            )

        self.assertEqual(request.await_count, 4)
        self.assertNotIn("force_refresh", request.await_args_list[1].kwargs)
        self.assertTrue(request.await_args_list[2].kwargs["force_refresh"])

    async def test_game_without_stats_does_not_block_another_game(self):
        no_stats_response = httpx.Response(
            400,
            json={
                "playerstats": {
                    "success": False,
                    "error": "Requested app has no stats",
                }
            },
            request=httpx.Request("GET", "https://api.steampowered.com/"),
        )
        no_stats_error = httpx.HTTPStatusError(
            "Bad Request",
            request=no_stats_response.request,
            response=no_stats_response,
        )

        async def mocked_request(endpoint, params, **kwargs):
            if "GetPlayerAchievements" in endpoint and params["appid"] == 12347:
                raise no_stats_error
            if "GetPlayerAchievements" in endpoint:
                return {
                    "playerstats": {
                        "success": True,
                        "gameName": "Available",
                        "achievements": [],
                    }
                }
            return {"achievementpercentages": {"achievements": []}}

        with patch(
            "app.services.steam.steam_request",
            new=AsyncMock(side_effect=mocked_request),
        ):
            unavailable, available = await asyncio.gather(
                get_player_achievements("76561199548509687", 12347),
                get_player_achievements("76561199548509687", 12348),
            )

        self.assertFalse(unavailable["available"])
        self.assertTrue(available["available"])


if __name__ == "__main__":
    unittest.main()
