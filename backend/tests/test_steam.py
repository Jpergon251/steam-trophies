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
    _compact_top_achievement_response,
    get_achievement_summaries,
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

    async def test_schema_fills_missing_achievement_icons_and_names(self):
        player = {
            "playerstats": {
                "success": True,
                "gameName": "Example",
                "achievements": [{
                    "apiname": "FIRST",
                    "achieved": 1,
                    "icon": None,
                    "icongray": None,
                }],
            },
        }
        global_percentages = {
            "achievementpercentages": {
                "achievements": [{"name": "FIRST", "percent": "12.5"}],
            },
        }
        schema = {
            "game": {
                "availableGameStats": {
                    "achievements": [{
                        "name": "FIRST",
                        "displayName": "First achievement",
                        "description": "Complete the first task.",
                        "icon": "https://steamcdn-a.akamaihd.net/first.png",
                        "icongray": "https://steamcdn-a.akamaihd.net/first-gray.png",
                        "hidden": 0,
                    }],
                },
            },
        }
        request = AsyncMock(side_effect=[player, global_percentages, schema])
        with patch("app.services.steam.steam_request", new=request):
            result = await get_player_achievements("76561199548509683", 123)

        achievement = result["achievements"][0]
        self.assertEqual(achievement["name"], "First achievement")
        self.assertEqual(achievement["description"], "Complete the first task.")
        self.assertEqual(achievement["icon"], "https://steamcdn-a.akamaihd.net/first.png")
        self.assertEqual(achievement["icongray"], "https://steamcdn-a.akamaihd.net/first-gray.png")
        self.assertEqual(achievement["global_percent"], "12.5")
        self.assertTrue(result["icons_complete"])
        self.assertEqual(request.await_count, 3)


class AchievementSummaryTests(unittest.IsolatedAsyncioTestCase):
    steam_id = "76561199548509683"

    async def asyncSetUp(self):
        steam_service.steam_cache = AsyncTTLCache(settings.cache_max_entries)
        self.original_api_key = settings.steam_api_key
        settings.steam_api_key = "test-secret"

    async def test_top_response_is_adapted_to_unlocked_summary(self):
        owned = {
            "response": {
                "games": [{"appid": 10, "name": "Example"}],
            },
        }
        top = {
            "response": {
                "games": [{
                    "appid": 10,
                    "total_achievements": 4,
                    "achievements": [{
                        "name": "ONE",
                        "desc": "First",
                        "icon": "0123456789abcdef",
                        "icon_gray": "https://cdn.example.test/gray.png",
                        "hidden": 0,
                        "player_percent_unlocked": 8.5,
                    }],
                }],
            },
        }
        with patch(
            "app.services.steam.steam_request",
            new=AsyncMock(side_effect=[owned, top]),
        ) as request:
            result = await get_achievement_summaries(self.steam_id)

        summary = result["games"][0]
        self.assertEqual(summary["appid"], 10)
        self.assertEqual(summary["achievement_count"], 4)
        self.assertEqual(summary["unlocked_count"], 1)
        self.assertEqual(summary["tier_counts"], {"bronze": 0, "silver": 0, "gold": 1})
        trophy_group = result["trophies"][0]
        self.assertEqual(trophy_group["tier"], "gold")
        trophy_columns = trophy_group["columns"]
        self.assertEqual(trophy_columns["percentages"], [8.5])
        self.assertEqual(
            trophy_columns["icons"][0],
            "https://media.steampowered.com/steamcommunity/public/images/apps/10/0123456789abcdef.jpg",
        )
        self.assertEqual(
            trophy_columns["gray_icons"][0],
            "https://cdn.example.test/gray.png",
        )
        self.assertNotIn("achievements", summary)
        self.assertNotIn("apiname", trophy_columns)
        self.assertEqual(result["errors"], {})
        self.assertEqual(request.await_count, 2)
        self.assertEqual(request.await_args_list[1].args[0], "IPlayerService/GetTopAchievementsForGames/v1/")
        self.assertEqual(request.await_args_list[1].args[1]["max_achievements"], 1000)

    async def test_top_response_compacts_achievement_objects_to_tier_columns(self):
        compact = _compact_top_achievement_response({
            "response": {
                "games": [{
                    "appid": 10,
                    "total_achievements": 2,
                    "achievements": [
                        {
                            "name": "Rare",
                            "desc": "Description",
                            "icon": "icon",
                            "icon_gray": "gray",
                            "player_percent_unlocked": 10,
                        },
                        {
                            "name": "Common",
                            "player_percent_unlocked": 70,
                        },
                    ],
                }],
            },
        })

        game = compact["response"]["games"][0]
        self.assertNotIn("achievements", game)
        self.assertEqual(game["achievement_columns"]["gold"]["names"], ["Rare"])
        self.assertEqual(game["achievement_columns"]["bronze"]["names"], ["Common"])
        self.assertEqual(game["achievement_columns"]["silver"]["names"], [])

    async def test_zero_partial_and_complete_progress_keep_exact_counts(self):
        owned = {
            "response": {
                "games": [
                    {"appid": 10, "name": "Zero"},
                    {"appid": 20, "name": "Partial"},
                    {"appid": 30, "name": "Complete"},
                ],
            },
        }
        top = {
            "response": {
                "games": [
                    {"appid": 10, "total_achievements": 4, "achievements": []},
                    {"appid": 20, "total_achievements": 2, "achievements": [{"name": "A"}]},
                    {"appid": 30, "total_achievements": 2, "achievements": [{"name": "A"}, {"name": "B"}]},
                ],
            },
        }
        with patch(
            "app.services.steam.steam_request",
            new=AsyncMock(side_effect=[owned, top]),
        ):
            result = await get_achievement_summaries(self.steam_id)

        counts = {
            item["appid"]: (item["unlocked_count"], item["achievement_count"])
            for item in result["games"]
        }
        self.assertEqual(counts, {10: (0, 4), 20: (1, 2), 30: (2, 2)})

    async def test_truncated_or_missing_game_falls_back_only_for_that_appid(self):
        owned = {
            "response": {
                "games": [
                    {"appid": 10, "name": "Complete"},
                    {"appid": 20, "name": "Missing"},
                ],
            },
        }
        top = {
            "response": {
                "games": [{
                    "appid": 10,
                    "total_achievements": 2,
                    "achievements": [{"name": "one"}],
                }],
            },
        }
        legacy = {
            "game": {"appid": 20, "name": "Missing"},
            "achievements": [{"apiname": "TWO", "achieved": 1}],
            "achievement_count": 2,
            "available": True,
        }
        with (
            patch(
                "app.services.steam.steam_request",
                new=AsyncMock(side_effect=[owned, top]),
            ),
            patch(
                "app.services.steam.get_player_achievements",
                new=AsyncMock(return_value=legacy),
            ) as fallback,
        ):
            result = await get_achievement_summaries(self.steam_id)

        self.assertEqual([item["appid"] for item in result["games"]], [10, 20])
        self.assertEqual(result["games"][1]["unlocked_count"], 1)
        fallback.assert_awaited_once_with(self.steam_id, 20)
        self.assertEqual(result["errors"], {})

    async def test_result_at_configured_cap_falls_back_for_that_game(self):
        owned = {
            "response": {
                "games": [{"appid": 10, "name": "Capped"}],
            },
        }
        top = {
            "response": {
                "games": [{
                    "appid": 10,
                    "total_achievements": 3,
                    "achievements": [{"name": "one"}],
                }],
            },
        }
        legacy = {
            "game": {"appid": 10, "name": "Capped"},
            "achievements": [{"apiname": "ONE", "achieved": 1}],
            "achievement_count": 3,
            "available": True,
        }
        with (
            patch(
                "app.services.steam.steam_request",
                new=AsyncMock(side_effect=[owned, top]),
            ),
            patch(
                "app.services.steam.get_player_achievements",
                new=AsyncMock(return_value=legacy),
            ) as fallback,
            patch.object(settings, "top_achievements_max", 1),
        ):
            result = await get_achievement_summaries(self.steam_id)

        self.assertEqual(result["games"][0]["unlocked_count"], 1)
        fallback.assert_awaited_once_with(self.steam_id, 10)

    async def test_unexpected_single_game_response_uses_legacy_fallback(self):
        owned = {
            "response": {
                "games": [{"appid": 10, "name": "Unexpected"}],
            },
        }
        legacy = {
            "game": {"appid": 10, "name": "Unexpected"},
            "achievements": [],
            "achievement_count": 0,
            "available": False,
        }
        with (
            patch(
                "app.services.steam.steam_request",
                new=AsyncMock(side_effect=[owned, {"unexpected": True}]),
            ),
            patch(
                "app.services.steam.get_player_achievements",
                new=AsyncMock(return_value=legacy),
            ) as fallback,
        ):
            result = await get_achievement_summaries(self.steam_id)

        self.assertFalse(result["games"][0]["available"])
        fallback.assert_awaited_once_with(self.steam_id, 10)

    async def test_failed_multi_game_batch_does_not_trigger_mass_legacy_fallback(self):
        owned = {
            "response": {
                "games": [{"appid": app_id, "name": str(app_id)} for app_id in range(1, 20)],
            },
        }
        request = httpx.Request("GET", "https://api.steampowered.com/")
        response = httpx.Response(429, request=request)
        error = httpx.HTTPStatusError("rate limited", request=request, response=response)
        with (
            patch("app.services.steam.steam_request", new=AsyncMock(side_effect=[owned, error])),
            patch("app.services.steam.get_player_achievements", new=AsyncMock()) as fallback,
            patch.object(settings, "top_achievements_batch_size", 164),
        ):
            result = await get_achievement_summaries(self.steam_id)

        self.assertEqual(result["games"], [])
        self.assertEqual(len(result["errors"]), 19)
        self.assertTrue(all(item["status"] == 429 for item in result["errors"].values()))
        fallback.assert_not_awaited()

    async def test_failed_small_batch_falls_back_only_for_its_games(self):
        owned = {
            "response": {
                "games": [{"appid": 10, "name": "A"}, {"appid": 20, "name": "B"}],
            },
        }
        request = httpx.Request("GET", "https://api.steampowered.com/")
        response = httpx.Response(503, request=request)
        error = httpx.HTTPStatusError("unavailable", request=request, response=response)
        legacy = {
            "game": {"appid": 10},
            "achievements": [],
            "achievement_count": 1,
            "available": True,
        }
        with (
            patch(
                "app.services.steam.steam_request",
                new=AsyncMock(side_effect=[owned, error]),
            ),
            patch(
                "app.services.steam.get_player_achievements",
                new=AsyncMock(return_value=legacy),
            ) as fallback,
            patch.object(settings, "top_achievements_batch_size", 2),
        ):
            result = await get_achievement_summaries(self.steam_id)

        self.assertEqual([item["appid"] for item in result["games"]], [10, 20])
        self.assertEqual(result["errors"], {})
        self.assertEqual(fallback.await_count, 2)

    async def test_configured_batch_size_and_max_are_applied(self):
        owned = {
            "response": {
                "games": [{"appid": app_id, "name": str(app_id)} for app_id in range(1, 6)],
            },
        }

        async def respond(endpoint, params, **kwargs):
            if endpoint.endswith("GetOwnedGames/v1/"):
                return owned
            app_ids = [
                int(value)
                for key, value in params.items()
                if key.startswith("appids[")
            ]
            return {
                "response": {
                    "games": [{
                        "appid": app_id,
                        "total_achievements": 2,
                        "achievements": [],
                    } for app_id in app_ids],
                },
            }

        with (
            patch("app.services.steam.steam_request", new=AsyncMock(side_effect=respond)) as request,
            patch.object(settings, "top_achievements_batch_size", 2),
            patch.object(settings, "top_achievements_max", 17),
        ):
            result = await get_achievement_summaries(self.steam_id)

        top_calls = [
            call for call in request.await_args_list
            if "GetTopAchievementsForGames" in call.args[0]
        ]
        self.assertEqual(len(top_calls), 3)
        self.assertEqual([len([k for k in call.args[1] if k.startswith("appids[")]) for call in top_calls], [2, 2, 1])
        self.assertTrue(all(call.args[1]["max_achievements"] == 17 for call in top_calls))
        self.assertEqual(len(result["games"]), 5)

    async def test_requested_batch_processes_only_its_appids_and_returns_metadata(self):
        owned = {
            "response": {
                "games": [
                    {"appid": app_id, "name": str(app_id)}
                    for app_id in range(1, 6)
                ],
            },
        }

        async def respond(endpoint, params, **kwargs):
            if endpoint.endswith("GetOwnedGames/v1/"):
                return owned
            app_ids = [
                int(value)
                for key, value in params.items()
                if key.startswith("appids[")
            ]
            return {
                "response": {
                    "games": [{
                        "appid": app_id,
                        "total_achievements": 2,
                        "achievements": [],
                    } for app_id in app_ids],
                },
            }

        with (
            patch("app.services.steam.steam_request", new=AsyncMock(side_effect=respond)) as request,
            patch.object(settings, "top_achievements_batch_size", 2),
        ):
            result = await get_achievement_summaries(
                self.steam_id,
                batch_index=1,
            )

        top_calls = [
            call for call in request.await_args_list
            if "GetTopAchievementsForGames" in call.args[0]
        ]
        self.assertEqual(result["batch_index"], 1)
        self.assertEqual(result["batch_count"], 3)
        self.assertEqual(result["batch_size"], 2)
        self.assertEqual([summary["appid"] for summary in result["games"]], [3, 4])
        self.assertEqual(len(top_calls), 1)
        self.assertEqual(
            [int(value) for key, value in top_calls[0].args[1].items() if key.startswith("appids[")],
            [3, 4],
        )

    async def test_large_profiles_are_served_in_compact_pages(self):
        profile_sizes = {
            100: 1_000,
            1_000: 10_000,
            5_000: 100_000,
            13_000: 700_000,
        }

        for game_count, achievement_total in profile_sizes.items():
            with self.subTest(game_count=game_count):
                base_count, remainder = divmod(achievement_total, game_count)
                owned_games = [
                    {
                        "appid": app_id,
                        "name": f"Game {app_id}",
                        "total_achievements": base_count + int(app_id <= remainder),
                    }
                    for app_id in range(1, game_count + 1)
                ]
                games_by_id = {game["appid"]: game for game in owned_games}

                async def respond(endpoint, params, **kwargs):
                    if endpoint.endswith("GetOwnedGames/v1/"):
                        return {"response": {"games": owned_games}}
                    app_ids = [
                        int(value)
                        for key, value in params.items()
                        if key.startswith("appids[")
                    ]
                    return {
                        "response": {
                            "games": [
                                {
                                    "appid": app_id,
                                    "total_achievements": games_by_id[app_id]["total_achievements"],
                                    "achievements": [],
                                }
                                for app_id in app_ids
                            ],
                        },
                    }

                accumulated_games = 0
                accumulated_total = 0
                with (
                    patch("app.services.steam.steam_request", new=AsyncMock(side_effect=respond)),
                    patch.object(settings, "top_achievements_batch_size", 350),
                ):
                    batch_count = (game_count + 349) // 350
                    for batch_index in range(batch_count):
                        page = await get_achievement_summaries(
                            self.steam_id,
                            batch_index=batch_index,
                        )
                        self.assertEqual(page["batch_count"], batch_count)
                        self.assertEqual(page["batch_index"], batch_index)
                        self.assertEqual(page["batch_size"], 350)
                        self.assertLessEqual(len(page["games"]), 350)
                        self.assertEqual(page["trophies"], [])
                        self.assertTrue(
                            all("achievements" not in game for game in page["games"]),
                        )
                        accumulated_games += len(page["games"])
                        accumulated_total += sum(
                            game["achievement_count"]
                            for game in page["games"]
                        )

                self.assertEqual(accumulated_games, game_count)
                self.assertEqual(accumulated_total, achievement_total)

    async def test_configured_batch_size_is_capped_to_verified_get_url_limit(self):
        owned = {
            "response": {
                "games": [{"appid": app_id, "name": str(app_id)} for app_id in range(1, 501)],
            },
        }

        async def respond(endpoint, params, **kwargs):
            if endpoint.endswith("GetOwnedGames/v1/"):
                return owned
            app_ids = [
                int(value)
                for key, value in params.items()
                if key.startswith("appids[")
            ]
            return {
                "response": {
                    "games": [{
                        "appid": app_id,
                        "total_achievements": 0,
                        "achievements": [],
                    } for app_id in app_ids],
                },
            }

        with (
            patch("app.services.steam.steam_request", new=AsyncMock(side_effect=respond)) as request,
            patch.object(settings, "top_achievements_batch_size", 1_000),
        ):
            page = await get_achievement_summaries(self.steam_id, batch_index=0)

        top_call = next(
            call for call in request.await_args_list
            if "GetTopAchievementsForGames" in call.args[0]
        )
        self.assertEqual(page["batch_size"], 350)
        self.assertEqual(page["batch_count"], 2)
        self.assertEqual(
            len([key for key in top_call.args[1] if key.startswith("appids[")]),
            350,
        )

    async def test_414_top_request_splits_chunk_without_changing_page_size(self):
        owned = {
            "response": {
                "games": [{"appid": app_id, "name": str(app_id)} for app_id in range(101, 105)],
            },
        }
        top_chunk_sizes = []

        async def respond(endpoint, params, **kwargs):
            if endpoint.endswith("GetOwnedGames/v1/"):
                return owned
            app_ids = [
                int(value)
                for key, value in params.items()
                if key.startswith("appids[")
            ]
            top_chunk_sizes.append(len(app_ids))
            if len(app_ids) > 2:
                request = httpx.Request(
                    "GET",
                    "https://api.steampowered.com/test",
                )
                response = httpx.Response(414, request=request)
                raise httpx.HTTPStatusError(
                    "URI Too Long",
                    request=request,
                    response=response,
                )
            return {
                "response": {
                    "games": [
                        {
                            "appid": app_id,
                            "total_achievements": 0,
                            "achievements": [],
                        }
                        for app_id in app_ids
                    ],
                },
            }

        with (
            patch("app.services.steam.steam_request", new=AsyncMock(side_effect=respond)),
            patch.object(settings, "top_achievements_batch_size", 4),
        ):
            result = await get_achievement_summaries(
                self.steam_id,
                batch_index=0,
            )

        self.assertEqual(top_chunk_sizes, [4, 2, 2])
        self.assertEqual(result["batch_size"], 4)
        self.assertEqual(result["batch_count"], 1)
        self.assertEqual([game["appid"] for game in result["games"]], [101, 102, 103, 104])
        self.assertEqual(result["errors"], {})

    async def test_requested_batch_out_of_range_is_rejected(self):
        owned = {"response": {"games": [{"appid": 10, "name": "Example"}]}}
        with (
            patch("app.services.steam.steam_request", new=AsyncMock(return_value=owned)),
            patch.object(settings, "top_achievements_batch_size", 2),
        ):
            with self.assertRaisesRegex(ValueError, "out of range"):
                await get_achievement_summaries(self.steam_id, batch_index=1)

    async def test_identical_summary_calls_reuse_cached_owned_games_and_batch(self):
        calls = []

        async def handler(request):
            calls.append(request)
            if "GetOwnedGames" in request.url.path:
                return httpx.Response(
                    200,
                    json={"response": {"games": [{"appid": 10, "name": "Example"}]}},
                    request=request,
                )
            return httpx.Response(
                200,
                json={
                    "response": {
                        "games": [{
                            "appid": 10,
                            "total_achievements": 1,
                            "achievements": [],
                        }],
                    },
                },
                request=request,
            )

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        steam_service.configure_steam_runtime(self.client, SteamConcurrencyLimiter(2))
        first, second = await asyncio.gather(
            get_achievement_summaries(self.steam_id),
            get_achievement_summaries(self.steam_id),
        )
        self.assertEqual(first, second)
        self.assertEqual(len(calls), 2)
        top_request = next(request for request in calls if "GetTopAchievementsForGames" in request.url.path)
        self.assertEqual(top_request.url.params["appids[0]"], "10")
        self.assertEqual(top_request.url.params["max_achievements"], "1000")
        self.assertNotIn("test-secret", first.__repr__())

    async def asyncTearDown(self):
        steam_service.configure_steam_runtime(None, None)
        settings.steam_api_key = self.original_api_key
        if getattr(self, "client", None):
            await self.client.aclose()


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
            if "GetSchemaForGame" in endpoint:
                return {"game": {"availableGameStats": {"achievements": []}}}
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
        self.assertEqual(request.await_count, 3)
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
        schema_response = {"game": {"availableGameStats": {"achievements": []}}}
        request = AsyncMock(side_effect=[
            response, global_response, schema_response,
            response, global_response, schema_response,
        ])

        with patch("app.services.steam.steam_request", new=request):
            await get_player_achievements("76561199548509685", 12346)
            await get_player_achievements(
                "76561199548509685",
                12346,
                force_refresh=True,
            )

        self.assertEqual(request.await_count, 6)
        self.assertNotIn("force_refresh", request.await_args_list[1].kwargs)
        self.assertTrue(request.await_args_list[3].kwargs["force_refresh"])

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
            if "GetSchemaForGame" in endpoint:
                return {"game": {"availableGameStats": {"achievements": []}}}
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
