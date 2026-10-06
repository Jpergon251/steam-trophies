import os

from dotenv import load_dotenv

load_dotenv()


def _int_setting(name: str, default: int, minimum: int = 1) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer.") from error
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}.")
    return value


class Settings:
    steam_api_key = os.getenv("STEAM_API_KEY")
    steam_max_concurrency = _int_setting("STEAM_MAX_CONCURRENCY", 8)
    steam_max_retries = _int_setting("STEAM_MAX_RETRIES", 2, minimum=0)
    steam_timeout_connect = float(os.getenv("STEAM_TIMEOUT_CONNECT", "5"))
    steam_timeout_read = float(os.getenv("STEAM_TIMEOUT_READ", "20"))
    steam_timeout_write = float(os.getenv("STEAM_TIMEOUT_WRITE", "10"))
    steam_timeout_pool = float(os.getenv("STEAM_TIMEOUT_POOL", "5"))
    steam_max_connections = _int_setting("STEAM_MAX_CONNECTIONS", 16)
    steam_max_keepalive_connections = _int_setting("STEAM_MAX_KEEPALIVE_CONNECTIONS", 8)

    cache_profile_ttl = _int_setting("CACHE_PROFILE_TTL", 300)
    cache_games_ttl = _int_setting("CACHE_GAMES_TTL", 600)
    cache_achievements_ttl = _int_setting("CACHE_ACHIEVEMENTS_TTL", 2700)
    cache_global_achievements_ttl = _int_setting("CACHE_GLOBAL_ACHIEVEMENTS_TTL", 3600)
    cache_negative_ttl = _int_setting("CACHE_NEGATIVE_TTL", 30)
    cache_negative_achievements_ttl = _int_setting("CACHE_NEGATIVE_ACHIEVEMENTS_TTL", 300)
    cache_max_entries = _int_setting("CACHE_MAX_ENTRIES", 4096)
    cache_max_bytes = _int_setting("CACHE_MAX_BYTES", 67_108_864)

    rate_limit_window_seconds = _int_setting("RATE_LIMIT_WINDOW_SECONDS", 60)
    rate_limit_search = _int_setting("RATE_LIMIT_SEARCH_PER_MINUTE", 20)
    rate_limit_profile = _int_setting("RATE_LIMIT_PROFILE_PER_MINUTE", 30)
    rate_limit_games = _int_setting("RATE_LIMIT_GAMES_PER_MINUTE", 30)
    rate_limit_achievements = _int_setting("RATE_LIMIT_ACHIEVEMENTS_PER_MINUTE", 1200)


settings = Settings()
if settings.steam_max_keepalive_connections > settings.steam_max_connections:
    raise ValueError(
        "STEAM_MAX_KEEPALIVE_CONNECTIONS cannot exceed STEAM_MAX_CONNECTIONS."
    )
if min(
    settings.steam_timeout_connect,
    settings.steam_timeout_read,
    settings.steam_timeout_write,
    settings.steam_timeout_pool,
) <= 0:
    raise ValueError("Steam HTTP timeout values must be greater than zero.")
