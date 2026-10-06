import asyncio
import copy
import json
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx

from app.config import settings
from app.metrics import current_request_metrics


@dataclass
class _CacheEntry:
    value: Any
    expires_at: float
    size_bytes: int


@dataclass(frozen=True)
class _NegativeHttpStatus:
    status_code: int


class AsyncTTLCache:
    def __init__(self, max_entries: int, max_bytes: int = settings.cache_max_bytes):
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self._size_bytes = 0
        self._entries: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._in_flight: dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()
        self._stats = {
            "hits": 0,
            "misses": 0,
            "deduplicated": 0,
            "evictions": 0,
        }

    def _record_request_metric(self, name: str) -> None:
        metrics = current_request_metrics.get()
        if metrics is not None:
            if name == "deduplicated":
                metrics.deduplicated += 1
            elif name == "hits":
                metrics.cache_hits += 1
            elif name == "misses":
                metrics.cache_misses += 1

    def _get_entry_locked(self, key: str) -> Any:
        entry = self._entries.get(key)
        if entry is None:
            return _MISSING
        if entry.expires_at <= time.monotonic():
            self._remove_locked(key)
            return _MISSING

        self._entries.move_to_end(key)
        return entry.value

    async def get(self, key: str) -> Any | None:
        async with self._lock:
            value = self._get_entry_locked(key)
            if value is _MISSING:
                self._stats["misses"] += 1
                self._record_request_metric("misses")
                return None
            self._stats["hits"] += 1
            self._record_request_metric("hits")
            if isinstance(value, _NegativeHttpStatus):
                raise self._make_http_error(value.status_code)
            return copy.deepcopy(value)

    async def set(self, key: str, value: Any, ttl: int) -> None:
        if ttl <= 0:
            await self.delete(key)
            return
        cached_value = copy.deepcopy(value)
        try:
            size_bytes = len(json.dumps(
                cached_value,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode("utf-8"))
        except (TypeError, ValueError):
            size_bytes = 128

        async with self._lock:
            now = time.monotonic()
            expired = [
                entry_key
                for entry_key, entry in self._entries.items()
                if entry.expires_at <= now
            ]
            for entry_key in expired:
                self._remove_locked(entry_key)
            previous = self._entries.pop(key, None)
            if previous:
                self._size_bytes -= previous.size_bytes
            if size_bytes > self.max_bytes:
                return
            self._entries[key] = _CacheEntry(cached_value, now + ttl, size_bytes)
            self._size_bytes += size_bytes
            self._entries.move_to_end(key)
            while (
                len(self._entries) > self.max_entries
                or self._size_bytes > self.max_bytes
            ):
                oldest_key = next(iter(self._entries))
                self._remove_locked(oldest_key)
                self._stats["evictions"] += 1

    def _remove_locked(self, key: str) -> None:
        entry = self._entries.pop(key, None)
        if entry:
            self._size_bytes -= entry.size_bytes

    async def delete(self, key: str) -> None:
        async with self._lock:
            self._remove_locked(key)

    async def clear(self) -> None:
        async with self._lock:
            self._entries.clear()
            self._size_bytes = 0
            for key in self._stats:
                self._stats[key] = 0

    async def get_or_create(
        self,
        key: str,
        ttl: int,
        loader: Callable[[], Awaitable[Any]],
        *,
        negative_ttl: int = 0,
        is_negative: Callable[[Any], bool] | None = None,
        force_refresh: bool = False,
    ) -> Any:
        cached_result = _MISSING
        task = None
        async with self._lock:
            cached = _MISSING if force_refresh else self._get_entry_locked(key)
            if cached is not _MISSING:
                self._stats["hits"] += 1
                self._record_request_metric("hits")
                cached_result = cached
            else:
                task = self._in_flight.get(key)
                if task is not None:
                    self._stats["deduplicated"] += 1
                    self._record_request_metric("deduplicated")
                else:
                    self._stats["misses"] += 1
                    self._record_request_metric("misses")
                    task = asyncio.create_task(
                        self._load_and_store(
                            key,
                            ttl,
                            loader,
                            negative_ttl,
                            is_negative,
                        )
                    )
                    self._in_flight[key] = task

        if cached_result is not _MISSING:
            if isinstance(cached_result, _NegativeHttpStatus):
                raise self._make_http_error(cached_result.status_code)
            return copy.deepcopy(cached_result)

        return copy.deepcopy(await asyncio.shield(task))

    async def _load_and_store(
        self,
        key: str,
        ttl: int,
        loader: Callable[[], Awaitable[Any]],
        negative_ttl: int,
        is_negative: Callable[[Any], bool] | None,
    ) -> Any:
        try:
            result = await loader()
            result_ttl = (
                negative_ttl
                if negative_ttl and is_negative and is_negative(result)
                else ttl
            )
            if result_ttl > 0:
                await self.set(key, result, result_ttl)
            return result
        except httpx.HTTPStatusError as error:
            if negative_ttl and error.response.status_code in {400, 403, 404}:
                await self.set(
                    key,
                    _NegativeHttpStatus(error.response.status_code),
                    negative_ttl,
                )
            raise
        finally:
            async with self._lock:
                self._in_flight.pop(key, None)

    @staticmethod
    def _make_http_error(status_code: int) -> httpx.HTTPStatusError:
        request = httpx.Request("GET", "https://api.steampowered.com/")
        response = httpx.Response(status_code, request=request)
        return httpx.HTTPStatusError(
            f"Steam returned HTTP {status_code}.",
            request=request,
            response=response,
        )

    async def stats(self) -> dict[str, int]:
        async with self._lock:
            now = time.monotonic()
            expired = [
                key for key, entry in self._entries.items()
                if entry.expires_at <= now
            ]
            for key in expired:
                self._remove_locked(key)
            return {
                **self._stats,
                "entries": len(self._entries),
                "size_bytes": self._size_bytes,
                "in_flight": len(self._in_flight),
                "max_entries": self.max_entries,
                "max_bytes": self.max_bytes,
            }


_MISSING = object()
steam_cache = AsyncTTLCache(settings.cache_max_entries)
