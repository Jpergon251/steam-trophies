import unittest

from app.config import (
    MAX_CACHE_BYTES,
    MAX_CACHE_ENTRIES,
    MAX_STEAM_CONCURRENCY,
    MAX_STEAM_CONNECTIONS,
    MAX_STEAM_KEEPALIVE_CONNECTIONS,
    MAX_TOP_ACHIEVEMENTS_BATCH_SIZE,
    settings,
)


class ResourceSettingTests(unittest.TestCase):
    def test_defaults_and_environment_overrides_stay_within_process_caps(self):
        self.assertLessEqual(settings.steam_max_concurrency, MAX_STEAM_CONCURRENCY)
        self.assertLessEqual(settings.steam_max_connections, MAX_STEAM_CONNECTIONS)
        self.assertLessEqual(
            settings.steam_max_keepalive_connections,
            MAX_STEAM_KEEPALIVE_CONNECTIONS,
        )
        self.assertLessEqual(settings.cache_max_entries, MAX_CACHE_ENTRIES)
        self.assertLessEqual(settings.cache_max_bytes, MAX_CACHE_BYTES)
        self.assertLessEqual(
            settings.top_achievements_batch_size,
            MAX_TOP_ACHIEVEMENTS_BATCH_SIZE,
        )
