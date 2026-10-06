import { defineStore } from 'pinia'
import {
  getSteamAchievementSummaries,
  getSteamAchievements,
  getSteamGames,
  getSteamProfile,
} from '../services/steam.js'
import { getTrophyTier } from '../data/trophyTiers.js'
import {
  CACHE_TTL,
  readGameAchievementDetails,
  readProfileSnapshot,
  readTrophyGroups,
  serializeProfile,
  writeAchievementBatch,
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
  const iconsComplete = summary.iconsComplete
    ?? game.achievementsIconsComplete
    ?? false
  const achievementCount = detailsComplete
    ? normalizedAchievements.length
    : Number(summary.achievementCount ?? game.achievementCount ?? game.totalAchievements) || 0
  const unlockedCount = detailsComplete
    ? unlocked.length
    : Number(summary.unlockedCount ?? game.unlockedCount ?? game.unlockedAchievements) || 0
  const isDiamond = Boolean(achievementCount > 0 && unlockedCount === achievementCount)
  const progress = achievementCount ? Math.round((unlockedCount / achievementCount) * 100) : 0

  const storedTierCounts = summary.tierCounts || game.tierCounts || game.trophyCounts || {}
  const tierCounts = {
    bronze: detailsComplete
      ? 0
      : Number(storedTierCounts.bronze) || 0,
    silver: detailsComplete
      ? 0
      : Number(storedTierCounts.silver) || 0,
    gold: detailsComplete
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

  return {
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
    achievementSummaryVersion: Number(
      summary.achievementSummaryVersion ?? game.achievementSummaryVersion,
    ) || 0,
  }
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
  })
}

function isAchievementDataStale(game, now = Date.now(), requireSummary = true) {
  if (!game) return true
  if (requireSummary && game.achievementSummaryVersion !== 1) return true
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
    || previous.name !== next.name || previous.img_icon_url !== next.img_icon_url || previous.img_logo_url !== next.img_logo_url
}

export const useSteamProfilesStore = defineStore('steamProfiles', {
  state: () => ({
    // profiles[steamId] = { profile, games, gamesCachedAt, cachedAt, hydratedAt }
    profiles: {},
    // syncs[steamId] = { active, processed, total, stale, phase }
    syncs: {},
    // errors[steamId] = Error | null
    errors: {},
    // In-flight hydration promises keyed by steamId.
    hydration: {},
    // In-flight sync promises keyed by steamId (single sync per profile).
    syncPromises: {},
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
      if (this.syncPromises[id]) return this.syncPromises[id]

      const promise = this.runSync(id).finally(() => {
        delete this.syncPromises[id]
      })
      this.syncPromises[id] = promise
      return promise
    },

    async runSync(steamId) {
      const id = String(steamId)
      const existing = this.profiles[id]
      const hadCache = Boolean(existing?.profile || existing?.games?.length)

      this.errors[id] = null
      this.syncs[id] = { active: true, processed: 0, total: 0, stale: hadCache, phase: 'library' }

      try {
        const [profileResponse, owned] = await Promise.all([
          getSteamProfile(id),
          getSteamGames(id),
        ])
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

        this.profiles[id] = {
          profile: profile || this.profiles[id]?.profile || null,
          games: nextGames,
          gamesCachedAt: Date.now(),
          cachedAt: Date.now(),
          hydratedAt: this.profiles[id]?.hydratedAt || Date.now(),
        }

        // Persist the collection before touching achievements so a later
        // failure cannot lose the library. When nothing changed and the
        // snapshot is fresh we skip the write entirely.
        if (needsSnapshotWrite) {
          try {
            await writeGamesSnapshot(id, {
              profile: serializeProfile(profile),
              games: nextGames,
              removeMissing: !hadCache || removedGames.length > 0,
              gamesCachedAt: this.profiles[id].gamesCachedAt,
            })
          } catch (snapshotError) {
            console.error('Failed to write games snapshot to cache:', snapshotError)
            // PARTE 8: Do not cancel achievement sync if library snapshot write fails
          }
        } else if (profileChanged) {
          try {
            await writeProfile(id, serializeProfile(profile))
          } catch (profileError) {
            console.warn('Could not persist updated profile:', profileError)
          }
        }

        // The library is persisted before requesting batched summaries.
        const summariesAreStale = nextGames.some((game) =>
          isAchievementDataStale(game, Date.now()),
        )

        if (summariesAreStale && !this.achievementPromises[id]) {
          this.syncs[id] = {
            active: true,
            processed: 0,
            total: nextGames.length,
            stale: hadCache,
            phase: 'achievements',
          }
          const forceRefresh = nextGames.some((game) =>
            shouldForceAchievementRefresh(game),
          )
          const refresh = this.refreshAchievementSummaries(
            id,
            nextGames,
            forceRefresh,
          )
          this.achievementPromises[id] = refresh.finally(() => {
            delete this.achievementPromises[id]
            if (this.syncs[id]?.phase === 'achievements') {
              this.syncs[id] = {
                active: false,
                processed: this.syncs[id].total,
                total: nextGames.length,
                stale: hadCache,
                phase: 'idle',
              }
            }
          })
        } else {
          this.syncs[id] = { active: false, processed: 0, total: 0, stale: hadCache, phase: 'idle' }
        }
      } catch (error) {
        this.errors[id] = error
        if (hadCache) {
          // Never destroy valid cached data because a refresh failed.
          console.warn('Steam revalidation failed; cached collection remains available.', error)
          this.syncs[id] = { active: false, processed: 0, total: 0, stale: true, phase: 'idle' }
        } else {
          this.syncs[id] = { active: false, processed: 0, total: 0, stale: false, phase: 'idle' }
          throw error
        }
      }
    },

    /** Loads unlocked-game summaries in one cached backend request. */
    async refreshAchievementSummaries(steamId, games, forceRefresh = false) {
      const id = String(steamId)
      try {
        const gamesById = new Map(games.map((game) => [String(game.appid), game]))
        const gameIndexesById = new Map(games.map((game, index) => [String(game.appid), index]))
        const appIdSortedGames = games
          .filter((game) => Number.isInteger(Number(game.appid)))
          .slice()
          .sort((left, right) => Number(left.appid) - Number(right.appid))
        let completedBatches = 0
        let invalidSummaries = 0
        let failedSummaries = 0

        const fetchBatch = async (batchIndex, refreshBatch = false) => {
          let lastError
          for (let attempt = 0; attempt <= SUMMARY_BATCH_RETRIES; attempt += 1) {
            try {
              return await getSteamAchievementSummaries(id, {
                forceRefresh: refreshBatch,
                batchIndex,
              })
            } catch (error) {
              lastError = error
              if (attempt < SUMMARY_BATCH_RETRIES) {
                await new Promise((resolve) => window.setTimeout(resolve, 750 * (attempt + 1)))
              }
            }
          }
          throw lastError
        }

        const batchNeedsRefresh = (batchIndex, batchSize) => forceRefresh
          && appIdSortedGames
            .slice(batchIndex * batchSize, (batchIndex + 1) * batchSize)
            .some((game) => shouldForceAchievementRefresh(game))

        const processBatch = async (response, batchIndex) => {
          if (
            !Array.isArray(response?.games) ||
            !Array.isArray(response?.trophies) ||
            !response?.errors ||
            typeof response.errors !== 'object'
          ) {
            throw new Error('Steam returned an invalid achievement summary batch.')
          }

          const updatedGames = []
          const profileState = this.profiles[id]
          if (!profileState) throw new Error('The Steam profile is no longer loaded.')
          const trophyGroupsByAppId = new Map()
          for (const summary of response.games) {
            const game = gamesById.get(String(summary.appid))
            const gameIndex = gameIndexesById.get(String(summary.appid))
            if (!game || gameIndex === undefined) continue
            if (
              typeof summary.available !== 'boolean' ||
              !Number.isInteger(summary.achievement_count) ||
              !Number.isInteger(summary.unlocked_count) ||
              summary.unlocked_count < 0 ||
              summary.unlocked_count > summary.achievement_count ||
              !summary.tier_counts ||
              !['bronze', 'silver', 'gold'].every((tier) =>
                Number.isInteger(summary.tier_counts[tier]) &&
                summary.tier_counts[tier] >= 0,
              ) ||
              ['bronze', 'silver', 'gold'].reduce(
                (total, tier) => total + summary.tier_counts[tier],
                0,
              ) !== summary.unlocked_count
            ) {
              invalidSummaries += 1
              continue
            }
            const updatedGame = mergeAchievementResult(
              profileState.games[gameIndex],
              [],
              summary.available,
              {
                detailsComplete: false,
                iconsComplete: false,
                achievementCount: summary.achievement_count,
                unlockedCount: summary.unlocked_count,
                tierCounts: summary.tier_counts,
                achievementSummaryVersion: 1,
              },
            )
            updatedGames.push({ game: updatedGame, gameIndex })
          }

          for (const trophyGroup of response.trophies) {
            const appid = String(trophyGroup?.appid ?? '')
            const tier = trophyGroup?.tier
            const columns = trophyGroup?.columns
            const columnNames = ['names', 'descriptions', 'icons', 'gray_icons', 'percentages']
            if (
              !gamesById.has(appid) ||
              !['bronze', 'silver', 'gold'].includes(tier) ||
              !columns ||
              !columnNames.every((name) => Array.isArray(columns[name])) ||
              !columnNames.every((name) => columns[name].length === columns.names.length)
            ) {
              invalidSummaries += 1
              continue
            }
            let groups = trophyGroupsByAppId.get(appid)
            if (!groups) {
              groups = {}
              trophyGroupsByAppId.set(appid, groups)
            }
            if (groups[tier]) {
              invalidSummaries += 1
              continue
            }
            groups[tier] = columns
          }

          const validUpdatedGames = []
          for (const entry of updatedGames) {
            const groups = trophyGroupsByAppId.get(String(entry.game.appid)) || {}
            const countsMatch = ['bronze', 'silver', 'gold'].every(
              (tier) => (groups[tier]?.names.length || 0) === entry.game.tierCounts[tier],
            )
            if (countsMatch) validUpdatedGames.push(entry)
            else invalidSummaries += 1
          }

          failedSummaries += Object.keys(response.errors).length
          for (const [appid, error] of Object.entries(response.errors)) {
            console.warn(
              `Steam summary batch ${batchIndex + 1} omitted AppID ${appid} (status ${error?.status ?? 'n/a'}, reason ${error?.reason ?? 'unknown'}).`,
            )
          }

          if (validUpdatedGames.length) {
            await writeAchievementBatch(
              id,
              validUpdatedGames.map(({ game }) => game),
              trophyGroupsByAppId,
            )
            for (const { game, gameIndex } of validUpdatedGames) {
              profileState.games[gameIndex] = game
            }
          }
        }

        let firstResponse = await fetchBatch(0)
        const hasBatchMetadata = Number.isInteger(firstResponse.batch_count)
        const batchCount = hasBatchMetadata
          ? firstResponse.batch_count
          : appIdSortedGames.length ? 1 : 0
        const batchSize = Number.isInteger(firstResponse.batch_size)
          ? firstResponse.batch_size
          : Math.max(1, appIdSortedGames.length)
        if (
          batchCount < 0 ||
          batchSize < 1 && batchCount > 0 ||
          (Number.isInteger(firstResponse.batch_index) && firstResponse.batch_index !== 0)
        ) {
          throw new Error('Steam returned invalid achievement batch metadata.')
        }
        if (batchNeedsRefresh(0, batchSize)) {
          firstResponse = await fetchBatch(0, true)
        }
        const sync = this.syncs[id]
        if (sync?.phase === 'achievements') sync.total = batchCount
        await processBatch(firstResponse, 0)
        if (batchCount === 0) return
        completedBatches += 1
        if (sync?.phase === 'achievements') sync.processed = completedBatches

        for (let batchIndex = 1; batchIndex < batchCount; batchIndex += 1) {
          try {
            const response = await fetchBatch(
              batchIndex,
              batchNeedsRefresh(batchIndex, batchSize),
            )
            if (
              Number.isInteger(response.batch_index) &&
              response.batch_index !== batchIndex
            ) {
              throw new Error(`Steam returned the wrong achievement batch (${batchIndex}).`)
            }
            await processBatch(response, batchIndex)
            completedBatches += 1
            if (sync?.phase === 'achievements') sync.processed = completedBatches
          } catch (error) {
            failedSummaries += 1
            console.warn(
              `Could not load Steam achievement summary batch ${batchIndex + 1}/${batchCount}; cached data was retained.`,
              error,
            )
          }
        }

        if (invalidSummaries) {
          console.warn(`Steam returned ${invalidSummaries} malformed achievement summaries; cached data was retained for those games.`)
        }
        if (failedSummaries) {
          this.errors[id] = new Error(
            `${failedSummaries} Steam achievement summaries remain unavailable.`,
          )
          console.warn(`${failedSummaries} Steam achievement summaries remain unavailable.`)
        }
      } catch (error) {
        this.errors[id] = error
        console.warn('Could not refresh batched Steam achievement summaries; cached data remains available.', error)
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
          if (game.achievementSummaryVersion !== 1) continue
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
      if (!this.profiles[id]?.hydratedAt) await this.syncProfile(id)
      else if (this.syncPromises[id]) await this.syncPromises[id]
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
          this.profiles[id].games.splice(index, 1, mergeAchievementResult(
            this.profiles[id].games[index],
            achievements,
            cached.available,
            {
              detailsComplete: true,
              iconsComplete: cached.iconsComplete,
            },
          ))
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
        games[index] = {
          ...game,
          achievements: [],
          achievementsDetailsComplete: false,
          achievementsIconsComplete: false,
        }
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
      delete this.profiles[id]
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
