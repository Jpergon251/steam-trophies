import unittest
from unittest.mock import patch

import httpx

from app.config import settings
from app.services.steam import SteamConcurrencyLimiter
from scripts.diagnose_achievement_endpoints import (
    achievement_counts,
    experimental_request,
    parse_progress_results,
    parse_top_results,
    safe_error,
    status_bucket,
)


class ExperimentalEndpointDiagnosticTests(unittest.TestCase):
    def test_top_endpoint_parser_keeps_per_game_catalogue_metadata(self):
        result = parse_top_results({
            "response": {
                "games": [
                    {
                        "appid": 10,
                        "total_achievements": 3,
                        "achievements": [{"name": "first", "hidden": True}],
                    }
                ]
            }
        })

        self.assertEqual(result[10]["total_achievements"], 3)
        self.assertEqual(result[10]["achievements"][0]["name"], "first")

    def test_progress_endpoint_parser_keeps_aggregate_values(self):
        result = parse_progress_results({
            "response": {
                "achievement_progress": [
                    {
                        "appid": 10,
                        "unlocked": 2,
                        "total": 3,
                        "percentage": 66.7,
                        "all_unlocked": False,
                    }
                ]
            }
        })

        self.assertEqual(result[10]["unlocked"], 2)
        self.assertEqual(result[10]["total"], 3)

    def test_current_endpoint_counts_individual_unlock_state(self):
        result = achievement_counts({
            "playerstats": {
                "achievements": [
                    {"achieved": 1},
                    {"achieved": True},
                    {"achieved": 0},
                ]
            }
        })

        self.assertEqual(result, (2, 3))
        self.assertIsNone(achievement_counts({"playerstats": {"success": False}}))

    def test_status_summary_and_error_text_do_not_leak_api_key(self):
        key = "diagnostic-secret"
        request = httpx.Request("GET", "https://api.steampowered.com/")
        response = httpx.Response(
            403,
            json={"error": f"Access denied: {key}"},
            request=request,
        )

        self.assertEqual(status_bucket(429), "429")
        self.assertEqual(status_bucket(403), "403")
        self.assertEqual(status_bucket(503), "5xx")
        self.assertNotIn(key, safe_error(response, key))
        self.assertIn("[redacted]", safe_error(response, key))
        html_response = httpx.Response(
            401,
            text=f"<html>secret={key}</html>",
            request=request,
        )
        self.assertNotIn(key, safe_error(html_response, key))


class ExperimentalRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_batch_request_sends_multiple_indexed_appids_in_one_http_call(self):
        requests = []

        async def handler(request):
            requests.append(request)
            return httpx.Response(
                200,
                json={"response": {"games": []}},
                request=request,
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with patch.object(settings, "steam_api_key", "diagnostic-test-key"):
                status, payload, error, _ = await experimental_request(
                    client,
                    SteamConcurrencyLimiter(1),
                    "GET",
                    "IPlayerService/GetTopAchievementsForGames/v1/",
                    "76561199548509683",
                    [10, 20, 30],
                    max_achievements=1000,
                )

        self.assertEqual(status, 200)
        self.assertEqual(payload, {"response": {"games": []}})
        self.assertIsNone(error)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].url.params.get_list("appids[0]"), ["10"])
        self.assertEqual(requests[0].url.params.get_list("appids[1]"), ["20"])
        self.assertEqual(requests[0].url.params.get_list("appids[2]"), ["30"])
        self.assertEqual(requests[0].url.params.get("max_achievements"), "1000")

    async def test_progress_probe_uses_one_form_post_for_multiple_appids(self):
        requests = []

        async def handler(request):
            requests.append(request)
            return httpx.Response(
                401,
                json={"error": "authentication required"},
                request=request,
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with patch.object(settings, "steam_api_key", "diagnostic-test-key"):
                status, _, error, _ = await experimental_request(
                    client,
                    SteamConcurrencyLimiter(1),
                    "POST",
                    "IPlayerService/GetAchievementsProgress/v1/",
                    "76561199548509683",
                    [10, 20],
                )

        self.assertEqual(status, 401)
        self.assertEqual(error, "authentication required")
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].method, "POST")
        self.assertIn("appids%5B0%5D=10", requests[0].content.decode())
        self.assertIn("appids%5B1%5D=20", requests[0].content.decode())
        self.assertNotIn("diagnostic-test-key", requests[0].content.decode())
        self.assertEqual(
            requests[0].url.params.get("key"),
            "diagnostic-test-key",
        )


if __name__ == "__main__":
    unittest.main()
