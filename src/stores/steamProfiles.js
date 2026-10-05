import { defineStore } from 'pinia'
import { getSteamAchievements, getSteamGames, getSteamProfile } from '../services/steam.js'
import { getTrophyTier } from '../data/trophyTiers.js'
import {
  CACHE_TTL,
  readProfileSnapshot,
  serializeAchievement,
  serializeGame,
  serializeProfile,
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
// Keep concurrent Steam achievement requests bounded. Steam's API is rate
// limited and firing 100+ requests at once is what triggered the previous
// implementation's instability.
const ACHIEVEMENT_CONCURRENCY = 5

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

function deriveGame(game, achievements = [], available = true, updatedAt = Date.now()) {
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
  const achievementCount = normalizedAchievements.length
  const unlockedCount = unlocked.length
  const isDiamond = Boolean(achievementCount > 0 && unlockedCount === achievementCount)
  const progress = achievementCount ? Math.round((unlockedCount / achievementCount) * 100) : 0

  const tierCounts = { bronze: 0, silver: 0, gold: 0, diamond: isDiamond ? 1 : 0 }
  unlocked.forEach((achievement) => {
    const tier = achievement.tier || getTrophyTier(achievement.global_percent) || 'bronze'
    if (tierCounts[tier] !== undefined) {
      tierCounts[tier] += 1
    } else {
      tierCounts.bronze += 1
    }
  })

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
    achievementsAvailable: available !== false,
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
    achievementsUpdatedAt: updatedAt || Date.now(),
    achievementsPlaytime: Number(game.achievementsPlaytime ?? playtimeForever) || 0,
    has_community_visible_stats: Boolean(game.has_community_visible_stats),
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
  )
}

/**
 * Merges a fresh Steam owned-games entry with the previously stored game.
 * Achievement data already held in memory is preserved; only Steam-owned
 * fields (name, playtime, artwork...) are refreshed.
 */
function makeLibraryGame(rawGame, previous) {
  const merged = { ...(previous || {}), ...rawGame, appid: String(rawGame.appid) }
  const achievements = previous?.achievements || []
  const available = previous?.achievementsAvailable ?? null
  const updatedAt = previous?.achievementsUpdatedAt || 0
  return deriveGame(merged, achievements, available, updatedAt)
}

function isAchievementDataStale(game, now = Date.now()) {
  if (!game) return true
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
  }),
  getters: {
    profileFor: (state) => (steamId) => state.profiles[String(steamId)]?.profile || null,
    gamesFor: (state) => (steamId) => state.profiles[String(steamId)]?.games || [],
    trophiesFor: (state) => (steamId) =>
      (state.profiles[String(steamId)]?.games || []).flatMap((game) =>
        game.achievements.filter((achievement) => achievement.achieved),
      ),
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
            const appid = String(gameRecord.appid)
            const achEntry = snapshot.achievementsByAppId?.[appid]
            const achievements = achEntry?.achievements?.length
              ? achEntry.achievements
              : Array.isArray(gameRecord.achievements)
                ? gameRecord.achievements
                : []
            const available = achEntry ? achEntry.available : gameRecord.achievementsAvailable
            const updatedAt = achEntry?.cachedAt || gameRecord.achievementsUpdatedAt || 0
            return deriveGame(gameRecord, achievements, available, updatedAt)
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

        // First-load case: make sure the profile bucket exists even when Steam
        // returns no games, so the UI can leave its loading state.
        if (!this.profiles[id]) this.profiles[id] = { games: [], hydratedAt: Date.now() }

        const previousGames = this.profiles[id]?.games || []
        const previousById = new Map(previousGames.map((game) => [String(game.appid), game]))
        const nextGames = steamGames.map((rawGame) =>
          makeLibraryGame(rawGame, previousById.get(String(rawGame.appid))),
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
              games: nextGames.map(serializeGame),
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

        // Progressive achievement processing starts only after the collection
        // is already visible. Each game is persisted individually as it lands.
        const gamesToRefresh = this.achievementPromises[id]
          ? []
          : nextGames.filter((game) => isAchievementDataStale(game, Date.now()))

        // Prioritize actively played games first so new trophies show immediately
        gamesToRefresh.sort((a, b) => {
          const scoreA = (Number(a.playtime_2weeks) > 0 ? 10000 : 0) + (Number(a.rtime_last_played) || 0)
          const scoreB = (Number(b.playtime_2weeks) > 0 ? 10000 : 0) + (Number(b.rtime_last_played) || 0)
          return scoreB - scoreA
        })

        if (gamesToRefresh.length) {
          this.syncs[id] = {
            active: true,
            processed: 0,
            total: gamesToRefresh.length,
            stale: hadCache,
            phase: 'achievements',
          }
          const refresh = this.refreshAchievements(id, gamesToRefresh)
          this.achievementPromises[id] = refresh.finally(() => {
            delete this.achievementPromises[id]
            if (this.syncs[id]?.phase === 'achievements') {
              this.syncs[id] = {
                active: false,
                processed: this.syncs[id].processed,
                total: gamesToRefresh.length,
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

    /** Processes achievements with bounded concurrency and per-game isolation. */
    async refreshAchievements(steamId, gamesToRefresh) {
      const id = String(steamId)
      const queue = [...gamesToRefresh]
      const total = queue.length
      const workers = Array.from({ length: Math.min(ACHIEVEMENT_CONCURRENCY, total) }, async () => {
        while (queue.length) {
          const game = queue.shift()
          if (!game) return
          try {
            const result = await getSteamAchievements(id, game.appid)
            // A game without stats is a valid outcome, not an error.
            if (result?.available === false) {
              await this.storeAchievementResult(id, game, [], false)
            } else {
              const achievements = decorateAchievements(game, result?.achievements || [])
              await this.storeAchievementResult(id, game, achievements, true)
            }
          } catch (error) {
            // A failed request is transient: keep the last-known data and let
            // the next sync retry. Other games keep processing.
            console.info(`Skipping temporary achievement failure for ${game.name}.`, error?.status || error)
          } finally {
            const sync = this.syncs[id]
            if (sync && sync.phase === 'achievements') sync.processed += 1
          }
        }
      })
      await Promise.all(workers)
    },

    async storeAchievementResult(steamId, game, achievements, available) {
      const id = String(steamId)
      const profileState = this.profiles[id]
      if (!profileState) return
      const index = profileState.games.findIndex((item) => String(item.appid) === String(game.appid))
      if (index < 0) return
      const previous = profileState.games[index].achievements || []
      const previousByApiName = new Map(previous.map((item) => [item.apiname || item.name, item]))
      // Steam's response is authoritative for achievement state, while cached
      // artwork/description/global rarity survives fields omitted in a refresh.
      const mergedAchievements = achievements.map((achievement) => {
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
      const derived = deriveGame(profileState.games[index], mergedAchievements, available, Date.now())
      profileState.games.splice(index, 1, derived)

      const cleanGame = serializeGame(derived)
      const cleanAchievements = derived.achievements.map(serializeAchievement).filter(Boolean)

      try {
        await Promise.all([
          writeGame(id, cleanGame),
          writeAchievements(id, derived.appid, {
            achievements: cleanAchievements,
            available,
            cachedAt: derived.achievementsUpdatedAt,
          }),
        ])
      } catch (persistenceError) {
        console.error(`Failed to persist achievements for game ${game.name} (${game.appid}):`, persistenceError)
      }
    },

    /** Drops in-memory state for a profile. IndexedDB is intentionally untouched. */
    clearProfileMemory(steamId) {
      const id = String(steamId)
      delete this.profiles[id]
      delete this.errors[id]
      delete this.syncs[id]
      delete this.hydration[id]
    },
  },
})
