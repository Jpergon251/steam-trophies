# Steam Trophies backend

FastAPI proxy for Steam Web API. Run commands from `backend/`.

## Local development

1. Create and activate a Python virtual environment.
2. Install dependencies with `pip install -r requirements.txt`.
3. Copy `.env.example` to `.env` and set `STEAM_API_KEY`.
4. Start the API with:

   ```sh
   uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
   ```

5. Run the mocked test suite:

   ```sh
   python -m unittest discover -s tests -v
   ```

The suite includes a mock load scenario with three profiles and 300 game
requests. It prints cold/warm duration, upstream call count, cache hits, and
maximum observed concurrency without contacting Steam.

## Experimental Steam achievement endpoint comparison

The undocumented `IPlayerService/GetTopAchievementsForGames` and
`IPlayerService/GetAchievementsProgress` methods can be probed without changing
the production profile flow:

```sh
python scripts/diagnose_achievement_endpoints.py <17-digit-steamid>
```

This makes one request with all owned AppIDs to each experimental method and,
by default, one `GetPlayerAchievements` request per game at concurrency two.
It stops issuing legacy requests after a Steam 429. A one-game probe can inspect
the returned fields or vary `max_achievements`:

```sh
python scripts/diagnose_achievement_endpoints.py <steamid> \
  --probe-top-appid <owned-appid> --top-limit 1000
```

The reported one-request AppID list only establishes whether that tested list
was accepted; it does not claim to establish Steam's maximum batch size. The
tool uses the configured API key but never prints it. It is an opt-in diagnostic
and is not used by FastAPI routes.

`GET /api/health` is a local FastAPI health check and does not contact Steam.

## Current profile request flow

The Vue store loads the profile and owned-games list first. Games remain
lightweight library records; summary counts are stored separately and update
progressively. The backend reuses its owned-games cache and requests
`GetTopAchievementsForGames` in configurable AppID batches. The summary route
defaults to page zero and always returns one batch with `batch_index`,
`batch_count`, and `batch_size`; callers request later pages explicitly. The
frontend fetches pages sequentially, persists each page before requesting the
next, and continues after page-level failures.

The summary response contains one small aggregate per game plus columnar,
unlocked trophy-card fields grouped by AppID and tier. It does not return
locked-catalog entries, API names, unlock timestamps, or achievement objects.
Steam's raw Top response is reduced to those columns before it is cached or
returned from FastAPI. The browser stores aggregate summaries separately from
the display columns and asks IndexedDB for only the currently virtualized card
window; Pinia never holds the complete trophy-card collection. Full achievement
catalogs are fetched from the retained legacy route only when a game detail is
opened, except for the bounded per-batch repair of missing or truncated Top
results. Grid/list changes use the same library summaries and make no
achievement requests. The backend routes are:

- `GET /api/steam/search?q=...`
- `GET /api/steam/profile?steam_id=...`
- `GET /api/steam/profile/{steam_id}/games`
- `GET /api/steam/profile/{steam_id}/achievements` (first page)
- `GET /api/steam/profile/{steam_id}/achievements?batch_index=0`
- `GET /api/steam/profile/{steam_id}/games/{app_id}/achievements`

Before this optimization, a cold profile with `N` games could make up to
**2 + 2N** Steam API requests: player summary, owned games, then individual
player-achievement and global-percentage requests. The initial summary path
now makes **2 + ceil(N / TOP_ACHIEVEMENTS_BATCH_SIZE)** Steam requests on the
summary path (player summary, owned games, and batched Top results), absent
bounded repairs and retries. With the default batch size of 350, a 350-game
profile uses three Steam requests before any detail page is opened. A detail page retains the legacy fallback and may make
one player-achievement request, one cached game-schema request for achievement
names/icons, plus a shared/cached global-percentage request.

The summary endpoint reuses the same owned-games cache as the library route.
Identical Top batches share cached, compact responses and in-flight requests.
An active game can pass `force_refresh=true` to bypass only its own batch's
Top-response cache when a fresh unlock is needed. Paging keeps each request
short enough for serverless HTTP time limits; a failed page does not discard
completed pages.

`TOP_ACHIEVEMENTS_MAX` defaults to 1000 and `TOP_ACHIEVEMENTS_BATCH_SIZE`
defaults to 350. The experimental Top endpoint requires GET: a live probe
accepted 350 AppIDs but returned HTTP 414 for 400 because the encoded request
URL exceeded the upstream proxy limit; POST returned HTTP 405. Therefore the
batch size is a practical request-URL limit, not a Steam-documented AppID
limit, and batches such as 10,000 cannot be sent in a single request.
The Top method is not part of the published official Web API contract. Results
contain unlocked display fields and aggregate totals, not the full locked
catalogue, API names, or unlock timestamps. Entries missing from a partly valid
response are repaired individually, with a limit of ten fallbacks per batch;
an empty or failed multi-game batch is reported instead of triggering a mass
legacy fallback. A result list reaching `TOP_ACHIEVEMENTS_MAX` is treated as
possibly truncated and falls back for that game. If a 350-AppID page exceeds
the upstream URL limit and returns HTTP 414, the backend retries it as smaller
sequential Steam requests while preserving the same logical frontend page.
Full game details are stored
in IndexedDB only after the user opens the game; reopening a fresh cached detail
uses zero Steam requests. All Steam requests reuse the existing in-memory
single-flight cache. The on-demand detail route joins `GetPlayerAchievements`
with `GetSchemaForGame` so each achievement can
include its Steam icon; the profile summary path does not request game schemas.

## Resource controls

- One reusable `httpx.AsyncClient` is created and closed by FastAPI lifespan.
- Connection pool defaults: 16 total connections, 8 keep-alive connections.
- A process-wide `asyncio.Semaphore` allows at most 8 simultaneous Steam
  requests. This limit is per Render process/instance.
- Steam connect/read/write/pool timeouts default to 5/20/10/5 seconds.
- At most two retries are made for 429, 500, 502, 503, 504 and network/timeout
  errors, with exponential backoff and jitter. Other HTTP statuses are not
  retried. Upstream 400/403/404 responses are briefly negatively cached.
- In-memory cache uses TTL expiration, LRU eviction, a 64 MiB serialized-size
  cap, and at most 4,096 entries. This bounds cached payloads; Python object
  overhead is additional. Per-process defaults are profile 5 minutes, owned games 10 minutes,
  achievements 45 minutes, global percentages 60 minutes, achievement
  unavailability 5 minutes, and other negative HTTP responses 30 seconds.
- Concurrent misses for the same cache key share one async task. Cache values
  are copied on read/write to prevent one response's normalization from
  mutating other callers' cached values.
- In-memory fixed-window limits default to 20 searches, 30 profile lookups,
  30 library requests, and 1,200 achievement requests per IP per minute.
  Limits and cached data are process-local; they reset on restart and are not
  shared among multiple Render instances.

## Configuration

All settings can be supplied as environment variables. `.env.example` lists
the defaults and supported names:

- `STEAM_API_KEY`
- `STEAM_MAX_CONCURRENCY`, `STEAM_MAX_RETRIES`
- `STEAM_MAX_CONNECTIONS`, `STEAM_MAX_KEEPALIVE_CONNECTIONS`
- `STEAM_TIMEOUT_CONNECT`, `STEAM_TIMEOUT_READ`, `STEAM_TIMEOUT_WRITE`,
  `STEAM_TIMEOUT_POOL`
- `CACHE_PROFILE_TTL`, `CACHE_GAMES_TTL`, `CACHE_ACHIEVEMENTS_TTL`,
  `CACHE_GLOBAL_ACHIEVEMENTS_TTL`, `CACHE_NEGATIVE_TTL`,
  `CACHE_NEGATIVE_ACHIEVEMENTS_TTL`, `CACHE_MAX_ENTRIES`, `CACHE_MAX_BYTES`
- `TOP_ACHIEVEMENTS_MAX`, `TOP_ACHIEVEMENTS_BATCH_SIZE`
- `RATE_LIMIT_WINDOW_SECONDS`, `RATE_LIMIT_SEARCH_PER_MINUTE`,
  `RATE_LIMIT_PROFILE_PER_MINUTE`, `RATE_LIMIT_GAMES_PER_MINUTE`,
  `RATE_LIMIT_ACHIEVEMENTS_PER_MINUTE`

## Render

Set the Render service root directory to `backend`, provide `STEAM_API_KEY`
and any desired overrides in the environment, then use the existing ASGI start
command:

```sh
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

No local absolute paths or external cache services are required. Use
`GET /api/health` as the Render health-check path.

## Request diagnostics

Each API request produces one summarized INFO log with endpoint, a masked
SteamID, HTTP status, total duration, time in Steam requests and semaphore wait,
upstream request count, cache hit/miss counts, coalesced callers, retry count,
and owned-game count when available. API keys and full query strings are never
logged. The cache also exposes aggregate hit, miss, deduplication, eviction,
entry, and in-flight counts internally through `steam_cache.stats()`.
