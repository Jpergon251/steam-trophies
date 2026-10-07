import asyncio
import time
import unittest
from unittest.mock import patch

from app.cache import AsyncTTLCache


class AsyncTTLCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.cache = AsyncTTLCache(max_entries=2)

    async def test_cache_hit_miss_and_basic_operations(self):
        first_loader = unittest.mock.AsyncMock(return_value={"value": 1})
        result = await self.cache.get_or_create("one", 30, first_loader)
        cached = await self.cache.get_or_create(
            "one",
            30,
            unittest.mock.AsyncMock(return_value={"value": 2}),
        )

        self.assertEqual(result, {"value": 1})
        self.assertEqual(cached, {"value": 1})
        first_loader.assert_awaited_once()
        self.assertEqual((await self.cache.stats())["hits"], 1)
        await self.cache.delete("one")
        self.assertIsNone(await self.cache.get("one"))

        await self.cache.set("two", 2, 30)
        await self.cache.clear()
        self.assertEqual((await self.cache.stats())["entries"], 0)

    async def test_expired_entry_is_not_returned(self):
        await self.cache.set("expires", "old", 1)
        future = time.monotonic() + 2
        with patch("app.cache.time.monotonic", return_value=future):
            self.assertIsNone(await self.cache.get("expires"))

    async def test_lru_limit_evicts_least_recently_used_entry(self):
        await self.cache.set("first", 1, 30)
        await self.cache.set("second", 2, 30)
        self.assertEqual(await self.cache.get("first"), 1)
        await self.cache.set("third", 3, 30)

        self.assertIsNone(await self.cache.get("second"))
        self.assertEqual(await self.cache.get("first"), 1)
        stats = await self.cache.stats()
        self.assertEqual(stats["entries"], 2)
        self.assertEqual(stats["evictions"], 1)

    async def test_byte_limit_does_not_store_an_oversized_value(self):
        small_cache = AsyncTTLCache(max_entries=10, max_bytes=16)
        await small_cache.set("large", "x" * 100, 30)

        self.assertIsNone(await small_cache.get("large"))
        self.assertEqual((await small_cache.stats())["size_bytes"], 0)

    async def test_cached_values_are_copied_and_accounted_for_by_object_size(self):
        value = {"nested": ["original"]}
        await self.cache.set("mutable", value, 30)
        value["nested"][0] = "changed"
        cached = await self.cache.get("mutable")
        cached["nested"][0] = "caller mutation"

        self.assertEqual(
            await self.cache.get("mutable"),
            {"nested": ["original"]},
        )
        self.assertGreater((await self.cache.stats())["size_bytes"], 0)

    async def test_concurrent_callers_share_one_loader(self):
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def loader():
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return {"value": "shared"}

        first = asyncio.create_task(self.cache.get_or_create("shared", 30, loader))
        await started.wait()
        second = asyncio.create_task(self.cache.get_or_create("shared", 30, loader))
        await asyncio.sleep(0)
        release.set()

        self.assertEqual(await first, {"value": "shared"})
        self.assertEqual(await second, {"value": "shared"})
        self.assertEqual(calls, 1)
        self.assertEqual((await self.cache.stats())["deduplicated"], 1)


if __name__ == "__main__":
    unittest.main()
