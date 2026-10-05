import asyncio
import os
import re
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv

load_dotenv()

STEAM_API_KEY = os.getenv("STEAM_API_KEY")
STEAM_API_BASE = "https://api.steampowered.com"

STEAM_ID64_PATTERN = re.compile(r"^\d{17}$")


async def steam_request(endpoint: str, params: dict):
    if not STEAM_API_KEY:
        raise RuntimeError("STEAM_API_KEY is not configured")

    params["key"] = STEAM_API_KEY

    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{STEAM_API_BASE}/{endpoint}",
            params=params,
        )

    response.raise_for_status()

    return response.json()


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

async def get_player_achievements(steam_id: str, app_id: int):
    if not STEAM_ID64_PATTERN.fullmatch(steam_id):
        raise ValueError("A valid SteamID64 is required.")
    if app_id <= 0:
        raise ValueError("A valid app ID is required.")

    try:
        achievements_data = await steam_request(
            "ISteamUserStats/GetPlayerAchievements/v1/",
            {"steamid": steam_id, "appid": app_id, "l": "english"},
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

    try:
        global_data = await steam_request(
            "ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/",
            {"gameid": app_id},
        )
    except Exception:
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