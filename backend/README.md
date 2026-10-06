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

`GET /api/health` is a local FastAPI health check and does not contact Steam.

## Current profile request flow

The Vue store loads the profile and owned-games list first, displays that
library, then processes stale achievements progressively with three workers per
browser profile. Grid/list changes use that same local store and do not call the
backend. The backend retains the existing routes and response shapes:

- `GET /api/steam/search?q=...`
- `GET /api/steam/profile?steam_id=...`
- `GET /api/steam/profile/{steam_id}/games`
- `GET /api/steam/profile/{steam_id}/games/{app_id}/achievements`

Before caching, a cold profile page with `X` games made **2 + 2X** Steam API
requests: one player summary, one owned-games request, and up to two requests
per game (player achievements and global achievement percentages). A game
whose stats are unavailable uses one player-achievements request. If loaded
through the search page, the pre-optimization total was up to **3 + 2X** for a
SteamID64 search or **4 + 2X** for a vanity URL (resolution, summary, then the
profile page's summary and library requests).

With the current cache, the cold profile page remains at up to **2 + 2X**
requests. Searching by SteamID first reuses the summary for the following
profile request; a vanity search is up to **3 + 2X** due to its one resolution.
Repeated requests for the same profile and games make zero upstream calls
within their TTLs, and repeated achievements requests do too unless the
frontend signals that an already-known active game's unlock state needs a
fresh check. Global percentages are shared across Steam users for the same
app ID, so only the first cold lookup per game needs that second request during
the global-percentage TTL.

Achievements remain progressive; there is no backend endpoint that downloads
every game's achievements before returning the library. The per-game request
also caches its combined result. The existing active-game refresh includes the
optional `force_refresh=true` query parameter so a fresh unlock is not hidden
behind the normal achievement cache. That refresh still reuses the app-wide
global percentages cache.

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
