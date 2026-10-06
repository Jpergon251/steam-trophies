from contextvars import ContextVar
from dataclasses import dataclass


@dataclass
class RequestMetrics:
    cache_hits: int = 0
    cache_misses: int = 0
    deduplicated: int = 0
    steam_requests: int = 0
    retries: int = 0
    steam_wait_ms: float = 0
    steam_time_ms: float = 0
    games_count: int | None = None
    app_id: int | str | None = None
    upstream_status: int | None = None
    failure_reason: str | None = None


current_request_metrics: ContextVar[RequestMetrics | None] = ContextVar(
    "current_request_metrics",
    default=None,
)


def masked_steam_id(value: str | None) -> str:
    if not value:
        return "n/a"
    return f"…{value[-4:]}" if len(value) > 4 else "…"
