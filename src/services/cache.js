// Persistent cache layer backed by IndexedDB.
//
// This module is the ONLY place that talks to IndexedDB. Vue components and the
// Pinia store consume its promise-based API, so the storage details never leak
// into the UI layer.
//
// Logical keys:
//   profiles     -> steamId
//   games        -> [steamId, appid]   (index: bySteamId)
//   achievements -> [steamId, appid]   (index: bySteamId)
//
// Bump DB_VERSION whenever the schema changes and add the matching migration
// branch inside `onupgradeneeded`; never open a brand new database per schema.

const DATABASE_NAME = "steam-trophies-cache";
// Version 2 was used by the previous cache implementation. Version 3 keeps
// those stores/records and adds the dedicated achievements store if absent.
const DB_VERSION = 3;

const PROFILE_STORE = "profiles";
const GAME_STORE = "games";
const ACHIEVEMENT_STORE = "achievements";

/** Cache time-to-live. Expired entries are revalidated, never deleted. */
export const CACHE_TTL = 30 * 60 * 1000;

const PROFILE_KEY = "steamId";
const GAME_KEY = ["steamId", "appid"];
const ACHIEVEMENT_KEY = ["steamId", "appid"];
const BY_STEAM_ID = "bySteamId";

let databasePromise = null;

function openDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error("IndexedDB is not available in this environment."),
    );
  }

  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const oldVersion = event.oldVersion;

        // Version 1: create the base stores only when missing. This also
        // supports a fresh install without replacing any existing data.
        if (!db.objectStoreNames.contains(PROFILE_STORE)) {
          db.createObjectStore(PROFILE_STORE, { keyPath: PROFILE_KEY });
        }

        let gamesStore;
        if (!db.objectStoreNames.contains(GAME_STORE)) {
          gamesStore = db.createObjectStore(GAME_STORE, { keyPath: GAME_KEY });
        } else {
          gamesStore = request.transaction.objectStore(GAME_STORE);
        }
        if (!gamesStore.indexNames.contains(BY_STEAM_ID)) {
          gamesStore.createIndex(BY_STEAM_ID, "steamId", { unique: false });
        }

        // Migration to v3: the v2 schema already had profiles and games;
        // preserve those records and add the achievements store. On a v1
        // install this also creates the store during the same upgrade.
        let achievementsStore;
        if (!db.objectStoreNames.contains(ACHIEVEMENT_STORE)) {
          achievementsStore = db.createObjectStore(ACHIEVEMENT_STORE, {
            keyPath: ACHIEVEMENT_KEY,
          });
        } else {
          achievementsStore = request.transaction.objectStore(ACHIEVEMENT_STORE);
        }
        if (!achievementsStore.indexNames.contains(BY_STEAM_ID)) {
          achievementsStore.createIndex(BY_STEAM_ID, "steamId", {
            unique: false,
          });
        }

        // The prior v2 cache stored achievement payloads alongside each game.
        // Copy them into the dedicated store during upgrade, without deleting
        // or rewriting the original game/profile records. This makes migration
        // idempotent and preserves caches already on disk.
        if (oldVersion > 0 && oldVersion < 3) {
          const cursorRequest = gamesStore.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const game = cursor.value;
            if (Array.isArray(game.achievements) && game.achievements.length) {
              achievementsStore.put({
                steamId: String(game.steamId),
                appid: String(game.appid),
                achievements: game.achievements,
                available: game.achievementsAvailable !== false,
                cachedAt: game.achievementsUpdatedAt || game.cachedAt || Date.now(),
              });
            }
            cursor.continue();
          };
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        // If another tab requests a newer version we release the connection so
        // the upgrade is not blocked.
        db.onversionchange = () => {
          db.close();
          databasePromise = null;
        };
        resolve(db);
      };

      request.onerror = () =>
        reject(
          request.error || new Error("Could not open the cache database."),
        );
      request.onblocked = () =>
        reject(
          new Error("The cache database upgrade is blocked by another tab."),
        );
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }

  return databasePromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error || new Error("IndexedDB transaction aborted."));
  });
}

function normalizeId(steamId) {
  return String(steamId);
}

function toAppId(appid) {
  return String(appid);
}

// --- Reads -----------------------------------------------------------------

/**
 * Reads everything stored for a profile and rebuilds a plain snapshot:
 * { profile, games, achievements, profileCachedAt, gamesCachedAt }.
 * Returns null when nothing has been stored for that steamId yet.
 */
export async function readProfileSnapshot(steamId) {
  const id = normalizeId(steamId);
  const db = await openDatabase();
  const tx = db.transaction(
    [PROFILE_STORE, GAME_STORE, ACHIEVEMENT_STORE],
    "readonly",
  );
  const done = transactionDone(tx);

  const profileRequest = requestResult(tx.objectStore(PROFILE_STORE).get(id));
  const gamesRequest = requestResult(
    tx.objectStore(GAME_STORE).index(BY_STEAM_ID).getAll(id),
  );
  const achievementsRequest = requestResult(
    tx.objectStore(ACHIEVEMENT_STORE).index(BY_STEAM_ID).getAll(id),
  );

  const [profileRecord, gameRecords, achievementRecords] = await Promise.all([
    profileRequest,
    gamesRequest,
    achievementsRequest,
  ]);
  await done;

  if (!profileRecord && !gameRecords.length) return null;

  const achievementsByAppId = {};
  for (const record of achievementRecords) {
    achievementsByAppId[toAppId(record.appid)] = {
      achievements: record.achievements || [],
      available: record.available !== false,
      cachedAt: record.cachedAt || 0,
    };
  }

  // Compatibility fallback for v2 data (and partially completed migrations):
  // achievements were also embedded in each game record. Prefer the dedicated
  // store when present, but never hide existing legacy data.
  for (const game of gameRecords) {
    const appid = toAppId(game.appid);
    if (!achievementsByAppId[appid] && Array.isArray(game.achievements)) {
      achievementsByAppId[appid] = {
        achievements: game.achievements,
        available: game.achievementsAvailable !== false,
        cachedAt: game.achievementsUpdatedAt || game.cachedAt || 0,
      };
    }
  }

  return {
    profile: profileRecord?.profile || null,
    profileCachedAt: profileRecord?.cachedAt || 0,
    games: gameRecords.map(({ steamId: _steamId, ...game }) => game),
    gamesCachedAt: profileRecord?.gamesCachedAt || 0,
    achievementsByAppId,
  };
}

// --- Writes ----------------------------------------------------------------

/**
 * Persists a full games snapshot for a profile. This is the only operation
 * allowed to remove games that Steam no longer reports, and it does so
 * atomically with the upsert so a failure never leaves the collection empty.
 */
export async function writeGamesSnapshot(
  steamId,
  { profile, games, removeMissing = false, gamesCachedAt = Date.now() },
) {
  const id = normalizeId(steamId);
  const db = await openDatabase();
  const tx = db.transaction(
    [PROFILE_STORE, GAME_STORE, ACHIEVEMENT_STORE],
    "readwrite",
  );
  const done = transactionDone(tx);

  const profileStore = tx.objectStore(PROFILE_STORE);
  const gameStore = tx.objectStore(GAME_STORE);
  const achievementStore = tx.objectStore(ACHIEVEMENT_STORE);
  const gameIndex = gameStore.index(BY_STEAM_ID);
  const achievementIndex = achievementStore.index(BY_STEAM_ID);

  const existingProfileRequest = requestResult(profileStore.get(id));
  const existingKeysRequest = removeMissing
    ? requestResult(gameIndex.getAllKeys(id))
    : null;
  const existingAchievementKeysRequest = removeMissing
    ? requestResult(achievementIndex.getAllKeys(id))
    : null;

  const existingProfile = await existingProfileRequest;
  const existingKeys = existingKeysRequest ? await existingKeysRequest : null;
  const existingAchievementKeys = existingAchievementKeysRequest
    ? await existingAchievementKeysRequest
    : null;

  if (removeMissing && existingKeys && existingAchievementKeys) {
    const incomingIds = new Set(games.map((game) => toAppId(game.appid)));
    for (const key of existingKeys) {
      if (!incomingIds.has(toAppId(key[1]))) gameStore.delete(key);
    }
    // Achievements are keyed independently, so remove both records for games
    // no longer present in the confirmed full Steam collection snapshot.
    for (const key of existingAchievementKeys) {
      if (!incomingIds.has(toAppId(key[1]))) achievementStore.delete(key);
    }
  }

  for (const game of games) {
    gameStore.put({ ...game, steamId: id, appid: toAppId(game.appid) });
  }

  profileStore.put({
    ...existingProfile,
    steamId: id,
    profile: profile ?? existingProfile?.profile ?? null,
    cachedAt: Date.now(),
    gamesCachedAt,
  });

  await done;
}

/** Persists a single game record (used by progressive achievement updates). */
export async function writeGame(steamId, game) {
  const id = normalizeId(steamId);
  const db = await openDatabase();
  const tx = db.transaction(GAME_STORE, "readwrite");
  const done = transactionDone(tx);
  tx.objectStore(GAME_STORE).put({
    ...game,
    steamId: id,
    appid: toAppId(game.appid),
  });
  await done;
}

/** Persists the achievements payload for a single game. */
export async function writeAchievements(
  steamId,
  appid,
  { achievements, available, cachedAt = Date.now() },
) {
  const id = normalizeId(steamId);
  const db = await openDatabase();
  const tx = db.transaction(ACHIEVEMENT_STORE, "readwrite");
  const done = transactionDone(tx);
  tx.objectStore(ACHIEVEMENT_STORE).put({
    steamId: id,
    appid: toAppId(appid),
    achievements,
    available,
    cachedAt,
  });
  await done;
}

/** Persists only the profile summary, leaving games/achievements untouched. */
export async function writeProfile(steamId, profile) {
  const id = normalizeId(steamId);
  const db = await openDatabase();
  const tx = db.transaction(PROFILE_STORE, "readwrite");
  const done = transactionDone(tx);
  const store = tx.objectStore(PROFILE_STORE);
  const existing = await requestResult(store.get(id));
  store.put({ ...existing, steamId: id, profile, cachedAt: Date.now() });
  await done;
}

/**
 * Removes a game and its achievements for a profile. Used when a game drops
 * out of the collection.
 */
export async function deleteGame(steamId, appid) {
  const id = normalizeId(steamId);
  const db = await openDatabase();
  const tx = db.transaction([GAME_STORE, ACHIEVEMENT_STORE], "readwrite");
  const done = transactionDone(tx);
  tx.objectStore(GAME_STORE).delete([id, toAppId(appid)]);
  tx.objectStore(ACHIEVEMENT_STORE).delete([id, toAppId(appid)]);
  await done;
}
