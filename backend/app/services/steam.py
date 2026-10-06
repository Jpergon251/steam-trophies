import asyncio
import json
import logging
import math
import random
import re
import time
from contextlib import asynccontextmanager
from typing import Any, Callable
from urllib.parse import quote, urlparse
from urllib.parse import urlparse

import httpx
from app.cache import steam_cache
from app.config import settings
from app.metrics import current_request_metrics

logger = logging.getLogger(__name__)

STEAM_API_BASE = "https://api.steampowered.com"
STEAM_ID64_PATTERN = re.compile(r"^\d{17}$")
MAX_LEGACY_FALLBACKS_PER_BATCH = 10
MAX_TOP_ACHIEVEMENTS_BATCH_SIZE = 350
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
    if (
        "GetPlayerAchievements" in endpoint
        or "GetTopAchievementsForGames" in endpoint
        or "GetSchemaForGame" in endpoint
    ):
        return settings.cache_achievements_ttl
    if "GetGlobalAchievementPercentages" in endpoint:
        return settings.cache_global_achievements_ttl
    return settings.cache_negative_ttl


async def steam_request(
    endpoint: str,
    params: dict,
    *,
    force_refresh: bool = False,
    response_transform: Callable[[Any], Any] | None = None,
):
    if not settings.steam_api_key:
        raise RuntimeError("STEAM_API_KEY is not configured")
    if _http_client is None or _steam_semaphore is None:
        raise RuntimeError("Steam HTTP client is not initialized.")

    cache_key = f"steam:{endpoint}:{json.dumps(params, sort_keys=True, separators=(',', ':'))}"
    if response_transform is not None:
        cache_key = f"{cache_key}:transformed-v1"

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
                    data = response.json()
                    return response_transform(data) if response_transform else data
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


async def _request_top_achievement_chunk(
    steam_id: str,
    app_ids: list[int],
    *,
    force_refresh: bool,
):
    params = {
        "steamid": steam_id,
        "language": "english",
        "max_achievements": settings.top_achievements_max,
        **{f"appids[{index}]": app_id for index, app_id in enumerate(app_ids)},
    }
    try:
        return await steam_request(
            "IPlayerService/GetTopAchievementsForGames/v1/",
            params,
            force_refresh=force_refresh,
            response_transform=_compact_top_achievement_response,
        )
    except httpx.HTTPStatusError as error:
        if error.response.status_code != 414 or len(app_ids) <= 1:
            raise

        midpoint = len(app_ids) // 2
        logger.warning(
            "Steam rejected Top achievements URL with 414; splitting AppID chunk "
            "from %s to %s and %s IDs.",
            len(app_ids),
            midpoint,
            len(app_ids) - midpoint,
        )
        first = await _request_top_achievement_chunk(
            steam_id,
            app_ids[:midpoint],
            force_refresh=force_refresh,
        )
        second = await _request_top_achievement_chunk(
            steam_id,
            app_ids[midpoint:],
            force_refresh=force_refresh,
        )
        first_games = first.get("response", {}).get("games")
        second_games = second.get("response", {}).get("games")
        if not isinstance(first_games, list) or not isinstance(second_games, list):
            raise ValueError("Steam returned an invalid split Top achievements response.")
        return {"response": {"games": first_games + second_games}}


async def get_achievement_summaries(
    steam_id: str,
    *,
    force_refresh: bool = False,
    batch_index: int | None = None,
):
    if not STEAM_ID64_PATTERN.fullmatch(steam_id):
        raise ValueError("A valid SteamID64 is required.")

    owned_games = await get_owned_games(steam_id)
    games = owned_games.get("response", {}).get("games", [])
    if not isinstance(games, list):
        raise ValueError("Steam returned an invalid owned-games collection.")

    games_by_id = {
        int(game["appid"]): game
        for game in games
        if isinstance(game, dict) and str(game.get("appid", "")).isdigit()
    }
    app_ids = sorted(games_by_id)
    if not app_ids:
        result = {
            "steamid": steam_id,
            "games": [],
            "trophies": [],
            "errors": {},
        }
        if batch_index is not None:
            result.update(
                batch_index=batch_index,
                batch_count=0,
                batch_size=min(
                    settings.top_achievements_batch_size,
                    MAX_TOP_ACHIEVEMENTS_BATCH_SIZE,
                ),
            )
        return result

    summaries: dict[int, dict] = {}
    trophies: list[dict] = []
    errors: dict[int, dict] = {}
    batch_size = min(
        settings.top_achievements_batch_size,
        MAX_TOP_ACHIEVEMENTS_BATCH_SIZE,
    )
    batch_count = (len(app_ids) + batch_size - 1) // batch_size
    if batch_index is not None and batch_index >= batch_count:
        raise ValueError("Achievement summary batch is out of range.")
    batch_indices = (
        range(batch_count)
        if batch_index is None
        else (batch_index,)
    )
    for current_batch_index in batch_indices:
        offset = current_batch_index * batch_size
        batch = app_ids[offset:offset + batch_size]
        try:
            response = await _request_top_achievement_chunk(
                steam_id,
                batch,
                force_refresh=force_refresh,
            )
        except Exception as error:
            status = (
                error.response.status_code
                if isinstance(error, httpx.HTTPStatusError)
                else None
            )
            logger.warning(
                "Steam achievement summary batch failed batch=%s appids=%s "
                "status=%s reason=%s",
                current_batch_index,
                batch,
                status or "n/a",
                type(error).__name__,
            )
            if len(batch) <= MAX_LEGACY_FALLBACKS_PER_BATCH:
                fallback_summaries, fallback_errors = await _legacy_summaries_for_batch(
                    steam_id,
                    batch,
                    games_by_id,
                )
                for app_id, fallback in fallback_summaries.items():
                    summary, game_trophies = _legacy_achievement_summary_payload(
                        app_id,
                        fallback,
                    )
                    summaries[app_id] = summary
                    trophies.extend(game_trophies)
                errors.update(fallback_errors)
                continue
            for app_id in batch:
                errors[app_id] = {
                    "status": status,
                    "reason": "top_request_failed",
                }
            continue

        response_data = response.get("response")
        top_games = response_data.get("games") if isinstance(response_data, dict) else None
        if not isinstance(top_games, list):
            logger.warning(
                "Steam achievement summary returned an unexpected shape for %s AppIDs.",
                len(batch),
            )
            if len(batch) <= MAX_LEGACY_FALLBACKS_PER_BATCH:
                fallback_summaries, fallback_errors = await _legacy_summaries_for_batch(
                    steam_id,
                    batch,
                    games_by_id,
                )
                for app_id, fallback in fallback_summaries.items():
                    summary, game_trophies = _legacy_achievement_summary_payload(
                        app_id,
                        fallback,
                    )
                    summaries[app_id] = summary
                    trophies.extend(game_trophies)
                errors.update(fallback_errors)
                continue
            for app_id in batch:
                errors[app_id] = {"status": None, "reason": "invalid_top_response"}
            continue

        top_by_id = {
            int(game["appid"]): game
            for game in top_games
            if isinstance(game, dict) and str(game.get("appid", "")).isdigit()
        }
        if not top_by_id:
            if len(batch) <= MAX_LEGACY_FALLBACKS_PER_BATCH:
                fallback_summaries, fallback_errors = await _legacy_summaries_for_batch(
                    steam_id,
                    batch,
                    games_by_id,
                )
                for app_id, fallback in fallback_summaries.items():
                    summary, game_trophies = _legacy_achievement_summary_payload(
                        app_id,
                        fallback,
                    )
                    summaries[app_id] = summary
                    trophies.extend(game_trophies)
                errors.update(fallback_errors)
            else:
                for app_id in batch:
                    errors[app_id] = {"status": None, "reason": "empty_top_batch"}
            continue

        needs_fallback = []
        for app_id in batch:
            top_game = top_by_id.get(app_id)
            normalized = _normalize_top_summary(
                app_id,
                top_game,
            )
            if normalized is None:
                needs_fallback.append(app_id)
            else:
                summary, game_trophies = normalized
                summaries[app_id] = summary
                trophies.extend(game_trophies)

        # Do not turn an incomplete batch into hundreds of legacy requests.
        # A small number of individually missing/truncated entries is safe to
        # repair; larger gaps are reported for detail-on-demand instead.
        if len(needs_fallback) > MAX_LEGACY_FALLBACKS_PER_BATCH:
            logger.warning(
                "Steam top summary omitted %s games in a batch; skipping bulk fallback.",
                len(needs_fallback),
            )
            for app_id in needs_fallback:
                errors[app_id] = {
                    "status": None,
                    "reason": "fallback_limit_reached",
                }
            needs_fallback = []
        fallback_summaries, fallback_errors = await _legacy_summaries_for_batch(
            steam_id,
            needs_fallback,
            games_by_id,
        )
        for app_id, fallback in fallback_summaries.items():
            summary, game_trophies = _legacy_achievement_summary_payload(
                app_id,
                fallback,
            )
            summaries[app_id] = summary
            trophies.extend(game_trophies)
        errors.update(fallback_errors)

    result = {
        "steamid": steam_id,
        "games": [
            summaries[app_id]
            for app_id in app_ids
            if app_id in summaries
        ],
        "trophies": trophies,
        "errors": {str(app_id): error for app_id, error in errors.items()},
    }
    if batch_index is not None:
        result.update(
            batch_index=batch_index,
            batch_count=batch_count,
            batch_size=batch_size,
        )
    return result


def _normalize_top_summary(app_id: int, top_game: dict | None):
    if not isinstance(top_game, dict):
        return None
    total = top_game.get("total_achievements")
    achievements = top_game.get("achievements")
    if (
        not isinstance(total, int)
        or isinstance(total, bool)
        or total < 0
    ):
        return None

    tier_counts = {"bronze": 0, "silver": 0, "gold": 0}
    trophy_columns = {
        tier: {
            "names": [],
            "descriptions": [],
            "icons": [],
            "gray_icons": [],
            "percentages": [],
        }
        for tier in tier_counts
    }
    compact_columns = top_game.get("achievement_columns")
    if compact_columns is not None:
        if not isinstance(compact_columns, dict):
            return None
        for tier, columns in compact_columns.items():
            if tier not in tier_counts or not isinstance(columns, dict):
                return None
            fields = ("names", "descriptions", "icons", "gray_icons", "percentages")
            if not all(isinstance(columns.get(field), list) for field in fields):
                return None
            column_count = len(columns["names"])
            if not all(len(columns[field]) == column_count for field in fields):
                return None
            if column_count:
                trophy_columns[tier] = columns
                tier_counts[tier] = column_count
    else:
        if not isinstance(achievements, list):
            return None
        if len(achievements) > total or len(achievements) >= settings.top_achievements_max:
            return None
        for item in achievements:
            if not isinstance(item, dict):
                return None
            percent = item.get("player_percent_unlocked")
            try:
                percent = float(percent) if percent is not None else None
            except (TypeError, ValueError):
                percent = None
            if percent is not None and not math.isfinite(percent):
                percent = None
            tier = _achievement_tier(percent)
            tier_counts[tier] += 1
            columns = trophy_columns[tier]
            columns["names"].append(str(item.get("name") or ""))
            columns["descriptions"].append(str(item.get("desc") or ""))
            columns["icons"].append(_top_achievement_icon_url(app_id, item.get("icon")))
            columns["gray_icons"].append(_top_achievement_icon_url(app_id, item.get("icon_gray")))
            columns["percentages"].append(percent)

    unlocked_count = sum(tier_counts.values())
    if unlocked_count > total or unlocked_count >= settings.top_achievements_max:
        return None
    summary = {
        "appid": app_id,
        "achievement_count": total,
        "unlocked_count": unlocked_count,
        "tier_counts": tier_counts,
        "available": True,
    }
    groups = [
        {
            "appid": app_id,
            "tier": tier,
            "columns": columns,
        }
        for tier, columns in trophy_columns.items()
        if columns["names"]
    ]
    return summary, groups


def _compact_top_achievement_response(data: Any):
    response = data.get("response") if isinstance(data, dict) else None
    top_games = response.get("games") if isinstance(response, dict) else None
    if not isinstance(top_games, list):
        return data

    compact_games = []
    for top_game in top_games:
        if not isinstance(top_game, dict) or not str(top_game.get("appid", "")).isdigit():
            continue
        app_id = int(top_game["appid"])
        achievements = top_game.get("achievements")
        compact_game = {
            "appid": app_id,
            "total_achievements": top_game.get("total_achievements"),
        }
        if (
            not isinstance(achievements, list)
            or len(achievements) >= settings.top_achievements_max
        ):
            compact_game["summary_invalid"] = True
            compact_games.append(compact_game)
            continue

        columns_by_tier = {
            tier: {
                "names": [],
                "descriptions": [],
                "icons": [],
                "gray_icons": [],
                "percentages": [],
            }
            for tier in ("bronze", "silver", "gold")
        }
        invalid = False
        for item in achievements:
            if not isinstance(item, dict):
                invalid = True
                break
            percent = item.get("player_percent_unlocked")
            try:
                percent = float(percent) if percent is not None else None
            except (TypeError, ValueError):
                percent = None
            if percent is not None and not math.isfinite(percent):
                percent = None
            columns = columns_by_tier[_achievement_tier(percent)]
            columns["names"].append(str(item.get("name") or ""))
            columns["descriptions"].append(str(item.get("desc") or ""))
            columns["icons"].append(_top_achievement_icon_url(app_id, item.get("icon")))
            columns["gray_icons"].append(_top_achievement_icon_url(app_id, item.get("icon_gray")))
            columns["percentages"].append(percent)
        if invalid:
            compact_game["summary_invalid"] = True
        else:
            compact_game["achievement_columns"] = columns_by_tier
        compact_games.append(compact_game)

    return {"response": {"games": compact_games}}


def _achievement_tier(percent: float | None) -> str:
    if percent is not None and percent <= 15:
        return "gold"
    if percent is not None and percent <= 40:
        return "silver"
    return "bronze"


def _legacy_achievement_summary_payload(
    app_id: int,
    result: dict,
):
    achievements = result.get("achievements", [])
    tier_counts = {"bronze": 0, "silver": 0, "gold": 0}
    trophy_columns = {
        tier: {
            "names": [],
            "descriptions": [],
            "icons": [],
            "gray_icons": [],
            "percentages": [],
        }
        for tier in tier_counts
    }
    for achievement in achievements:
        if not isinstance(achievement, dict) or not (
            achievement.get("achieved") is True
            or str(achievement.get("achieved", "")) == "1"
        ):
            continue
        percent = achievement.get("global_percent")
        try:
            percent = float(percent) if percent is not None else None
        except (TypeError, ValueError):
            percent = None
        if percent is not None and not math.isfinite(percent):
            percent = None
        tier = _achievement_tier(percent)
        tier_counts[tier] += 1
        columns = trophy_columns[tier]
        columns["names"].append(
            str(achievement.get("name") or achievement.get("apiname") or ""),
        )
        columns["descriptions"].append(str(achievement.get("description") or ""))
        columns["icons"].append(achievement.get("icon") or "")
        columns["gray_icons"].append(achievement.get("icongray") or "")
        columns["percentages"].append(percent)
    return {
        "appid": app_id,
        "achievement_count": result.get("achievement_count", len(achievements)),
        "unlocked_count": sum(tier_counts.values()),
        "tier_counts": tier_counts,
        "available": result.get("available", False),
    }, [
        {
            "appid": app_id,
            "tier": tier,
            "columns": columns,
        }
        for tier, columns in trophy_columns.items()
        if columns["names"]
    ]


def _top_achievement_icon_url(app_id: int, icon: object) -> str:
    if not isinstance(icon, str) or not icon.strip():
        return ""
    icon = icon.strip()
    parsed = urlparse(icon)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return icon
    filename = quote(icon.lstrip("/"), safe="/")
    if not filename.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
        filename = f"{filename}.jpg"
    return (
        "https://media.steampowered.com/steamcommunity/public/images/apps/"
        f"{app_id}/{filename}"
    )


async def _legacy_summaries_for_batch(
    steam_id: str,
    app_ids: list[int],
    games_by_id: dict[int, dict],
):
    summaries = {}
    errors = {}
    for app_id in app_ids:
        try:
            summaries[app_id] = await get_player_achievements(steam_id, app_id)
        except Exception as error:
            status = (
                error.response.status_code
                if isinstance(error, httpx.HTTPStatusError)
                else None
            )
            logger.warning(
                "Steam legacy achievement summary fallback failed appid=%s "
                "game=%s status=%s reason=%s",
                app_id,
                games_by_id[app_id].get("name", ""),
                status or "n/a",
                type(error).__name__,
            )
            errors[app_id] = {
                "status": status,
                "reason": "legacy_fallback_failed",
            }
    return summaries, errors


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

    global_data, schema_data = await asyncio.gather(
        steam_request(
            "ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/",
            {"gameid": app_id},
        ),
        steam_request(
            "ISteamUserStats/GetSchemaForGame/v2/",
            {"appid": app_id, "l": "english"},
        ),
        return_exceptions=True,
    )
    global_percentages_available = not isinstance(global_data, BaseException)
    if not global_percentages_available:
        logger.debug(
            "Steam global achievement percentages unavailable for app %s (%s).",
            app_id,
            type(global_data).__name__,
        )
        global_data = {}

    schema_game = (
        schema_data.get("game")
        if isinstance(schema_data, dict)
        else None
    )
    schema_stats = (
        schema_game.get("availableGameStats")
        if isinstance(schema_game, dict)
        else None
    )
    schema_achievements = (
        schema_stats.get("achievements")
        if isinstance(schema_stats, dict)
        else None
    )
    icons_complete = isinstance(schema_achievements, list)
    if not icons_complete:
        schema_status = (
            schema_data.response.status_code
            if isinstance(schema_data, httpx.HTTPStatusError)
            else "n/a"
        )
        logger.warning(
            "Steam achievement icon schema unavailable appid=%s status=%s reason=%s",
            app_id,
            schema_status,
            type(schema_data).__name__,
        )
        schema_achievements = []

    schema_by_name = {
        item.get("name"): item
        for item in schema_achievements
        if isinstance(item, dict) and item.get("name")
    }

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
        schema_item = schema_by_name.get(achievement.get("apiname"))
        if schema_item:
            achievement["name"] = achievement.get("name") or schema_item.get("displayName")
            achievement["description"] = achievement.get("description") or schema_item.get("description")
            achievement["icon"] = achievement.get("icon") or schema_item.get("icon")
            achievement["icongray"] = achievement.get("icongray") or schema_item.get("icongray")
            achievement["hidden"] = schema_item.get("hidden")

    return {
        "game": {
            "appid": app_id,
            "name": player_response.get("gameName"),
        },
        "achievements": achievements,
        "achievement_count": len(achievements),
        "available": bool(player_response.get("success")),
        "icons_complete": icons_complete,
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