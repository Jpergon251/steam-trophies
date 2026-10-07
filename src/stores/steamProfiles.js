import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import {
  getSteamAchievementSummary,
  getSteamAchievementSummaries,
  getSteamAchievements,
  getSteamGames,
  getSteamProfile,
} from '../services/steam.js'
import { getTrophyTier } from '../data/trophyTiers.js'
import { getKnownProfileStats } from '../data/profileStats.js'
import { markRawGameRecord, replaceGameRecords } from '../data/gameRecords.js'
import {
  runBoundedQueue,
  runSequentialBatches,
  selectStaleSummaryGames,
  selectUnknownFallbackGames,
} from '../data/syncQueue.js'
import {
  CACHE_TTL,
  readGameAchievementDetails,
  readProfileSnapshot,
  readTrophyGroups,
  serializeProfile,
  writeAchievementBatch,
  writeAchievementSummaryBatch,
  writeAchievements,
  writeGame,
  writeGamesSnapshot,
  writeProfile,
} from '../services/cache.js'

// Achievement data is heavier than the library summary, so it gets a longer
// TTL. Games whose stats are unavailable are retried sooner.
const ACHIEVEMENT_CACHE_TTL = 30 * 60 * 1000
const ACTIVE_GAME_CACHE_TTL = 60 * 1000
const NEGATIVE_ACHIEVEMENT_CACHE_TTL = 5 * 60 * 1000
const SUMMARY_BATCH_RETRIES = 2
const FALLBACK_CONCURRENCY = 2
const PROFILE_STAT_KEYS = ['bronze', 'silver', 'gold', 'completed', 'knownGames', 'unknownGames']

function updateProfileStats(store, steamId, previousGame, nextGame) {
  const id = String(steamId)
  const current = store.profileStats[id]
    || getKnownProfileStats(store.profiles[id]?.games || [])
  const previous = previousGame ? getKnownProfileStats([previousGame]) : null
  const next = nextGame ? getKnownProfileStats([nextGame]) : null
  const updated = { ...current }
  for (const key of PROFILE_STAT_KEYS) {
    updated[key] += (next?.[key] || 0) - (previous?.[key] || 0)
  }
  store.profileStats[id] = updated
}

function updateProfileStatsForGames(store, steamId, previousGames, nextGames) {
  const id = String(steamId)
  if (!nextGames.length) return
  const current = store.profileStats[id]
    || getKnownProfileStats(store.profiles[id]?.games || [])
  const previous = getKnownProfileStats(previousGames)
  const next = getKnownProfileStats(nextGames)
  const updated = { ...current }
  for (const key of PROFILE_STAT_KEYS) {
    updated[key] += next[key] - previous[key]
  }
  store.profileStats[id] = updated
}

function commitGameEntries(store, steamId, profileState, entries) {
  if (!entries.length) return
  updateProfileStatsForGames(
    store,
    steamId,
    entries.map(({ previous }) => previous),
    entries.map(({ game }) => game),
  )
  profileState.games = replaceGameRecords(
    profileState.games,
    entries.map(({ gameIndex, game }) => [gameIndex, game]),
  )
}

function getArtUrls(game) {
  if (!game || !game.appid) {
    return { coverUrl: '', headerUrl: '', fallbackUrl: '' }
  }
  return {
    coverUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/library_600x900.jpg`,
    headerUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/header.jpg`,
    fallbackUrl: game.img_logo_url
      ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_logo_url}.jpg`
      : game.img_icon_url
        ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg`
        : '',
  }
}

function decorateAchievements(game, achievements = []) {
  return achievements.map((achievement) => {
    const achieved = achievement.achieved === true || Number(achievement.achieved) === 1
    const percent = achievement.global_percent != null && Number.isFinite(Number(achievement.global_percent))
      ? Number(achievement.global_percent)
      : null
    return {
      ...achievement,
      achieved,
      appid: game.appid ? String(game.appid) : '',
      gameName: game.name || '',
      gameIcon: game.img_icon_url
        ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg`
        : '',
      icon: achievement.icon || '',
      icongray: achievement.icongray || '',
      global_percent: percent,
      // Tier is presentation metadata; locked achievements need it too so the
      // game detail can place every Steam achievement in a shelf.
      tier: getTrophyTier(percent) || 'bronze',
    }
  })
}

function deriveGame(game, achievements = [], available = null, updatedAt = 0, summary = {}) {
  const normalizedAchievements = (achievements || []).map((achievement) => {
    const achieved = achievement.achieved === true || Number(achievement.achieved) === 1
    const percent = achievement.global_percent != null && Number.isFinite(Number(achievement.global_percent))
      ? Number(achievement.global_percent)
      : null
    const tier = achievement.tier || getTrophyTier(percent) || 'bronze'
    return {
      ...achievement,
      achieved,
      tier,
      global_percent: percent,
      appid: game.appid ? String(game.appid) : achievement.appid ? String(achievement.appid) : '',
      gameName: game.name || achievement.gameName || '',
      gameIcon: game.img_icon_url
        ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg`
        : achievement.gameIcon || '',
    }
  })
  const unlocked = normalizedAchievements.filter((achievement) => achievement.achieved)
  const detailsComplete = summary.detailsComplete
    ?? game.achievementsDetailsComplete
    ?? Boolean(updatedAt && available !== null)
  const achievementSummaryVersion = Number(
    summary.achievementSummaryVersion ?? game.achievementSummaryVersion,
  ) || 0
  const achievementSummaryStatus = detailsComplete
    ? 'complete'
    : summary.achievementSummaryStatus
      ?? game.achievementSummaryStatus
      ?? (achievementSummaryVersion === 1 ? 'complete' : 'unknown')
  const achievementSummaryKnown = ['complete', 'partial'].includes(achievementSummaryStatus)
  const iconsComplete = summary.iconsComplete
    ?? game.achievementsIconsComplete
    ?? false
  const achievementCount = achievementSummaryKnown
    ? detailsComplete
      ? normalizedAchievements.length
      : Number(summary.achievementCount ?? game.achievementCount ?? game.totalAchievements) || 0
    : null
  const unlockedCount = achievementSummaryKnown
    ? detailsComplete
      ? unlocked.length
      : Number(summary.unlockedCount ?? game.unlockedCount ?? game.unlockedAchievements) || 0
    : null
  const isDiamond = Boolean(
    achievementSummaryStatus === 'complete' &&
    achievementCount > 0 &&
    unlockedCount === achievementCount,
  )
  const progress = achievementCount
    ? achievementSummaryStatus === 'partial'
      ? null
      : Math.round((unlockedCount / achievementCount) * 100)
    : achievementSummaryKnown
      ? 0
      : null

  const storedTierCounts = summary.tierCounts || game.tierCounts || game.trophyCounts || {}
  const tierCounts = {
    bronze: !achievementSummaryKnown
      ? null
      : detailsComplete
      ? 0
      : Number(storedTierCounts.bronze) || 0,
    silver: !achievementSummaryKnown
      ? null
      : detailsComplete
      ? 0
      : Number(storedTierCounts.silver) || 0,
    gold: !achievementSummaryKnown
      ? null
      : detailsComplete
      ? 0
      : Number(storedTierCounts.gold) || 0,
    diamond: isDiamond ? 1 : 0,
  }
  if (detailsComplete) {
    unlocked.forEach((achievement) => {
      const tier = achievement.tier || getTrophyTier(achievement.global_percent) || 'bronze'
      if (tierCounts[tier] !== undefined) tierCounts[tier] += 1
      else tierCounts.bronze += 1
    })
  }

  const playtimeForever = Number(game.playtime_forever) || 0
  const playtime2weeks = Number(game.playtime_2weeks) || 0
  const rtimeLastPlayed = Number(game.rtime_last_played) || 0

  return markRawGameRecord({
    ...game,
    appid: String(game.appid),
    name: game.name || '',
    playtime_forever: playtimeForever,
    playtime_2weeks: playtime2weeks,
    rtime_last_played: rtimeLastPlayed,
    ...getArtUrls(game),
    achievements: normalizedAchievements,
    achievementsDetailsComplete: Boolean(detailsComplete),
    achievementsIconsComplete: Boolean(iconsComplete),
    achievementsAvailable: available == null ? null : available !== false,
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
    achievementsUpdatedAt: Number(updatedAt) || 0,
    achievementsPlaytime: Number(game.achievementsPlaytime ?? playtimeForever) || 0,
    has_community_visible_stats: Boolean(game.has_community_visible_stats),
    libraryOrder: Number(game.libraryOrder) || 0,
    achievementSummaryVersion,
    achievementSummaryStatus,
    achievementSummaryKnown,
    achievementFallbackAttemptedAt: Number(
      summary.achievementFallbackAttemptedAt ?? game.achievementFallbackAttemptedAt,
    ) || 0,
    achievementSyncAttemptAt: Number(
      summary.achievementSyncAttemptAt ?? game.achievementSyncAttemptAt,
    ) || 0,
    achievementSyncError: summary.achievementSyncError
      ?? game.achievementSyncError
      ?? '',
  })
}

/**
 * Rebuilds a game from cached persistence. Ensures full derivation of all
 * achievement counters, diamond status, and trophy shelves.
 */
function fromCache(game) {
  return deriveGame(
    game,
    game.achievements || [],
    game.achievementsAvailable,
    game.achievementsUpdatedAt || 0,
    {
      achievementCount: game.achievementCount,
      unlockedCount: game.unlockedCount,
      detailsComplete: game.achievementsDetailsComplete,
      iconsComplete: game.achievementsIconsComplete,
      tierCounts: game.tierCounts,
      achievementSummaryVersion: game.achievementSummaryVersion,
      achievementSummaryStatus: game.achievementSummaryStatus,
      achievementFallbackAttemptedAt: game.achievementFallbackAttemptedAt,
      achievementSyncAttemptAt: game.achievementSyncAttemptAt,
      achievementSyncError: game.achievementSyncError,
    },
  )
}

function mergeAchievementResult(game, achievements, available, summary = {}) {
  const previousByApiName = new Map(
    (game.achievements || []).map((item) => [item.apiname || item.name, item]),
  )
  const incomingAchievements = summary.detailsComplete
    ? achievements
    : game.achievementsDetailsComplete
      ? game.achievements
      : []
  const mergedAchievements = incomingAchievements.map((achievement) => {
    const prev = previousByApiName.get(achievement.apiname || achievement.name) || {}
    const achieved = achievement.achieved === true || Number(achievement.achieved) === 1
    const percent = achievement.global_percent != null && Number.isFinite(Number(achievement.global_percent))
      ? Number(achievement.global_percent)
      : prev.global_percent != null && Number.isFinite(Number(prev.global_percent))
        ? Number(prev.global_percent)
        : null
    return {
      ...prev,
      ...achievement,
      achieved,
      unlocktime: Number(achievement.unlocktime) || Number(prev.unlocktime) || 0,
      icon: achievement.icon || prev.icon || '',
      icongray: achievement.icongray || prev.icongray || '',
      name: achievement.name || prev.name || achievement.apiname,
      description: achievement.description || prev.description || '',
      global_percent: percent,
      tier: getTrophyTier(percent) || prev.tier || 'bronze',
    }
  })

  return deriveGame(
    {
      ...game,
      achievementsPlaytime: Number(game.playtime_forever) || 0,
    },
    mergedAchievements,
    available,
    Date.now(),
    {
      achievementCount: summary.achievementCount,
      unlockedCount: summary.unlockedCount,
      detailsComplete: summary.detailsComplete ?? true,
      iconsComplete: summary.iconsComplete ?? game.achievementsIconsComplete,
      tierCounts: summary.tierCounts,
      achievementSummaryVersion: summary.achievementSummaryVersion,
      achievementSummaryStatus: summary.achievementSummaryStatus,
      achievementFallbackAttemptedAt: summary.achievementFallbackAttemptedAt,
      achievementSyncAttemptAt: summary.achievementSyncAttemptAt,
      achievementSyncError: summary.achievementSyncError,
    },
  )
}

/**
 * Merges a fresh Steam owned-games entry with the previously stored game.
 * Achievement data already held in memory is preserved; only Steam-owned
 * fields (name, playtime, artwork...) are refreshed.
 */
function makeLibraryGame(rawGame, previous, libraryOrder) {
  const merged = {
    ...(previous || {}),
    ...rawGame,
    appid: String(rawGame.appid),
    libraryOrder,
  }
  const achievements = previous?.achievements || []
  const available = previous?.achievementsAvailable ?? null
  const updatedAt = previous?.achievementsUpdatedAt || 0
  return deriveGame(merged, achievements, available, updatedAt, {
    achievementCount: previous?.achievementCount,
    unlockedCount: previous?.unlockedCount,
    detailsComplete: previous?.achievementsDetailsComplete,
    iconsComplete: previous?.achievementsIconsComplete,
    tierCounts: previous?.tierCounts,
    achievementSummaryVersion: previous?.achievementSummaryVersion,
    achievementSummaryStatus: previous?.achievementSummaryStatus,
    achievementFallbackAttemptedAt: previous?.achievementFallbackAttemptedAt,
    achievementSyncAttemptAt: previous?.achievementSyncAttemptAt,
    achievementSyncError: previous?.achievementSyncError,
  })
}

function isAchievementDataStale(game, now = Date.now(), requireSummary = true) {
  if (!game) return true
  if (
    requireSummary &&
    ![1, 2].includes(Number(game.achievementSummaryVersion))
  ) return true
  if (game.achievementSummaryStatus === 'unknown') {
    return !game.achievementsUpdatedAt ||
      now - game.achievementsUpdatedAt >= NEGATIVE_ACHIEVEMENT_CACHE_TTL
  }
  // Never checked achievements yet
  if (!game.achievementsUpdatedAt || game.achievementsAvailable === null) return true

  // Negative cache: game stats were unavailable previously
  if (game.achievementsAvailable === false) {
    return now - game.achievementsUpdatedAt >= NEGATIVE_ACHIEVEMENT_CACHE_TTL
  }

  // Playtime increased since last achievement check
  const playtimeForever = Number(game.playtime_forever || 0)
  const achievementsPlaytime = Number(game.achievementsPlaytime || 0)
  if (playtimeForever > achievementsPlaytime) return true

  // Played since last achievement check
  const lastPlayedSec = Number(game.rtime_last_played || 0)
  const checkedSec = Math.floor(game.achievementsUpdatedAt / 1000)
  if (lastPlayedSec > checkedSec) return true

  // Actively played game (played in last 2 weeks or last 24 hours)
  const playedInLast2Weeks = Number(game.playtime_2weeks || 0) > 0
  const playedInLast24h = lastPlayedSec > 0 && Math.floor(now / 1000) - lastPlayedSec < 86400
  if (playedInLast2Weeks || playedInLast24h) {
    return now - game.achievementsUpdatedAt >= ACTIVE_GAME_CACHE_TTL
  }

  // General TTL
  return now - game.achievementsUpdatedAt >= ACHIEVEMENT_CACHE_TTL
}

function shouldForceAchievementRefresh(game, now = Date.now()) {
  if (
    !game?.achievementsUpdatedAt ||
    game.achievementsAvailable === false
  ) {
    return false
  }

  const playtimeForever = Number(game.playtime_forever || 0)
  const achievementsPlaytime = Number(game.achievementsPlaytime || 0)
  const lastPlayedSec = Number(game.rtime_last_played || 0)
  const checkedSec = Math.floor(game.achievementsUpdatedAt / 1000)
  const playedInLast2Weeks = Number(game.playtime_2weeks || 0) > 0
  const playedInLast24h =
    lastPlayedSec > 0 &&
    Math.floor(now / 1000) - lastPlayedSec < 86400

  return (
    playtimeForever > achievementsPlaytime ||
    lastPlayedSec > checkedSec ||
    ((playedInLast2Weeks || playedInLast24h) &&
      now - game.achievementsUpdatedAt >= ACTIVE_GAME_CACHE_TTL)
  )
}

function isSteamGameChanged(next, previous) {
  return !previous || Number(previous.playtime_forever) !== Number(next.playtime_forever)
    || Number(previous.playtime_2weeks) !== Number(next.playtime_2weeks)
    || Number(previous.rtime_last_played) !== Number(next.rtime_last_played)
    || Boolean(previous.has_community_visible_stats) !== Boolean(next.has_community_visible_stats)
    || previous.name !== next.name || previous.img_icon_url !== next.img_icon_url || previous.img_logo_url !== next.img_logo_url
}

function throwIfSyncAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason || new DOMException('Profile synchronization was cancelled.', 'AbortError')
  }
}

function waitForRetry(delay, signal) {
  throwIfSyncAborted(signal)
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    const onAbort = () => {
      window.clearTimeout(timeoutId)
      reject(signal.reason || new DOMException('Profile synchronization was cancelled.', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export const useSteamProfilesStore = defineStore('steamProfiles', {
  state: () => ({
    // profiles[steamId] = { profile, games, gamesCachedAt, cachedAt, hydratedAt }
    profiles: {},
    profileStats: {},
    // syncs[steamId] = { active, processed, total, stale, phase }
    syncs: {},
    // errors[steamId] = Error | null
    errors: {},
    // In-flight hydration promises keyed by steamId.
    hydration: {},
    // In-flight sync promises keyed by steamId (single sync per profile).
    syncPromises: {},
    syncControllers: markRaw(new Map()),
    // In-flight progressive achievement refresh promises keyed by steamId.
    achievementPromises: {},
    // In-flight detail requests keyed by steamId and appid.
    detailPromises: {},
    activeDetailAppIds: {},
    trophyWindowPromises: {},
    // Games already checked for missing achievement icons during this session.
    iconDetailAttempts: {},
  }),
  getters: {
    profileFor: (state) => (steamId) => state.profiles[String(steamId)]?.profile || null,
    statsFor: (state) => (steamId) => state.profileStats[String(steamId)] || getKnownProfileStats([]),
    gamesFor: (state) => (steamId) => state.profiles[String(steamId)]?.games || [],
    isSyncing: (state) => (steamId) => Boolean(state.syncs[String(steamId)]?.active),
    errorFor: (state) => (steamId) => state.errors[String(steamId)] || null,
    hasProfile: (state) => (steamId) => Boolean(state.profiles[String(steamId)]?.profile),
    isHydrating: (state) => (steamId) => Boolean(state.hydration[String(steamId)]),
  },
  actions: {
    /**
     * Public entry point used by ProfilePage. Hydrates from IndexedDB first
     * (IndexedDB -> Pinia -> UI) and only then starts the background Steam
     * sync. Returns immediately once the cache has been applied, so the UI is
     * never blocked on the network.
     */
    async loadProfile(steamId) {
      const id = String(steamId || '')
      if (!id) return

      await this.hydrateFromCache(id)
      // Fire-and-forget background revalidation. Callers that need to await it
      // can use `syncProfile` directly.
      this.syncProfile(id).catch(() => {})
    },

    /** Loads a profile's snapshot from IndexedDB into Pinia exactly once. */
    async hydrateFromCache(steamId) {
      const id = String(steamId)
      if (this.profiles[id]?.hydratedAt) return this.profiles[id]
      if (this.hydration[id]) return this.hydration[id]

      const hydration = (async () => {
        try {
          const snapshot = await readProfileSnapshot(id)
          // The user may have navigated away while we were reading. Drop the
          // result unless the profile is still relevant or not yet loaded.
          if (!snapshot) return
          if (this.profiles[id]?.hydratedAt) return

          const games = (snapshot.games || []).map((gameRecord) => {
            return deriveGame(gameRecord, [], gameRecord.achievementsAvailable, gameRecord.achievementsUpdatedAt || 0, {
              achievementCount: gameRecord.achievementCount,
              unlockedCount: gameRecord.unlockedCount,
              tierCounts: gameRecord.tierCounts,
              achievementSummaryVersion: gameRecord.achievementSummaryVersion,
              achievementSummaryStatus: gameRecord.achievementSummaryStatus,
              achievementFallbackAttemptedAt: gameRecord.achievementFallbackAttemptedAt,
              achievementSyncAttemptAt: gameRecord.achievementSyncAttemptAt,
              achievementSyncError: gameRecord.achievementSyncError,
              detailsComplete: false,
            })
          })

          this.profiles[id] = {
            profile: snapshot.profile,
            games,
            gamesCachedAt: snapshot.gamesCachedAt || 0,
            cachedAt: snapshot.profileCachedAt || 0,
            hydratedAt: Date.now(),
          }
          this.profileStats[id] = getKnownProfileStats(games)
        } catch (error) {
          console.warn('Could not read the Steam cache.', error)
        } finally {
          delete this.hydration[id]
        }
      })()

      this.hydration[id] = hydration
      return hydration
    },

    /**
     * Guarantees a single Steam sync per profile. Concurrent callers share the
     * same promise instead of triggering duplicate requests.
     */
    syncProfile(steamId) {
      const id = String(steamId)
      const existing = this.syncPromises[id]
      if (existing) {
        if (this.syncControllers.get(id)?.signal.aborted) {
          return existing.catch(() => {}).then(() => this.syncProfile(id))
        }
        return existing
      }

      const controller = new AbortController()
      this.syncControllers.set(id, controller)
      let promise
      promise = this.runSync(id, controller.signal).finally(() => {
        if (this.syncPromises[id] === promise) delete this.syncPromises[id]
        if (this.syncControllers.get(id) === controller) this.syncControllers.delete(id)
      })
      this.syncPromises[id] = promise
      return promise
    },

    cancelProfileSync(steamId) {
      const id = String(steamId)
      const controller = this.syncControllers.get(id)
      if (!controller) return

      const sync = this.syncs[id]
      if (sync?.active) {
        this.syncs[id] = { ...sync, active: false, phase: 'paused' }
        delete this.syncs[id].updatedAppIds
      }
      controller.abort()
    },

    async runSync(steamId, signal) {
      const id = String(steamId)
      const existing = this.profiles[id]
      const hadCache = Boolean(existing?.profile || existing?.games?.length)

      this.errors[id] = null
      this.syncs[id] = {
        active: true,
        processed: 0,
        total: 0,
        stale: hadCache,
        phase: 'library',
        newGames: 0,
        updatedGames: 0,
        fallbackProcessed: 0,
        fallbackTotal: 0,
        errorCount: 0,
        updatedAppIds: new Set(),
      }

      try {
        const [profileResponse, owned] = await Promise.all([
          getSteamProfile(id, { signal }),
          getSteamGames(id, { signal }),
        ])
        throwIfSyncAborted(signal)
        const profile = profileResponse?.response?.players?.[0] || profileResponse
        const steamGames = owned?.response?.games
        if (!Array.isArray(steamGames)) throw new Error('Steam returned an invalid games collection.')

        if (!this.profiles[id]) this.profiles[id] = { games: [], hydratedAt: Date.now() }

        const previousGames = this.profiles[id]?.games || []
        const previousById = new Map(previousGames.map((game) => [String(game.appid), game]))
        const nextGames = steamGames.map((rawGame, index) =>
          makeLibraryGame(rawGame, previousById.get(String(rawGame.appid)), index),
        )
        const incomingIds = new Set(nextGames.map((game) => String(game.appid)))
        const removedGames = previousGames.filter((game) => !incomingIds.has(String(game.appid)))
        const changedGames = nextGames.filter((game) =>
          isSteamGameChanged(game, previousById.get(String(game.appid))),
        )
        const profileChanged = JSON.stringify(profile) !== JSON.stringify(this.profiles[id]?.profile)
        const snapshotStale =
          !this.profiles[id]?.gamesCachedAt ||
          Date.now() - this.profiles[id].gamesCachedAt >= CACHE_TTL
        const needsSnapshotWrite =
          !hadCache || removedGames.length > 0 || changedGames.length > 0 || snapshotStale

        // Persist the collection before touching achievements so a later
        // failure cannot lose the library. When nothing changed and the
        // snapshot is fresh we skip the write entirely.
        if (needsSnapshotWrite) {
          await writeGamesSnapshot(id, {
            profile: serializeProfile(profile),
            games: nextGames,
            removeMissing: !hadCache || removedGames.length > 0,
            gamesCachedAt: Date.now(),
          })
        } else if (profileChanged) {
          await writeProfile(id, serializeProfile(profile))
        }
        throwIfSyncAborted(signal)

        this.profiles[id] = {
          profile: profile || this.profiles[id]?.profile || null,
          games: nextGames,
          gamesCachedAt: Date.now(),
          cachedAt: Date.now(),
          hydratedAt: this.profiles[id]?.hydratedAt || Date.now(),
        }
        this.profileStats[id] = getKnownProfileStats(nextGames)

        const summaryCandidates = selectStaleSummaryGames(
          nextGames,
          (game, now) => {
            const previous = previousById.get(String(game.appid))
            const communityStatsChanged = previous &&
              Boolean(previous.has_community_visible_stats) !==
                Boolean(game.has_community_visible_stats)
            return communityStatsChanged || isAchievementDataStale(game, now)
          },
        )
        const sync = this.syncs[id]
        sync.total = nextGames.length
        sync.processed = nextGames.length - summaryCandidates.length
        sync.pending = summaryCandidates.length
        sync.newGames = nextGames.filter((game) => !previousById.has(String(game.appid))).length
        sync.phase = 'summaries'

        const forceRefresh = summaryCandidates.some((game) =>
          shouldForceAchievementRefresh(game),
        )
        await this.refreshAchievementSummaries(id, summaryCandidates, forceRefresh, signal)
        throwIfSyncAborted(signal)

        const fallbackCandidates = selectUnknownFallbackGames(
          this.profiles[id]?.games || [],
          Date.now(),
          NEGATIVE_ACHIEVEMENT_CACHE_TTL,
        )
          .map((game) => String(game.appid))
        sync.phase = 'fallback'
        sync.fallbackTotal = fallbackCandidates.length
        sync.fallbackProcessed = 0
        await this.refreshUnknownAchievementSummaries(id, fallbackCandidates, signal)
        throwIfSyncAborted(signal)

        const syncedGames = this.profiles[id]?.games || []
        const unknownGames = syncedGames.filter(
          (game) => game.achievementSummaryStatus === 'unknown',
        ).length
        const partialGames = syncedGames.filter(
          (game) => game.achievementSummaryStatus === 'partial',
        ).length
        sync.active = false
        sync.processed = sync.total
        sync.phase = sync.errorCount || unknownGames || partialGames
          ? 'partial-error'
          : 'complete'
        sync.updatedGames = sync.updatedAppIds.size
        delete sync.updatedAppIds
        sync.unknownGames = unknownGames
        sync.partialGames = partialGames
        sync.gamesWithAchievements = syncedGames.filter(
          (game) => game.achievementSummaryKnown && Number(game.unlockedCount) > 0,
        ).length
        sync.unlockedAchievements = syncedGames.reduce(
          (total, game) => total + (
            game.achievementSummaryKnown ? Number(game.unlockedCount) || 0 : 0
          ),
          0,
        )
        if (sync.errorCount) {
          this.errors[id] = new Error(
            `${sync.errorCount} game${sync.errorCount === 1 ? '' : 's'} could not be synchronized.`,
          )
        }
      } catch (error) {
        if (signal?.aborted) return
        this.errors[id] = error
        if (hadCache) {
          // Never destroy valid cached data because a refresh failed.
          console.warn('Steam revalidation failed; cached collection remains available.', error)
          this.syncs[id] = {
            ...this.syncs[id],
            active: false,
            stale: true,
            phase: 'error',
            errorCount: (this.syncs[id]?.errorCount || 0) + 1,
          }
        } else {
          this.syncs[id] = {
            ...this.syncs[id],
            active: false,
            stale: false,
            phase: 'error',
            errorCount: (this.syncs[id]?.errorCount || 0) + 1,
          }
          throw error
        }
      }
    },

    /** Refreshes only stale summaries and commits every successful batch. */
    async refreshAchievementSummaries(steamId, games, forceRefresh = false, signal) {
      const id = String(steamId)
      const profileState = this.profiles[id]
      const sync = this.syncs[id]
      const gameIndexes = new Map(
        profileState.games.map((game, index) => [String(game.appid), index]),
      )
      const sortedGames = games
        .filter((game) => Number.isInteger(Number(game.appid)))
        .slice()
        .sort((left, right) => Number(left.appid) - Number(right.appid))

      await runSequentialBatches(sortedGames, 100, async (batch, batchIndex) => {
        throwIfSyncAborted(signal)
        const appIds = batch.map((game) => String(game.appid))
        const shouldForce = forceRefresh && batch.some((game) => shouldForceAchievementRefresh(game))
        let response
        let lastError
        for (let attempt = 0; attempt <= SUMMARY_BATCH_RETRIES; attempt += 1) {
          try {
            response = await getSteamAchievementSummaries(id, {
              forceRefresh: shouldForce,
              appIds,
              signal,
            })
            throwIfSyncAborted(signal)
            break
          } catch (error) {
            if (signal?.aborted) throw error
            lastError = error
            if (attempt < SUMMARY_BATCH_RETRIES) {
              await waitForRetry(750 * (attempt + 1), signal)
            }
          }
        }
        throwIfSyncAborted(signal)

        const markSyncError = async (game, message) => {
          const gameIndex = gameIndexes.get(String(game.appid))
          if (gameIndex === undefined) return
          const current = profileState.games[gameIndex]
          let updated
          if (current.achievementSummaryKnown) {
            updated = {
              ...current,
              achievementSyncAttemptAt: Date.now(),
              achievementSyncError: message,
            }
          } else {
            updated = mergeAchievementResult(current, [], false, {
              detailsComplete: false,
              achievementSummaryVersion: 2,
              achievementSummaryStatus: 'unknown',
              achievementSyncAttemptAt: Date.now(),
              achievementSyncError: message,
            })
          }
          return { game: updated, gameIndex, previous: current }
        }

        if (!response) {
          sync.errorCount += batch.length
          const failedEntries = []
          for (const game of batch) {
            const entry = await markSyncError(
              game,
              lastError?.message || 'summary_request_failed',
            )
            if (entry) failedEntries.push(entry)
          }
          if (failedEntries.length) {
            await writeAchievementSummaryBatch(id, failedEntries.map(({ game }) => game))
            throwIfSyncAborted(signal)
            commitGameEntries(this, id, profileState, failedEntries)
          }
          console.warn(
            `Could not load Steam summary batch ${batchIndex + 1}; existing cached summaries were preserved.`,
            lastError,
          )
          sync.processed = Math.min(sync.total, sync.processed + batch.length)
          sync.pending = Math.max(0, sync.pending - batch.length)
          return
        }

        if (
          !Array.isArray(response?.games) ||
          !Array.isArray(response?.trophies) ||
          !response?.errors ||
          typeof response.errors !== 'object'
        ) {
          sync.errorCount += batch.length
          const failedEntries = []
          for (const game of batch) {
            const entry = await markSyncError(game, 'invalid_summary_response')
            if (entry) failedEntries.push(entry)
          }
          if (failedEntries.length) {
            await writeAchievementSummaryBatch(id, failedEntries.map(({ game }) => game))
            throwIfSyncAborted(signal)
            commitGameEntries(this, id, profileState, failedEntries)
          }
          sync.processed = Math.min(sync.total, sync.processed + batch.length)
          sync.pending = Math.max(0, sync.pending - batch.length)
          return
        }

        const gamesById = new Map(batch.map((game) => [String(game.appid), game]))
        const trophyGroupsByAppId = new Map()
        for (const trophyGroup of response.trophies) {
          const appid = String(trophyGroup?.appid ?? '')
          const tier = trophyGroup?.tier
          const columns = trophyGroup?.columns
          const names = ['names', 'descriptions', 'icons', 'gray_icons', 'percentages']
          if (
            !gamesById.has(appid) ||
            !['bronze', 'silver', 'gold'].includes(tier) ||
            !columns ||
            !names.every((name) => Array.isArray(columns[name])) ||
            !names.every((name) => columns[name].length === columns.names.length)
          ) continue
          const groups = trophyGroupsByAppId.get(appid) || {}
          groups[tier] = columns
          trophyGroupsByAppId.set(appid, groups)
        }

        const updatedEntries = []
        const seen = new Set()
        for (const summary of response.games) {
          const appid = String(summary?.appid ?? '')
          const gameIndex = gameIndexes.get(appid)
          if (!gamesById.has(appid) || gameIndex === undefined) continue
          seen.add(appid)
          const current = profileState.games[gameIndex]
          if (summary.status === 'unknown') {
            const reason = response.errors[appid]?.reason || 'summary_unknown'
            const updated = current.achievementSummaryKnown
              ? {
                  ...current,
                  achievementSyncAttemptAt: Date.now(),
                  achievementSyncError: reason,
                }
              : mergeAchievementResult(current, [], false, {
                  detailsComplete: false,
                  achievementSummaryVersion: 2,
                  achievementSummaryStatus: 'unknown',
                  achievementSyncAttemptAt: Date.now(),
                  achievementSyncError: reason,
                })
            updatedEntries.push({ game: updated, gameIndex, unknown: true, previous: current })
            continue
          }

          const countsValid =
            typeof summary.available === 'boolean' &&
            Number.isInteger(summary.achievement_count) &&
            Number.isInteger(summary.unlocked_count) &&
            summary.unlocked_count >= 0 &&
            summary.unlocked_count <= summary.achievement_count &&
            summary.tier_counts &&
            ['bronze', 'silver', 'gold'].every((tier) =>
              Number.isInteger(summary.tier_counts[tier]) &&
              summary.tier_counts[tier] >= 0,
            ) &&
            ['bronze', 'silver', 'gold'].reduce(
              (total, tier) => total + summary.tier_counts[tier],
              0,
            ) === summary.unlocked_count
          if (!countsValid) continue

          const updated = mergeAchievementResult(current, [], summary.available, {
            detailsComplete: false,
            iconsComplete: false,
            achievementCount: summary.achievement_count,
            unlockedCount: summary.unlocked_count,
            tierCounts: summary.tier_counts,
            achievementSummaryVersion: 2,
            achievementSummaryStatus: summary.status === 'partial' ? 'partial' : 'complete',
            achievementFallbackAttemptedAt: current.achievementFallbackAttemptedAt,
            achievementSyncAttemptAt: Date.now(),
            achievementSyncError: '',
          })
          const groups = trophyGroupsByAppId.get(appid) || {}
          if (!['bronze', 'silver', 'gold'].every(
            (tier) => (groups[tier]?.names.length || 0) === updated.tierCounts[tier],
          )) continue
          updatedEntries.push({ game: updated, gameIndex, unknown: false, previous: current })
        }

        const acceptedIds = new Set(
          updatedEntries.map(({ game }) => String(game.appid)),
        )
        const invalidEntries = []
        for (const summary of response.games) {
          const appid = String(summary?.appid ?? '')
          if (seen.has(appid) && !acceptedIds.has(appid)) {
            sync.errorCount += 1
            const entry = await markSyncError(gamesById.get(appid), 'invalid_summary_data')
            if (entry) invalidEntries.push(entry)
          }
        }
        for (const game of batch) {
          if (!seen.has(String(game.appid))) {
            sync.errorCount += 1
            const entry = await markSyncError(game, 'summary_missing_from_response')
            if (entry) invalidEntries.push(entry)
          }
        }
        if (invalidEntries.length) {
          throwIfSyncAborted(signal)
          await writeAchievementSummaryBatch(id, invalidEntries.map(({ game }) => game))
          throwIfSyncAborted(signal)
        }
        if (updatedEntries.length) {
          const knownEntries = updatedEntries.filter((entry) => !entry.unknown)
          const unknownEntries = updatedEntries.filter((entry) => entry.unknown)
          if (knownEntries.length) {
            throwIfSyncAborted(signal)
            await writeAchievementBatch(
              id,
              knownEntries.map(({ game }) => game),
              trophyGroupsByAppId,
            )
          }
          if (unknownEntries.length) {
            throwIfSyncAborted(signal)
            await writeAchievementSummaryBatch(
              id,
              unknownEntries.map(({ game }) => game),
            )
          }
          throwIfSyncAborted(signal)
          commitGameEntries(this, id, profileState, updatedEntries)
          for (const { game } of updatedEntries) {
            if (game.achievementSummaryKnown) {
              sync.updatedAppIds.add(String(game.appid))
            }
          }
        }
        if (invalidEntries.length) {
          throwIfSyncAborted(signal)
          commitGameEntries(this, id, profileState, invalidEntries)
        }
        sync.processed = Math.min(sync.total, sync.processed + batch.length)
        sync.pending = Math.max(0, sync.pending - batch.length)
      })
    },

    /** Retries unknown games individually with a small worker pool. */
    async refreshUnknownAchievementSummaries(steamId, appIds, signal) {
      const id = String(steamId)
      const profileState = this.profiles[id]
      const sync = this.syncs[id]
      const gameIndexes = new Map(
        profileState.games.map((game, index) => [String(game.appid), index]),
      )
      const pendingEntries = []
      let completedFallbackCount = 0
      let flushPromise = Promise.resolve()
      const flushPendingEntries = () => {
        if (!pendingEntries.length) return flushPromise
        const entries = pendingEntries.splice(0)
        flushPromise = flushPromise.then(() => {
          throwIfSyncAborted(signal)
          commitGameEntries(this, id, profileState, entries)
          sync.fallbackProcessed = completedFallbackCount
        })
        return flushPromise
      }
      const enqueueEntry = async (entry) => {
        throwIfSyncAborted(signal)
        pendingEntries.push(entry)
        completedFallbackCount += 1
        if (pendingEntries.length >= 24) await flushPendingEntries()
      }

      try {
        await runBoundedQueue(appIds, FALLBACK_CONCURRENCY, async (appId) => {
        throwIfSyncAborted(signal)
        const gameIndex = gameIndexes.get(String(appId))
        if (gameIndex === undefined) return
        const current = profileState.games[gameIndex]
        let result
        let lastError
        for (let attempt = 0; attempt <= SUMMARY_BATCH_RETRIES; attempt += 1) {
          try {
            result = await getSteamAchievementSummary(id, appId, { signal })
            throwIfSyncAborted(signal)
            break
          } catch (error) {
            if (signal?.aborted) throw error
            lastError = error
            if (attempt < SUMMARY_BATCH_RETRIES) {
              await waitForRetry(750 * (attempt + 1), signal)
            }
          }
        }

        throwIfSyncAborted(signal)
        const attemptedAt = Date.now()
        if (!result?.summary || !Array.isArray(result.trophies)) {
          sync.errorCount += 1
          const updated = {
            ...current,
            achievementFallbackAttemptedAt: attemptedAt,
            achievementSyncAttemptAt: attemptedAt,
            achievementSyncError: lastError?.message || 'fallback_request_failed',
          }
          await writeGame(id, updated)
          await enqueueEntry({ game: updated, gameIndex, previous: current })
        } else {
          const summary = result.summary
          const validUnknown = summary.status === 'unknown'
          const validKnown =
            ['complete', 'partial'].includes(summary.status) &&
            Number.isInteger(summary.achievement_count) &&
            Number.isInteger(summary.unlocked_count) &&
            summary.unlocked_count >= 0 &&
            summary.unlocked_count <= summary.achievement_count &&
            summary.tier_counts &&
            ['bronze', 'silver', 'gold'].every((tier) =>
              Number.isInteger(summary.tier_counts[tier]) &&
              summary.tier_counts[tier] >= 0,
            ) &&
            ['bronze', 'silver', 'gold'].reduce(
              (total, tier) => total + summary.tier_counts[tier],
              0,
            ) === summary.unlocked_count
          if (validUnknown) {
            const updated = mergeAchievementResult(current, [], false, {
              detailsComplete: false,
              achievementSummaryVersion: 2,
              achievementSummaryStatus: 'unknown',
              achievementFallbackAttemptedAt: attemptedAt,
              achievementSyncAttemptAt: attemptedAt,
              achievementSyncError: summary.reason || 'steam_unavailable',
            })
            await writeGame(id, updated)
            await enqueueEntry({ game: updated, gameIndex, previous: current })
          } else if (validKnown) {
            const updated = mergeAchievementResult(current, [], summary.available, {
              detailsComplete: false,
              iconsComplete: false,
              achievementCount: summary.achievement_count,
              unlockedCount: summary.unlocked_count,
              tierCounts: summary.tier_counts,
              achievementSummaryVersion: 2,
              achievementSummaryStatus: summary.status,
              achievementFallbackAttemptedAt: attemptedAt,
              achievementSyncAttemptAt: attemptedAt,
              achievementSyncError: '',
            })
            const groups = new Map()
            for (const item of result.trophies) {
              const bucket = groups.get(String(item.appid)) || {}
              bucket[item.tier] = item.columns
              groups.set(String(item.appid), bucket)
            }
            await writeAchievementBatch(id, [updated], groups)
            await enqueueEntry({ game: updated, gameIndex, previous: current })
            sync.updatedAppIds.add(String(updated.appid))
          } else {
            sync.errorCount += 1
            const preserved = {
              ...current,
              achievementFallbackAttemptedAt: attemptedAt,
              achievementSyncAttemptAt: attemptedAt,
              achievementSyncError: 'invalid_fallback_summary',
            }
            await writeGame(id, preserved)
            await enqueueEntry({ game: preserved, gameIndex, previous: current })
          }
        }
      }, async (appId, error) => {
        if (signal?.aborted) throw error
        const gameIndex = gameIndexes.get(String(appId))
        if (gameIndex === undefined) return
        const current = profileState.games[gameIndex]
        const attemptedAt = Date.now()
        const preserved = {
          ...current,
          achievementFallbackAttemptedAt: attemptedAt,
          achievementSyncAttemptAt: attemptedAt,
          achievementSyncError: error?.message || 'fallback_persistence_failed',
        }
        sync.errorCount += 1
        await writeGame(id, preserved)
        await enqueueEntry({ game: preserved, gameIndex, previous: current })
        console.warn(`Steam achievement fallback failed for AppID ${appId}.`, error)
        })
      } finally {
        await flushPendingEntries()
      }
    },

    async storeAchievementResult(steamId, game, achievements, available, summary = {}) {
      const id = String(steamId)
      const profileState = this.profiles[id]
      if (!profileState) return
      const index = profileState.games.findIndex((item) => String(item.appid) === String(game.appid))
      if (index < 0) return
      const derived = mergeAchievementResult(
        profileState.games[index],
        achievements,
        available,
        summary,
      )
      updateProfileStats(this, id, profileState.games[index], derived)
      profileState.games.splice(index, 1, derived)

      try {
        await Promise.all([
          writeGame(id, derived),
          writeAchievements(id, derived.appid, {
            achievements: derived.achievements,
            available,
            cachedAt: derived.achievementsUpdatedAt,
            detailsComplete: derived.achievementsDetailsComplete,
            iconsComplete: derived.achievementsIconsComplete,
          }),
        ])
      } catch (persistenceError) {
        console.error(`Failed to persist achievements for game ${game.name} (${game.appid}):`, persistenceError)
      }
      return derived
    },

    async loadTrophyWindow(steamId, tier, start, end) {
      const id = String(steamId)
      const rangeStart = Math.max(0, Number(start) || 0)
      const rangeEnd = Math.max(rangeStart, Number(end) || rangeStart)
      const key = `${id}:${tier}:${rangeStart}:${rangeEnd}`
      if (this.trophyWindowPromises[key]) return this.trophyWindowPromises[key]

      const promise = (async () => {
        const games = this.profiles[id]?.games || []
        const segments = []
        let cursor = 0
        for (const game of games) {
          if (![1, 2].includes(Number(game.achievementSummaryVersion))) continue
          const count = Number(game.tierCounts?.[tier]) || 0
          if (!count) continue
          const segmentStart = Math.max(0, rangeStart - cursor)
          const segmentEnd = Math.min(count, rangeEnd - cursor)
          if (segmentEnd > segmentStart) {
            segments.push({ game, start: segmentStart, end: segmentEnd })
          }
          cursor += count
          if (cursor >= rangeEnd) break
        }
        if (!segments.length) return []

        const records = await readTrophyGroups(
          id,
          tier,
          segments.map(({ game }) => game.appid),
        )
        const trophies = []
        for (let index = 0; index < segments.length; index += 1) {
          const { game, start: offset, end: limit } = segments[index]
          const stored = records[index]?.trophies
          if (!stored || !Array.isArray(stored.names)) {
            console.warn(`Cached ${tier} trophy summary is missing for AppID ${game.appid}.`)
            continue
          }
          if (
            !Array.isArray(stored.descriptions) ||
            !Array.isArray(stored.icons) ||
            !Array.isArray(stored.gray_icons) ||
            !Array.isArray(stored.percentages) ||
            ![
              stored.descriptions,
              stored.icons,
              stored.gray_icons,
              stored.percentages,
            ].every((column) => column.length === stored.names.length)
          ) {
            throw new Error(`Cached ${tier} trophy columns are invalid for AppID ${game.appid}.`)
          }
          const count = Math.min(limit, stored.names.length)
          for (let trophyIndex = offset; trophyIndex < count; trophyIndex += 1) {
            trophies.push({
              name: stored.names[trophyIndex],
              description: stored.descriptions[trophyIndex],
              icon: stored.icons[trophyIndex],
              icongray: stored.gray_icons[trophyIndex],
              global_percent: stored.percentages[trophyIndex],
              achieved: true,
              appid: String(game.appid),
              gameName: game.name || '',
              gameIcon: game.img_icon_url
                ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg`
                : '',
              tier,
            })
          }
        }
        return trophies
      })().finally(() => {
        delete this.trophyWindowPromises[key]
      })
      this.trophyWindowPromises[key] = promise
      return promise
    },

    async loadGameAchievementDetails(steamId, appId) {
      const id = String(steamId)
      const key = `${id}:${String(appId)}`
      if (!this.profiles[id]?.hydratedAt) {
        await this.hydrateFromCache(id)
        if (!this.profiles[id]?.hydratedAt) await this.syncProfile(id)
      }
      const game = this.profiles[id]?.games.find((item) => String(item.appid) === String(appId))
      if (
        !game ||
        (game.achievementsDetailsComplete && game.achievementsIconsComplete)
      ) return game
      if (this.detailPromises[key]) return this.detailPromises[key]

      this.evictGameDetails(id)
      this.activeDetailAppIds[id] = String(appId)
      const promise = (async () => {
        const cached = await readGameAchievementDetails(id, appId)
        if (cached && !isAchievementDataStale(game, Date.now(), false)) {
          if (this.activeDetailAppIds[id] !== String(appId)) return null
          const achievements = decorateAchievements(game, cached.achievements)
          const index = this.profiles[id].games.findIndex(
            (item) => String(item.appid) === String(appId),
          )
          if (index < 0) return null
          const updated = mergeAchievementResult(
            this.profiles[id].games[index],
            achievements,
            cached.available,
            {
              detailsComplete: true,
              iconsComplete: cached.iconsComplete,
            },
          )
          updateProfileStats(this, id, this.profiles[id].games[index], updated)
          this.profiles[id].games.splice(index, 1, updated)
          return this.profiles[id].games[index]
        }
        const result = await getSteamAchievements(id, appId, {
          forceRefresh: shouldForceAchievementRefresh(game),
        })
        if (this.activeDetailAppIds[id] !== String(appId)) {
          await writeAchievements(id, appId, {
            achievements: result?.achievements || [],
            available: result?.available !== false,
            detailsComplete: true,
            iconsComplete: result?.icons_complete === true || result?.available === false,
          })
          return null
        }
        const currentGame = this.profiles[id]?.games.find(
          (item) => String(item.appid) === String(appId),
        )
        if (!currentGame) return null
        const achievements = decorateAchievements(currentGame, result?.achievements || [])
        await this.storeAchievementResult(
          id,
          currentGame,
          achievements,
          result?.available !== false,
          {
            detailsComplete: true,
            iconsComplete: result?.icons_complete === true || result?.available === false,
          },
        )
        return this.profiles[id]?.games.find(
          (item) => String(item.appid) === String(appId),
        )
      })().finally(() => {
        delete this.detailPromises[key]
      })
      this.detailPromises[key] = promise
      return promise
    },

    evictGameDetails(steamId, appId) {
      const id = String(steamId)
      const games = this.profiles[id]?.games || []
      for (let index = 0; index < games.length; index += 1) {
        const game = games[index]
        if (
          !game.achievementsDetailsComplete ||
          (appId !== undefined && String(game.appid) !== String(appId))
        ) continue
        games[index] = markRawGameRecord({
          ...game,
          achievements: [],
          achievementsDetailsComplete: false,
          achievementsIconsComplete: false,
        })
      }
      if (appId === undefined || this.activeDetailAppIds[id] === String(appId)) {
        delete this.activeDetailAppIds[id]
      }
    },

    async loadVisibleAchievementIcons(steamId, appId) {
      const id = String(steamId)
      const app = String(appId)
      const key = `${id}:${app}`
      const game = this.profiles[id]?.games.find((item) => String(item.appid) === app)
      if (!game || game.achievementsIconsComplete || this.iconDetailAttempts[key]) return game

      this.iconDetailAttempts[key] = true
      return this.loadGameAchievementDetails(id, app)
    },

    /** Drops in-memory state for a profile. IndexedDB is intentionally untouched. */
    clearProfileMemory(steamId) {
      const id = String(steamId)
      this.cancelProfileSync(id)
      delete this.profiles[id]
      delete this.profileStats[id]
      delete this.errors[id]
      delete this.syncs[id]
      delete this.hydration[id]
      delete this.activeDetailAppIds[id]
      Object.keys(this.iconDetailAttempts).forEach((key) => {
        if (key.startsWith(`${id}:`)) delete this.iconDetailAttempts[key]
      })
    },
  },
})
