import hashlib
import logging
import re
import time
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.config import settings
from app.metrics import RequestMetrics, current_request_metrics, masked_steam_id
from app.services.steam import (
    configure_steam_runtime,
    get_owned_games,
    get_player_achievements,
    get_achievement_summaries,
    get_steam_profile,
    search_steam_profile,
    SteamConcurrencyLimiter,
    steam_concurrency_stats,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    timeout = httpx.Timeout(
        connect=settings.steam_timeout_connect,
        read=settings.steam_timeout_read,
        write=settings.steam_timeout_write,
        pool=settings.steam_timeout_pool,
    )
    limits = httpx.Limits(
        max_connections=settings.steam_max_connections,
        max_keepalive_connections=settings.steam_max_keepalive_connections,
    )
    client = httpx.AsyncClient(timeout=timeout, limits=limits)
    configure_steam_runtime(
        client,
        SteamConcurrencyLimiter(settings.steam_max_concurrency),
    )
    try:
        yield
    finally:
        configure_steam_runtime(None, None)
        await client.aclose()


class InMemoryRateLimiter:
    def __init__(self):
        self._requests: dict[tuple[str, str], tuple[float, int]] = {}

    def check(self, client_ip: str, group: str, limit: int) -> tuple[bool, int]:
        now = time.monotonic()
        window = settings.rate_limit_window_seconds
        if len(self._requests) > 10_000:
            self._requests = {
                key: value for key, value in self._requests.items()
                if now - value[0] < window
            }

        key = (client_ip, group)
        start, count = self._requests.get(key, (now, 0))
        if now - start >= window:
            start, count = now, 0
        if count >= limit:
            return False, max(1, int(window - (now - start)))
        self._requests[key] = (start, count + 1)
        return True, 0


rate_limiter = InMemoryRateLimiter()
app = FastAPI(title="Steam Trophies API", lifespan=lifespan)
fastapi_app = app

_STEAM_ID_IN_PATH = re.compile(r"/profile/(\d{17})(/|$)")
_APP_ID_IN_PATH = re.compile(r"/games/(\d+)/achievements$")


def _request_identity(request: Request) -> tuple[str, str | None]:
    path = request.url.path
    steam_id = request.query_params.get("steam_id")
    match = _STEAM_ID_IN_PATH.search(path)
    if match:
        steam_id = match.group(1)
    return path, steam_id


def _masked_client_ip(client_ip: str) -> str:
    return hashlib.sha256(client_ip.encode()).hexdigest()[:10]


def _rate_limit_group(path: str) -> tuple[str, int] | None:
    if path == "/api/steam/search":
        return "search", settings.rate_limit_search
    if path.endswith("/achievements"):
        return "achievements", settings.rate_limit_achievements
    if path.endswith("/games"):
        return "games", settings.rate_limit_games
    if path == "/api/steam/profile":
        return "profile", settings.rate_limit_profile
    return None


@app.middleware("http")
async def observe_and_limit_requests(request: Request, call_next):
    if request.url.path == "/api/health":
        return await call_next(request)

    path, steam_id = _request_identity(request)
    group = _rate_limit_group(path)
    if group and request.method != "OPTIONS":
        client_ip = request.client.host if request.client else "unknown"
        allowed, retry_after = rate_limiter.check(client_ip, group[0], group[1])
        if not allowed:
            active, pending = steam_concurrency_stats()
            app_match = _APP_ID_IN_PATH.search(path)
            logger.warning(
                "request_rejected reason=rate_limit group=%s endpoint=%s "
                "steam_id=%s appid=%s original_status=n/a final_status=429 "
                "limit=%s window_seconds=%s client_ip_hash=%s steam_active=%s "
                "steam_pending=%s retry_after=%s",
                group[0],
                _STEAM_ID_IN_PATH.sub(r"/profile/{steam_id}\2", path),
                masked_steam_id(steam_id),
                app_match.group(1) if app_match else "n/a",
                group[1],
                settings.rate_limit_window_seconds,
                _masked_client_ip(client_ip),
                active,
                pending,
                retry_after,
            )
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests. Please try again shortly."},
                headers={
                    "Retry-After": str(retry_after),
                    "X-RateLimit-Reason": f"{group[0]}_requests_per_ip",
                },
            )

    metrics = RequestMetrics()
    token = current_request_metrics.set(metrics)
    started = time.perf_counter()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        return response
    finally:
        current_request_metrics.reset(token)
        if request.url.path.startswith("/api/steam/"):
            active, pending = steam_concurrency_stats()
            app_match = _APP_ID_IN_PATH.search(path)
            logger.info(
                "steam_request endpoint=%s steam_id=%s appid=%s original_status=%s "
                "final_status=%s reason=%s total_ms=%.1f steam_ms=%.1f "
                "steam_wait_ms=%.1f steam_requests=%s cache_hits=%s "
                "cache_misses=%s deduplicated=%s retries=%s games=%s "
                "steam_active=%s steam_pending=%s",
                _STEAM_ID_IN_PATH.sub(r"/profile/{steam_id}\2", path),
                masked_steam_id(steam_id),
                metrics.app_id or (app_match.group(1) if app_match else "n/a"),
                metrics.upstream_status or "n/a",
                status_code,
                metrics.failure_reason or "none",
                (time.perf_counter() - started) * 1000,
                metrics.steam_time_ms,
                metrics.steam_wait_ms,
                metrics.steam_requests,
                metrics.cache_hits,
                metrics.cache_misses,
                metrics.deduplicated,
                metrics.retries,
                metrics.games_count if metrics.games_count is not None else "n/a",
                active,
                pending,
            )


@app.get("/api/steam/search")
async def steam_search(q: str = Query(..., min_length=1)):
    try:
        return await search_steam_profile(q)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception as error:
        logger.warning("Steam profile search failed (%s).", type(error).__name__)
        raise HTTPException(status_code=502, detail="Steam profile search is not available right now.")

@app.get("/api/steam/profile/{steam_id}/games")
async def steam_games(steam_id: str):
    try:
        result = await get_owned_games(steam_id)
        games = result.get("response", {}).get("games", [])
        metrics = current_request_metrics.get()
        if metrics is not None:
            metrics.games_count = len(games) if isinstance(games, list) else 0
        return result
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception as error:
        logger.warning("Steam games request failed (%s).", type(error).__name__)
        raise HTTPException(status_code=502, detail="Steam games are not available right now.")

@app.get("/api/steam/profile/{steam_id}/achievements")
async def steam_achievement_summaries(
    steam_id: str,
    force_refresh: bool = False,
    batch_index: int = Query(default=0, ge=0),
):
    try:
        result = await get_achievement_summaries(
            steam_id,
            force_refresh=force_refresh,
            batch_index=batch_index,
        )
        metrics = current_request_metrics.get()
        if metrics is not None:
            metrics.games_count = len(result.get("games", []))
        return result
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception as error:
        upstream_status = (
            error.response.status_code
            if isinstance(error, httpx.HTTPStatusError)
            else None
        )
        metrics = current_request_metrics.get()
        if metrics is not None:
            metrics.upstream_status = upstream_status
            metrics.failure_reason = (
                "steam_rate_limited"
                if upstream_status == 429
                else "upstream_error" if upstream_status is not None
                else type(error).__name__
            )
        logger.warning(
            "steam_achievement_summary_failure steam_id=%s original_status=%s "
            "final_status=502 reason=%s",
            masked_steam_id(steam_id),
            upstream_status or "n/a",
            "steam_rate_limited" if upstream_status == 429 else type(error).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail="Steam achievement summaries are not available right now.",
        )

@app.get("/api/steam/profile/{steam_id}/games/{app_id}/achievements")
async def steam_achievements(
    steam_id: str,
    app_id: int,
    force_refresh: bool = False,
):
    try:
        return await get_player_achievements(
            steam_id,
            app_id,
            force_refresh=force_refresh,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception as error:
        upstream_status = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
        metrics = current_request_metrics.get()
        if metrics is not None:
            metrics.upstream_status = upstream_status
            metrics.failure_reason = (
                "steam_rate_limited"
                if upstream_status == 429
                else "upstream_error" if upstream_status is not None
                else type(error).__name__
            )
        logger.warning(
            "steam_achievement_failure steam_id=%s appid=%s original_status=%s "
            "final_status=502 reason=%s",
            masked_steam_id(steam_id),
            app_id,
            upstream_status or "n/a",
            "steam_rate_limited" if upstream_status == 429 else type(error).__name__,
        )
        raise HTTPException(status_code=502, detail="Steam achievements are not available right now.")

@app.get("/api/steam/profile")
async def steam_profile(steam_id: str = Query(..., min_length=1)):
    try:
        return await get_steam_profile(steam_id)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error))
    except Exception as error:
        logger.warning("Steam profile request failed (%s).", type(error).__name__)
        raise HTTPException(status_code=502, detail="Steam profile is not available right now.")


@app.get("/api/health")
async def health():
    return {"status": "ok"}


app = CORSMiddleware(
    app=app,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://jpergon251.github.io",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)