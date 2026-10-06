"""Isolated live comparison of Steam's experimental achievement endpoints."""

import argparse
import asyncio
import json
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings
from app.services.steam import SteamConcurrencyLimiter, configure_steam_runtime, get_owned_games

STEAM_API_BASE = "https://api.steampowered.com"
PROFILE_ID_LENGTH = 17
CURRENT_CONCURRENCY = 2


def parse_games(response: dict[str, Any]) -> list[dict[str, Any]]:
    games = response.get("response", {}).get("games", [])
    if not isinstance(games, list):
        raise ValueError("Steam returned an invalid owned-games collection.")
    return [
        game for game in games
        if isinstance(game, dict) and str(game.get("appid", "")).isdigit()
    ]


def parse_top_results(response: dict[str, Any]) -> dict[int, dict[str, Any]]:
    games = response.get("response", {}).get("games", [])
    if not isinstance(games, list):
        return {}
    return {
        int(game["appid"]): game
        for game in games
        if isinstance(game, dict) and str(game.get("appid", "")).isdigit()
    }


def parse_progress_results(response: dict[str, Any]) -> dict[int, dict[str, Any]]:
    progress = response.get("response", {}).get("achievement_progress", [])
    if not isinstance(progress, list):
        return {}
    return {
        int(game["appid"]): game
        for game in progress
        if isinstance(game, dict) and str(game.get("appid", "")).isdigit()
    }


def achievement_counts(response: dict[str, Any]) -> tuple[int, int] | None:
    player_stats = response.get("playerstats")
    achievements = player_stats.get("achievements") if isinstance(player_stats, dict) else None
    if not isinstance(achievements, list):
        return None
    unlocked = sum(
        1
        for achievement in achievements
        if isinstance(achievement, dict)
        and (
            achievement.get("achieved") is True
            or str(achievement.get("achieved", "")) == "1"
        )
    )
    return unlocked, len(achievements)


def status_bucket(status_code: int | None) -> str:
    if status_code is None:
        return "ERROR"
    if status_code == 429:
        return "429"
    if status_code in {403, 404}:
        return str(status_code)
    if status_code >= 500:
        return "5xx"
    if status_code >= 400:
        return "4xx"
    return "2xx"


def safe_error(response: httpx.Response, api_key: str) -> str:
    try:
        payload = response.json()
    except ValueError:
        return "upstream returned a non-JSON error"
    if not isinstance(payload, dict):
        return "upstream returned an invalid error response"
    player_stats = payload.get("playerstats")
    message = (
        payload.get("error")
        or payload.get("message")
        or (player_stats.get("error") if isinstance(player_stats, dict) else None)
    )
    if not isinstance(message, str):
        return "upstream returned an error response"
    body = message
    if api_key:
        body = body.replace(api_key, "[redacted]")
    return body[:200].replace("\n", " ")


async def experimental_request(
    client: httpx.AsyncClient,
    limiter: SteamConcurrencyLimiter,
    method: str,
    endpoint: str,
    steam_id: str,
    app_ids: list[int],
    *,
    max_achievements: int = 500,
) -> tuple[int | None, dict[str, Any], str | None, float]:
    indexed_app_ids = {f"appids[{index}]": str(app_id) for index, app_id in enumerate(app_ids)}
    params = {
        "key": settings.steam_api_key or "",
        "steamid": steam_id,
    }
    if method == "GET":
        params.update(indexed_app_ids)
        params.update({
            "language": "english",
            "max_achievements": str(max_achievements),
        })
        data = None
    else:
        data = {
            **indexed_app_ids,
            "language": "english",
        }

    started = time.perf_counter()
    try:
        async with limiter.slot():
            response = await client.request(
                method,
                f"{STEAM_API_BASE}/{endpoint}",
                params=params,
                data=data,
            )
        elapsed_ms = (time.perf_counter() - started) * 1000
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        error = safe_error(response, settings.steam_api_key or "") if response.is_error else None
        return response.status_code, payload, error, elapsed_ms
    except httpx.HTTPError as error:
        return None, {}, type(error).__name__, (time.perf_counter() - started) * 1000


async def compare_current_method(
    client: httpx.AsyncClient,
    limiter: SteamConcurrencyLimiter,
    steam_id: str,
    games: list[dict[str, Any]],
) -> dict[int, dict[str, Any]]:
    results: dict[int, dict[str, Any]] = {}
    stop_after_rate_limit = asyncio.Event()
    queue = asyncio.Queue()
    for game in games:
        queue.put_nowait(game)

    async def worker():
        while not stop_after_rate_limit.is_set():
            try:
                game = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            app_id = int(game["appid"])
            try:
                async with limiter.slot():
                    response = await client.get(
                        f"{STEAM_API_BASE}/ISteamUserStats/GetPlayerAchievements/v1/",
                        params={
                            "key": settings.steam_api_key,
                            "steamid": steam_id,
                            "appid": app_id,
                            "l": "english",
                        },
                    )
                if response.status_code == 429:
                    stop_after_rate_limit.set()
                    results[app_id] = {
                        "status": 429,
                        "error": safe_error(response, settings.steam_api_key or ""),
                    }
                elif response.is_error:
                    results[app_id] = {
                        "status": response.status_code,
                        "error": safe_error(response, settings.steam_api_key or ""),
                    }
                else:
                    try:
                        payload = response.json()
                    except ValueError:
                        payload = {}
                    counts = achievement_counts(payload) if isinstance(payload, dict) else None
                    results[app_id] = {
                        "status": response.status_code,
                        "counts": counts,
                        "error": None if counts is not None else "playerstats.achievements missing",
                    }
            except httpx.HTTPError as error:
                results[app_id] = {"status": None, "error": type(error).__name__}
            finally:
                queue.task_done()

    await asyncio.gather(*(
        worker() for _ in range(CURRENT_CONCURRENCY)
    ))
    return results


async def run_diagnostic(
    steam_id: str,
    compare_current: bool,
    probe_top_app_id: int | None = None,
    top_limit: int = 500,
) -> int:
    if len(steam_id) != PROFILE_ID_LENGTH or not steam_id.isdigit():
        print("SteamID must be a 17-digit SteamID64.", file=sys.stderr)
        return 2
    if not settings.steam_api_key:
        print("STEAM_API_KEY is not configured.", file=sys.stderr)
        return 2

    timeout = httpx.Timeout(
        connect=settings.steam_timeout_connect,
        read=settings.steam_timeout_read,
        write=settings.steam_timeout_write,
        pool=settings.steam_timeout_pool,
    )
    limits = httpx.Limits(max_connections=4, max_keepalive_connections=2)
    limiter = SteamConcurrencyLimiter(CURRENT_CONCURRENCY)
    async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
        configure_steam_runtime(client, limiter)
        try:
            owned_response = await get_owned_games(steam_id)
        except Exception as error:
            print(f"Could not retrieve owned games: {type(error).__name__}")
            configure_steam_runtime(None, None)
            return 1

        games = parse_games(owned_response)
        app_ids = [int(game["appid"]) for game in games]
        print(f"PROFILE: SteamID {steam_id}")
        print(f"GAMES: {len(games)}")

        if probe_top_app_id is not None:
            if probe_top_app_id not in app_ids:
                print(f"AppID {probe_top_app_id} is not in this profile's owned-games response.")
                configure_steam_runtime(None, None)
                return 2
            status, payload, error, elapsed_ms = await experimental_request(
                client,
                limiter,
                "GET",
                "IPlayerService/GetTopAchievementsForGames/v1/",
                steam_id,
                [probe_top_app_id],
                max_achievements=top_limit,
            )
            top_game = parse_top_results(payload).get(probe_top_app_id, {})
            achievements = top_game.get("achievements", [])
            sample = achievements[0] if achievements else {}
            print(
                "GetTopAchievementsForGames probe: "
                f"HTTP={status or 'ERROR'} appid={probe_top_app_id} "
                f"returned={len(achievements)} "
                f"declared_total={top_game.get('total_achievements', 'n/a')} "
                f"max_achievements={top_limit} elapsed_ms={elapsed_ms:.0f}"
            )
            if sample:
                fields = sorted(sample)
                print(f"  achievement_fields={fields}")
                print(
                    "  has_apiname=%s has_achieved=%s has_unlocktime=%s"
                    % (
                        "apiname" in sample,
                        "achieved" in sample,
                        "unlocktime" in sample,
                    )
                )
            if error:
                print(f"  error: {error}")
            configure_steam_runtime(None, None)
            return 0

        top_status, top_response, top_error, top_ms = await experimental_request(
            client,
            limiter,
            "GET",
            "IPlayerService/GetTopAchievementsForGames/v1/",
            steam_id,
            app_ids,
            max_achievements=top_limit,
        )
        top_games = parse_top_results(top_response)
        top_achievements = sum(
            len(game.get("achievements", []))
            for game in top_games.values()
            if isinstance(game.get("achievements"), list)
        )
        print(
            "GetTopAchievementsForGames: "
            f"HTTP={top_status or 'ERROR'} games_returned={len(top_games)} "
            f"achievements_returned={top_achievements} elapsed_ms={top_ms:.0f}"
        )
        if top_error:
            print(f"  error: {top_error}")

        progress_status, progress_response, progress_error, progress_ms = await experimental_request(
            client,
            limiter,
            "POST",
            "IPlayerService/GetAchievementsProgress/v1/",
            steam_id,
            app_ids,
        )
        progress_games = parse_progress_results(progress_response)
        total_unlocked = sum(int(game.get("unlocked", 0) or 0) for game in progress_games.values())
        total_achievements = sum(int(game.get("total", 0) or 0) for game in progress_games.values())
        print(
            "GetAchievementsProgress: "
            f"HTTP={progress_status or 'ERROR'} games_returned={len(progress_games)} "
            f"unlocked={total_unlocked} total={total_achievements} "
            f"elapsed_ms={progress_ms:.0f}"
        )
        if progress_error:
            print(f"  error: {progress_error}")

        current_results: dict[int, dict[str, Any]] = {}
        if compare_current:
            print(
                "CURRENT GetPlayerAchievements: "
                f"starting per-game comparison at concurrency={CURRENT_CONCURRENCY}"
            )
            current_results = await compare_current_method(client, limiter, steam_id, games)
            current_counts = Counter(
                str(result.get("status") or "ERROR")
                for result in current_results.values()
            )

            matched = 0
            different = 0
            top_count_matches = 0
            top_count_differences = 0
            for game in games:
                app_id = int(game["appid"])
                current = current_results.get(app_id, {})
                progress = progress_games.get(app_id)
                top_game = top_games.get(app_id, {})
                top_entries = top_game.get("achievements", [])
                top_count = len(top_entries) if isinstance(top_entries, list) else 0
                current_pair = current.get("counts")
                if current_pair is not None and progress is not None:
                    same = (
                        current_pair[0] == int(progress.get("unlocked", 0) or 0)
                        and current_pair[1] == int(progress.get("total", 0) or 0)
                    )
                    matched += int(same)
                    different += int(not same)
                    comparison = "MATCH" if same else "DIFFERENCE"
                    current_text = f"{current_pair[0]}/{current_pair[1]}"
                    progress_text = (
                        f"{progress.get('unlocked', 0)}/{progress.get('total', 0)}"
                    )
                elif current_pair is not None:
                    same_count = current_pair[0] == top_count
                    top_count_matches += int(same_count)
                    top_count_differences += int(not same_count)
                    comparison = "TOP_COUNT_MATCH" if same_count else "TOP_COUNT_DIFF"
                    current_text = f"{current_pair[0]}/{current_pair[1]}"
                    progress_text = "UNAVAILABLE"
                elif current.get("error"):
                    comparison = f"CURRENT_HTTP{current.get('status') or 'ERROR'}"
                    current_text = current.get("error", "ERROR")[:80]
                    progress_text = (
                        f"{progress.get('unlocked', 0)}/{progress.get('total', 0)}"
                        if progress
                        else "MISSING"
                    )
                else:
                    comparison = "PROGRESS_MISSING"
                    current_text = (
                        f"{current_pair[0]}/{current_pair[1]}"
                        if current_pair
                        else "MISSING"
                    )
                    progress_text = "MISSING"
                print(
                    f"{app_id} | {game.get('name', '')} | {current_text} | "
                    f"{progress_text} | top_entries={top_count}/"
                    f"{top_game.get('total_achievements', 'n/a')} "
                    f"current_http={current.get('status', 'ERROR')} | {comparison}"
                )

            current_unlocked = sum(
                result["counts"][0]
                for result in current_results.values()
                if result.get("counts") is not None
            )
            current_total = sum(
                result["counts"][1]
                for result in current_results.values()
                if result.get("counts") is not None
            )
            print(
                "SUMMARY: "
                f"games={len(games)} current_processed={len(current_results)} "
                f"current_unlocked={current_unlocked} current_total={current_total} "
                f"progress_unlocked={total_unlocked} progress_total={total_achievements} "
                f"progress_matches={matched} progress_differences={different} "
                f"top_count_matches={top_count_matches} "
                f"top_count_differences={top_count_differences} "
                f"current_http_statuses={dict(current_counts)}"
            )

        print(
            "EXPERIMENTAL LIMITATION: One request used all owned AppIDs; "
            "this diagnoses acceptance, not a maximum batch size."
        )
        configure_steam_runtime(None, None)
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("steam_id", help="17-digit SteamID64")
    parser.add_argument(
        "--skip-current-comparison",
        action="store_true",
        help="Do not issue one current GetPlayerAchievements request per game.",
    )
    parser.add_argument(
        "--probe-top-appid",
        type=int,
        help="Probe only GetTopAchievementsForGames for one owned AppID.",
    )
    parser.add_argument(
        "--top-limit",
        type=int,
        default=500,
        help="max_achievements probe parameter (default: 500; not a proven service limit).",
    )
    args = parser.parse_args()
    return asyncio.run(
        run_diagnostic(
            args.steam_id,
            compare_current=not args.skip_current_comparison,
            probe_top_app_id=args.probe_top_appid,
            top_limit=args.top_limit,
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
