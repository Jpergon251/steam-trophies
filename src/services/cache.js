// Persistent cache layer backed by IndexedDB.
//
// This module is the ONLY place that talks to IndexedDB. Vue components and the
// Pinia store consume its promise-based API, so the storage details never leak
// into the UI layer.
//
// Logical keys:
//   profiles     -> steamId
//   games        -> [steamId, appid]   (index: bySteamId)
//   achievement_summaries -> [steamId, appid] (index: bySteamId)
//   achievements -> [steamId, appid] (full details only)
//   trophies     -> [steamId, tier, appid] (columnar display data)
//
// Bump DB_VERSION whenever the schema changes and add the matching migration
// branch inside `onupgradeneeded`; never open a brand new database per schema.

const DATABASE_NAME = "steam-trophies-cache";
// Version 4 separates summaries, detail catalogs, and display trophy data.
const DB_VERSION = 4;

const PROFILE_STORE = "profiles";
const GAME_STORE = "games";
const ACHIEVEMENT_STORE = "achievements";
const SUMMARY_STORE = "achievement_summaries";
const TROPHY_STORE = "trophies";

import { getTrophyTier } from '../data/trophyTiers.js';

// Cache time-to-live. Expired entries are revalidated, never deleted.
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

        let summariesStore;
        if (!db.objectStoreNames.contains(SUMMARY_STORE)) {
          summariesStore = db.createObjectStore(SUMMARY_STORE, {
            keyPath: GAME_KEY,
          });
        } else {
          summariesStore = request.transaction.objectStore(SUMMARY_STORE);
        }
        if (!summariesStore.indexNames.contains(BY_STEAM_ID)) {
          summariesStore.createIndex(BY_STEAM_ID, "steamId", { unique: false });
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
        if (!db.objectStoreNames.contains(TROPHY_STORE)) {
          const trophiesStore = db.createObjectStore(TROPHY_STORE, {
            keyPath: ["steamId", "tier", "appid"],
          });
          trophiesStore.createIndex(BY_STEAM_ID, "steamId", { unique: false });
        }

        // Move legacy full catalogs out of game records. Aggregate summaries
        // are refreshed into their own store after the new version is opened.
        if (oldVersion > 0 && oldVersion < 3) {
          const cursorRequest = gamesStore.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const game = cursor.value;
            if (
              Array.isArray(game.achievements) &&
              game.achievements.length &&
              game.achievementsDetailsComplete !== false
            ) {
              achievementsStore.put({
                steamId: String(game.steamId),
                appid: String(game.appid),
                achievements: game.achievements,
                available: game.achievementsAvailable !== false,
                detailsComplete: true,
                iconsComplete: game.achievementsIconsComplete === true,
                cachedAt: game.achievementsUpdatedAt || game.cachedAt || Date.now(),
              });
            }
            if (Array.isArray(game.achievements) && game.achievements.length) {
              game.achievements = [];
              game.achievementsDetailsComplete = false;
              cursor.update(game);
            }
            cursor.continue();
          };
        }

        if (oldVersion >= 3 && oldVersion < 4) {
          const cursorRequest = achievementsStore.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            if (cursor.value.detailsComplete !== true) cursor.delete();
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

// --- Serialization helpers --------------------------------------------------

/**
 * Strips Vue reactivity, proxies, and non-clonable elements from an achievement.
 */
export function serializeAchievement(achievement) {
  if (!achievement || typeof achievement !== 'object') return null;
  const achieved = achievement.achieved === true || Number(achievement.achieved) === 1;
  const globalPercent = achievement.global_percent != null && Number.isFinite(Number(achievement.global_percent))
    ? Number(achievement.global_percent)
    : null;
  const tier = String(achievement.tier || getTrophyTier(globalPercent) || 'bronze');
  return {
    apiname: achievement.apiname ? String(achievement.apiname) : null,
    name: String(achievement.name || achievement.apiname || ''),
    description: String(achievement.description || ''),
    achieved,
    unlocktime: Number(achievement.unlocktime) || 0,
    icon: String(achievement.icon || ''),
    icongray: String(achievement.icongray || ''),
    global_percent: globalPercent,
    hidden: achievement.hidden ?? null,
    tier,
    appid: String(achievement.appid || ''),
    gameName: String(achievement.gameName || ''),
    gameIcon: String(achievement.gameIcon || ''),
  };
}

/**
 * Normalizes and recalculates derived data for a game, returning a pure plain
 * object safe for IndexedDB structured clone.
 */
export function serializeGame(game) {
  if (!game || typeof game !== 'object') return null;
  const achievements = Array.isArray(game.achievements)
    ? game.achievements.map(serializeAchievement).filter(Boolean)
    : [];
  const unlocked = achievements.filter((a) => a.achieved);
  const detailsComplete = game.achievementsDetailsComplete
    ?? Boolean(game.achievementsUpdatedAt && game.achievementsAvailable !== null);
  const achievementCount = detailsComplete
    ? achievements.length
    : Number(game.achievementCount ?? game.totalAchievements ?? game.achievement_count) || 0;
  const unlockedCount = detailsComplete
    ? unlocked.length
    : Number(game.unlockedCount ?? game.unlockedAchievements ?? game.achievements_unlocked) || 0;
  const progress = achievementCount ? Math.round((unlockedCount / achievementCount) * 100) : Number(game.progress || game.completion) || 0;
  const isDiamond = Boolean(achievementCount > 0 && unlockedCount === achievementCount);

  const tierCounts = {
    bronze: 0,
    silver: 0,
    gold: 0,
    diamond: isDiamond ? 1 : 0,
  };
  if (detailsComplete && achievements.length) {
    for (const a of unlocked) {
      const tier = a.tier || getTrophyTier(a.global_percent) || 'bronze';
      if (tierCounts[tier] !== undefined) tierCounts[tier] += 1;
      else tierCounts.bronze += 1;
    }
  } else if (game.tierCounts || game.trophyCounts) {
    const src = game.tierCounts || game.trophyCounts;
    tierCounts.bronze = Number(src.bronze) || 0;
    tierCounts.silver = Number(src.silver) || 0;
    tierCounts.gold = Number(src.gold) || 0;
    tierCounts.diamond = isDiamond ? 1 : 0;
  }

  const playtimeForever = Number(game.playtime_forever) || 0;
  const playtime2weeks = Number(game.playtime_2weeks) || 0;
  const rtimeLastPlayed = Number(game.rtime_last_played) || 0;

  return {
    appid: String(game.appid),
    name: String(game.name || ''),
    playtime_forever: playtimeForever,
    playtime_2weeks: playtime2weeks,
    rtime_last_played: rtimeLastPlayed,
    img_icon_url: String(game.img_icon_url || ''),
    img_logo_url: String(game.img_logo_url || ''),
    coverUrl: String(game.coverUrl || ''),
    headerUrl: String(game.headerUrl || ''),
    fallbackUrl: String(game.fallbackUrl || ''),
    achievements,
    libraryOrder: Math.max(0, Number(game.libraryOrder) || 0),
    achievementSummaryVersion: Number(game.achievementSummaryVersion) || 0,
    achievementsDetailsComplete: Boolean(detailsComplete),
    achievementsIconsComplete: Boolean(game.achievementsIconsComplete),
    achievementsAvailable: game.achievementsAvailable ?? null,
    achievementCount,
    totalAchievements: achievementCount,
    achievement_count: achievementCount,
    unlockedCount,
    unlockedAchievements: unlockedCount,
    achievements_unlocked: unlockedCount,
    tierCounts,
    trophyCounts: { ...tierCounts },
    progress,
    completion: progress,
    isDiamond,
    diamond: isDiamond,
    achievementsUpdatedAt: Number(game.achievementsUpdatedAt) || 0,
    achievementsPlaytime: Number(game.achievementsPlaytime ?? playtimeForever) || 0,
    has_community_visible_stats: Boolean(game.has_community_visible_stats),
  };
}

function serializeOwnedGame(game) {
  return {
    appid: String(game.appid),
    name: String(game.name || ''),
    playtime_forever: Number(game.playtime_forever) || 0,
    playtime_2weeks: Number(game.playtime_2weeks) || 0,
    rtime_last_played: Number(game.rtime_last_played) || 0,
    img_icon_url: String(game.img_icon_url || ''),
    img_logo_url: String(game.img_logo_url || ''),
    coverUrl: String(game.coverUrl || ''),
    headerUrl: String(game.headerUrl || ''),
    fallbackUrl: String(game.fallbackUrl || ''),
    has_community_visible_stats: Boolean(game.has_community_visible_stats),
    libraryOrder: Math.max(0, Number(game.libraryOrder) || 0),
  };
}

function serializeAchievementSummary(game, cleanGame = serializeGame(game)) {
  if (!cleanGame) return null;
  return {
    steamId: String(game.steamId || ''),
    appid: toAppId(cleanGame.appid),
    total: cleanGame.achievementCount,
    unlocked: cleanGame.unlockedCount,
    percentage: cleanGame.progress,
    tierCounts: cleanGame.tierCounts,
    isDiamond: cleanGame.isDiamond,
    available: cleanGame.achievementsAvailable,
    updatedAt: cleanGame.achievementsUpdatedAt,
    playtime: cleanGame.achievementsPlaytime,
    version: cleanGame.achievementSummaryVersion,
  };
}

/**
 * Serializes profile summary into a structured-clone-safe plain object.
 */
export function serializeProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const serialized = {};
  for (const [key, value] of Object.entries(profile)) {
    if (typeof value === 'function' || typeof value === 'symbol') continue;
    if (typeof value === 'object' && value !== null) {
      try {
        serialized[key] = JSON.parse(JSON.stringify(value));
      } catch {
        // Skip non-serializable objects
      }
    } else {
      serialized[key] = value;
    }
  }
  return serialized;
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
    [PROFILE_STORE, GAME_STORE, SUMMARY_STORE],
    "readonly",
  );
  const done = transactionDone(tx);

  const profileRequest = requestResult(tx.objectStore(PROFILE_STORE).get(id));
  const gamesRequest = requestResult(
    tx.objectStore(GAME_STORE).index(BY_STEAM_ID).getAll(id),
  );
  const summariesRequest = requestResult(
    tx.objectStore(SUMMARY_STORE).index(BY_STEAM_ID).getAll(id),
  );
  const [profileRecord, gameRecords, summaryRecords] = await Promise.all([
    profileRequest,
    gamesRequest,
    summariesRequest,
  ]);
  await done;

  if (!profileRecord && !gameRecords.length) return null;

  const summariesByAppId = new Map(
    summaryRecords.map((record) => [toAppId(record.appid), record]),
  );
  const games = gameRecords
    .sort((left, right) => (Number(left.libraryOrder) || 0) - (Number(right.libraryOrder) || 0))
    .map(({ steamId: _steamId, ...game }) => {
      const summary = summariesByAppId.get(toAppId(game.appid));
      return serializeGame({
        ...game,
        achievementCount: summary?.total ?? game.achievementCount,
        unlockedCount: summary?.unlocked ?? game.unlockedCount,
        progress: summary?.percentage ?? game.progress,
        tierCounts: summary?.tierCounts ?? game.tierCounts,
        isDiamond: summary?.isDiamond ?? game.isDiamond,
        achievementsAvailable: summary?.available ?? game.achievementsAvailable,
        achievementsUpdatedAt: summary?.updatedAt ?? game.achievementsUpdatedAt,
        achievementsPlaytime: summary?.playtime ?? game.achievementsPlaytime,
        achievementSummaryVersion: summary?.version ?? game.achievementSummaryVersion,
        achievements: [],
        achievementsDetailsComplete: false,
      })
    })
    .filter(Boolean);

  return {
    profile: profileRecord?.profile ? serializeProfile(profileRecord.profile) : null,
    profileCachedAt: Number(profileRecord?.cachedAt) || 0,
    games,
    gamesCachedAt: Number(profileRecord?.gamesCachedAt) || 0,
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
    [PROFILE_STORE, GAME_STORE, SUMMARY_STORE, ACHIEVEMENT_STORE, TROPHY_STORE],
    "readwrite",
  );
  const done = transactionDone(tx);

  const profileStore = tx.objectStore(PROFILE_STORE);
  const gameStore = tx.objectStore(GAME_STORE);
  const summaryStore = tx.objectStore(SUMMARY_STORE);
  const achievementStore = tx.objectStore(ACHIEVEMENT_STORE);
  const trophyStore = tx.objectStore(TROPHY_STORE);
  const gameIndex = gameStore.index(BY_STEAM_ID);
  const achievementIndex = achievementStore.index(BY_STEAM_ID);

  const existingProfileRequest = requestResult(profileStore.get(id));
  const existingKeysRequest = removeMissing
    ? requestResult(gameIndex.getAllKeys(id))
    : null;
  const summaryIndex = summaryStore.index(BY_STEAM_ID);
  const existingSummaryKeysRequest = removeMissing
    ? requestResult(summaryIndex.getAllKeys(id))
    : null;
  const existingAchievementKeysRequest = removeMissing
    ? requestResult(achievementIndex.getAllKeys(id))
    : null;
  const existingTrophyKeysRequest = removeMissing
    ? requestResult(trophyStore.index(BY_STEAM_ID).getAllKeys(id))
    : null;

  const existingProfile = await existingProfileRequest;
  const existingKeys = existingKeysRequest ? await existingKeysRequest : null;
  const existingSummaryKeys = existingSummaryKeysRequest
    ? await existingSummaryKeysRequest
    : null;
  const existingAchievementKeys = existingAchievementKeysRequest
    ? await existingAchievementKeysRequest
    : null;
  const existingTrophyKeys = existingTrophyKeysRequest
    ? await existingTrophyKeysRequest
    : null;

  if (
    removeMissing &&
    existingKeys &&
    existingSummaryKeys &&
    existingAchievementKeys &&
    existingTrophyKeys
  ) {
    const incomingIds = new Set((games || []).map((game) => toAppId(game.appid)));
    for (const key of existingKeys) {
      if (!incomingIds.has(toAppId(key[1]))) gameStore.delete(key);
    }
    for (const key of existingSummaryKeys) {
      if (!incomingIds.has(toAppId(key[1]))) summaryStore.delete(key);
    }
    // Achievements are keyed independently, so remove both records for games
    // no longer present in the confirmed full Steam collection snapshot.
    for (const key of existingAchievementKeys) {
      if (!incomingIds.has(toAppId(key[1]))) achievementStore.delete(key);
    }
    for (const key of existingTrophyKeys) {
      if (!incomingIds.has(toAppId(key[2]))) trophyStore.delete(key);
    }
  }

  for (const game of (games || [])) {
    try {
      const cleanGame = serializeGame(game);
      if (cleanGame) {
        gameStore.put({
          ...serializeOwnedGame(cleanGame),
          steamId: id,
          appid: toAppId(cleanGame.appid),
        });
        summaryStore.put({
          ...serializeAchievementSummary(game, cleanGame),
          steamId: id,
        });
      }
    } catch (putError) {
      console.error(`Failed to persist game ${game?.appid} to IndexedDB:`, putError);
    }
  }

  const cleanProfile = serializeProfile(profile ?? existingProfile?.profile ?? null);
  profileStore.put({
    ...existingProfile,
    steamId: id,
    profile: cleanProfile,
    cachedAt: Date.now(),
    gamesCachedAt: Number(gamesCachedAt) || Date.now(),
  });

  await done;
}

/** Persists a single game record (used by progressive achievement updates). */
export async function writeGame(steamId, game) {
  const id = normalizeId(steamId);
  const cleanGame = serializeGame(game);
  if (!cleanGame) return;
  const db = await openDatabase();
  const tx = db.transaction([GAME_STORE, SUMMARY_STORE], "readwrite");
  const done = transactionDone(tx);
  tx.objectStore(GAME_STORE).put({
    ...serializeOwnedGame(cleanGame),
    steamId: id,
    appid: toAppId(cleanGame.appid),
  });
  tx.objectStore(SUMMARY_STORE).put({
    ...serializeAchievementSummary(game, cleanGame),
    steamId: id,
  });
  await done;
}

export async function readGameAchievementDetails(steamId, appid) {
  const id = normalizeId(steamId);
  const db = await openDatabase();
  const tx = db.transaction(ACHIEVEMENT_STORE, "readonly");
  const done = transactionDone(tx);
  const record = await requestResult(
    tx.objectStore(ACHIEVEMENT_STORE).get([id, toAppId(appid)]),
  );
  await done;
  if (!record?.detailsComplete) return null;
  return {
    achievements: Array.isArray(record.achievements) ? record.achievements : [],
    available: record.available !== false,
    cachedAt: Number(record.cachedAt) || 0,
    detailsComplete: true,
    iconsComplete: record.iconsComplete === true,
  };
}

export async function readTrophyGroups(steamId, tier, appids) {
  if (!appids.length) return [];
  const id = normalizeId(steamId);
  const db = await openDatabase();
  const tx = db.transaction(TROPHY_STORE, "readonly");
  const done = transactionDone(tx);
  const store = tx.objectStore(TROPHY_STORE);
  const requests = appids.map((appid) =>
    requestResult(store.get([id, tier, toAppId(appid)])),
  );
  const records = await Promise.all(requests);
  await done;
  return records;
}

/** Persists the achievements payload for a single game. */
export async function writeAchievements(
  steamId,
  appid,
  {
    achievements,
    available,
    cachedAt = Date.now(),
    detailsComplete = true,
    iconsComplete = false,
  },
) {
  const id = normalizeId(steamId);
  const cleanAchievements = Array.isArray(achievements)
    ? achievements.map(serializeAchievement).filter(Boolean)
    : [];
  const db = await openDatabase();
  const tx = db.transaction(ACHIEVEMENT_STORE, "readwrite");
  const done = transactionDone(tx);
  tx.objectStore(ACHIEVEMENT_STORE).put({
    steamId: id,
    appid: toAppId(appid),
    achievements: cleanAchievements,
    available: available !== false,
    detailsComplete: Boolean(detailsComplete),
    iconsComplete: Boolean(iconsComplete),
    cachedAt: Number(cachedAt) || Date.now(),
  });
  await done;
}

/** Persists one fetched Steam summary page in a single IndexedDB transaction. */
export async function writeAchievementBatch(steamId, games, trophyGroupsByAppId) {
  const id = normalizeId(steamId);
  const db = await openDatabase();
  const tx = db.transaction([SUMMARY_STORE, TROPHY_STORE], "readwrite");
  const done = transactionDone(tx);
  const summaryStore = tx.objectStore(SUMMARY_STORE);
  const trophyStore = tx.objectStore(TROPHY_STORE);

  for (const game of games) {
    const cleanGame = serializeGame(game);
    if (!cleanGame) continue;
    const appid = toAppId(cleanGame.appid);
    summaryStore.put({
      ...serializeAchievementSummary(game, cleanGame),
      steamId: id,
      appid,
    });
    for (const tier of ["bronze", "silver", "gold"]) {
      trophyStore.delete([id, tier, appid]);
      const trophies = trophyGroupsByAppId.get(appid)?.[tier] || [];
      if (trophies.names?.length) {
        trophyStore.put({
          steamId: id,
          tier,
          appid,
          count: trophies.names.length,
          trophies,
        });
      }
    }
  }

  await done;
}

/** Persists only the profile summary, leaving games/achievements untouched. */
export async function writeProfile(steamId, profile) {
  const id = normalizeId(steamId);
  const cleanProfile = serializeProfile(profile);
  const db = await openDatabase();
  const tx = db.transaction(PROFILE_STORE, "readwrite");
  const done = transactionDone(tx);
  const store = tx.objectStore(PROFILE_STORE);
  const existing = await requestResult(store.get(id));
  store.put({
    ...existing,
    steamId: id,
    profile: cleanProfile ?? existing?.profile ?? null,
    cachedAt: Date.now(),
  });
  await done;
}

/**
 * Removes a game and its achievements for a profile. Used when a game drops
 * out of the collection.
 */
export async function deleteGame(steamId, appid) {
  const id = normalizeId(steamId);
  const db = await openDatabase();
  const tx = db.transaction(
    [GAME_STORE, ACHIEVEMENT_STORE, TROPHY_STORE],
    "readwrite",
  );
  const done = transactionDone(tx);
  tx.objectStore(GAME_STORE).delete([id, toAppId(appid)]);
  tx.objectStore(ACHIEVEMENT_STORE).delete([id, toAppId(appid)]);
  const trophyIndex = tx.objectStore(TROPHY_STORE).index(BY_STEAM_ID);
  const keys = await requestResult(trophyIndex.getAllKeys(id));
  for (const key of keys) {
    if (toAppId(key[2]) === toAppId(appid)) tx.objectStore(TROPHY_STORE).delete(key);
  }
  await done;
}
