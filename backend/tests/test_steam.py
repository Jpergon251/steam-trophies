import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.services.steam import get_player_achievements


class GetPlayerAchievementsTests(unittest.IsolatedAsyncioTestCase):
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


if __name__ == "__main__":
    unittest.main()
