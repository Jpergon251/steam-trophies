import asyncio
import json
import logging
import random
import re
import time
from contextlib import asynccontextmanager
from urllib.parse import urlparse

import httpx
from app.cache import steam_cache
from app.config import settings
from app.metrics import current_request_metrics

logger = logging.getLogger(__name__)

STEAM_API_BASE = "https://api.steampowered.com"
STEAM_ID64_PATTERN = re.compile(r"^\d{17}$")
_http_client: httpx.AsyncClient | None = None


class SteamConcurrencyLimiter:
    def __init__(self, limit: int):
        self._semaphore = asyncio.Semaphore(limit)
        self._active = 0
        self._pending = 0

    @asynccontextmanager
    async def slot(self):
        self._pending += 1
        try:
            await self._semaphore.acquire()
        finally:
            self._pending -= 1

        self._active += 1
        try:
            yield
        finally:
            self._active -= 1
            self._semaphore.release()

    def stats(self) -> tuple[int, int]:
        return self._active, self._pending


_steam_semaphore: SteamConcurrencyLimiter | None = None


def configure_steam_runtime(
    client: httpx.AsyncClient | None,
    semaphore: SteamConcurrencyLimiter | None,
) -> None:
    global _http_client, _steam_semaphore
    _http_client = client
    _steam_semaphore = semaphore


def steam_concurrency_stats() -> tuple[int, int]:
    return _steam_semaphore.stats() if _steam_semaphore else (0, 0)


def _cache_ttl(endpoint: str) -> int:
    if "GetPlayerSummaries" in endpoint or "ResolveVanityURL" in endpoint:
        return settings.cache_profile_ttl
    if "GetOwnedGames" in endpoint:
        return settings.cache_games_ttl
    if "GetPlayerAchievements" in endpoint:
        return settings.cache_achievements_ttl
    if "GetGlobalAchievementPercentages" in endpoint:
        return settings.cache_global_achievements_ttl
    return settings.cache_negative_ttl


async def steam_request(endpoint: str, params: dict, *, force_refresh: bool = False):
    if not settings.steam_api_key:
        raise RuntimeError("STEAM_API_KEY is not configured")
    if _http_client is None or _steam_semaphore is None:
        raise RuntimeError("Steam HTTP client is not initialized.")

    cache_key = f"steam:{endpoint}:{json.dumps(params, sort_keys=True, separators=(',', ':'))}"

    async def load_response():
        request_metrics = current_request_metrics.get()
        if request_metrics is not None:
            request_metrics.app_id = params.get("appid", params.get("gameid"))

        for attempt in range(settings.steam_max_retries + 1):
            metrics = current_request_metrics.get()
            wait_started = time.perf_counter()
            try:
                async with _steam_semaphore.slot():
                    if metrics is not None:
                        metrics.steam_wait_ms += (time.perf_counter() - wait_started) * 1000
                        metrics.steam_requests += 1
                    request_started = time.perf_counter()
                    try:
                        response = await _http_client.get(
                            f"{STEAM_API_BASE}/{endpoint}",
                            params={**params, "key": settings.steam_api_key},
                        )
                    finally:
                        if metrics is not None:
                            metrics.steam_time_ms += (
                                time.perf_counter() - request_started
                            ) * 1000
                    response.raise_for_status()
                    return response.json()
            except httpx.HTTPStatusError as error:
                if metrics is not None:
                    metrics.upstream_status = error.response.status_code
                retryable = error.response.status_code in {429, 500, 502, 503, 504}
                if not retryable or attempt >= settings.steam_max_retries:
                    if metrics is not None:
                        metrics.failure_reason = (
                            "steam_rate_limited"
                            if error.response.status_code == 429
                            else "steam_upstream_error"
                        )
                    raise
                if metrics is not None and error.response.status_code == 429:
                    metrics.failure_reason = "steam_429_retrying"
            except (httpx.TimeoutException, httpx.NetworkError):
                if attempt >= settings.steam_max_retries:
                    raise

            if metrics is not None:
                metrics.retries += 1
            await asyncio.sleep(random.uniform(0.5 * (2 ** attempt), 1.0 * (2 ** attempt)))

        raise RuntimeError("Steam retry loop ended unexpectedly.")

    return await steam_cache.get_or_create(
        cache_key,
        _cache_ttl(endpoint),
        load_response,
        negative_ttl=settings.cache_negative_ttl,
        force_refresh=force_refresh,
    )


async def get_player_summary(steam_id: str):
    return await steam_request(
        "ISteamUser/GetPlayerSummaries/v2/",
        {
            "steamids": steam_id,
        },
    )

async def get_steam_profile(steam_id: str):
    if not STEAM_ID64_PATTERN.fullmatch(steam_id):
        raise ValueError("A valid SteamID64 is required.")

    data = await get_player_summary(steam_id)
    players = data.get("response", {}).get("players", [])

    if not players:
        raise LookupError("Steam profile could not be found.")

    return data
async def get_owned_games(steam_id: str):
    if not STEAM_ID64_PATTERN.fullmatch(steam_id):
        raise ValueError("A valid SteamID64 is required.")

    return await steam_request(
        "IPlayerService/GetOwnedGames/v1/",
        {
            "steamid": steam_id,
            "include_appinfo": 1,
            "include_played_free_games": 1,
            "format": "json",
        },
    )

async def get_player_achievements(
    steam_id: str,
    app_id: int,
    *,
    force_refresh: bool = False,
):
    if not STEAM_ID64_PATTERN.fullmatch(steam_id):
        raise ValueError("A valid SteamID64 is required.")
    if app_id <= 0:
        raise ValueError("A valid app ID is required.")

    async def load_achievements():
        return await _load_player_achievements(
            steam_id,
            app_id,
            force_refresh=force_refresh,
        )

    result = await steam_cache.get_or_create(
        f"achievements:{steam_id}:{app_id}",
        settings.cache_achievements_ttl,
        load_achievements,
        negative_ttl=settings.cache_negative_achievements_ttl,
        is_negative=lambda value: (
            value.get("available") is False
            or value.get("_short_cache") is True
        ),
        force_refresh=force_refresh,
    )
    result.pop("_short_cache", None)
    return result


async def _load_player_achievements(
    steam_id: str,
    app_id: int,
    *,
    force_refresh: bool = False,
):
    try:
        achievements_data = await steam_request(
            "ISteamUserStats/GetPlayerAchievements/v1/",
            {"steamid": steam_id, "appid": app_id, "l": "english"},
            force_refresh=force_refresh,
        )
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 400:
            try:
                error_data = error.response.json()
            except ValueError:
                raise error

            player_response = error_data.get("playerstats") if isinstance(error_data, dict) else None
            if isinstance(player_response, dict):
                error_message = player_response.get("error")
                if (
                    player_response.get("success") is False
                    and isinstance(error_message, str)
                    and error_message.casefold() == "requested app has no stats"
                ):
                    return {
                        "game": {"appid": app_id},
                        "achievements": [],
                        "achievement_count": 0,
                        "available": False,
                        "reason": "no_stats",
                    }
        raise

    global_percentages_available = True
    try:
        global_data = await steam_request(
            "ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/",
            {"gameid": app_id},
        )
    except (httpx.HTTPError, ValueError) as error:
        global_percentages_available = False
        logger.debug(
            "Steam global achievement percentages unavailable for app %s (%s).",
            app_id,
            type(error).__name__,
        )
        global_data = {}

    global_achievements = {
        item.get("name"): item.get("percent")
        for item in global_data.get("achievementpercentages", {}).get("achievements", [])
        if item.get("name") and item.get("percent") is not None
    }
    player_response = achievements_data.get("playerstats", {})
    if not player_response.get("success"):
        return {"game": {"appid": app_id}, "achievements": [], "achievement_count": 0, "available": False, "reason": "unavailable"}
    achievements = player_response.get("achievements", [])
    for achievement in achievements:
        achievement["global_percent"] = global_achievements.get(achievement.get("apiname"))

    return {
        "game": {
            "appid": app_id,
            "name": player_response.get("gameName"),
        },
        "achievements": achievements,
        "achievement_count": len(achievements),
        "available": bool(player_response.get("success")),
        "_short_cache": not global_percentages_available,
    }


async def resolve_vanity_url(vanity_url: str):
    data = await steam_request(
        "ISteamUser/ResolveVanityURL/v1/",
        {
            "vanityurl": vanity_url,
        },
    )

    response = data.get("response", {})

    if response.get("success") != 1:
        raise ValueError("Steam profile could not be found.")

    return response["steamid"]


def extract_search_value(query: str):
    query = query.strip()

    # SteamID64
    if STEAM_ID64_PATTERN.fullmatch(query):
        return "steamid", query

    # URL completa
    if query.startswith(("http://", "https://")):
        parsed = urlparse(query)

        if parsed.hostname not in {
            "steamcommunity.com",
            "www.steamcommunity.com",
        }:
            raise ValueError("Invalid Steam profile URL.")

        parts = [part for part in parsed.path.split("/") if part]

        if len(parts) >= 2 and parts[0] == "id":
            return "vanity", parts[1]

        raise ValueError("Unsupported Steam profile URL.")

    # Vanity URL / nombre introducido
    return "vanity", query


async def search_steam_profile(query: str):
    search_type, value = extract_search_value(query)

    if search_type == "steamid":
        steam_id = value
    else:
        steam_id = await resolve_vanity_url(value)

    return await get_player_summary(steam_id)