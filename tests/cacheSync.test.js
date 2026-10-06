import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'

const {
  readProfileSnapshot,
  writeAchievementBatch,
  writeAchievementSummaryBatch,
  writeGamesSnapshot,
} = await import('../src/services/cache.js')

const makeGame = (appid, summary = {}) => ({
  appid: String(appid),
  name: `Game ${appid}`,
  playtime_forever: 10,
  playtime_2weeks: 0,
  rtime_last_played: 0,
  achievements: [],
  achievementsDetailsComplete: false,
  achievementsAvailable: summary.available ?? true,
  achievementSummaryVersion: 2,
  achievementSummaryStatus: summary.status ?? 'unknown',
  achievementCount: summary.total ?? null,
  unlockedCount: summary.unlocked ?? null,
  tierCounts: summary.tiers ?? null,
  achievementFallbackAttemptedAt: summary.fallbackAttemptedAt ?? 0,
  achievementSyncError: '',
})

test('sync snapshot preserves existing summary data when a new library snapshot is written', async () => {
  const steamId = '76561198000000001'
  const known = makeGame(10, {
    status: 'complete',
    total: 4,
    unlocked: 2,
    tiers: { bronze: 1, silver: 1, gold: 0 },
  })
  await writeGamesSnapshot(steamId, { games: [known], removeMissing: false })

  const cached = await readProfileSnapshot(steamId)
  assert.equal(cached.games[0].achievementSummaryStatus, 'complete')
  assert.equal(cached.games[0].unlockedCount, 2)

  await writeAchievementSummaryBatch(steamId, [{
    ...known,
    achievementSyncAttemptAt: Date.now(),
    achievementSyncError: 'temporary request failure',
  }])
  const afterFailure = await readProfileSnapshot(steamId)
  assert.equal(afterFailure.games[0].achievementSummaryStatus, 'complete')
  assert.equal(afterFailure.games[0].unlockedCount, 2)
  assert.equal(afterFailure.games[0].achievementSyncError, 'temporary request failure')

  const freshLibraryEntry = makeGame(10, {
    status: 'complete',
    total: 4,
    unlocked: 2,
    tiers: { bronze: 1, silver: 1, gold: 0 },
  })
  freshLibraryEntry.name = 'Renamed game'
  await writeGamesSnapshot(steamId, { games: [freshLibraryEntry], removeMissing: false })

  const refreshed = await readProfileSnapshot(steamId)
  assert.equal(refreshed.games[0].name, 'Renamed game')
  assert.equal(refreshed.games[0].achievementSummaryStatus, 'complete')
  assert.equal(refreshed.games[0].unlockedCount, 2)
})

test('each summary batch and fallback result is visible in IndexedDB immediately', async () => {
  const steamId = '76561198000000002'
  await writeGamesSnapshot(steamId, {
    games: [makeGame(20), makeGame(30)],
    removeMissing: false,
  })

  const first = makeGame(20, {
    status: 'complete',
    total: 2,
    unlocked: 1,
    tiers: { bronze: 1, silver: 0, gold: 0 },
  })
  await writeAchievementBatch(steamId, [first], new Map())

  let snapshot = await readProfileSnapshot(steamId)
  assert.equal(snapshot.games.find((game) => game.appid === '20').unlockedCount, 1)
  assert.equal(snapshot.games.find((game) => game.appid === '30').achievementSummaryStatus, 'unknown')

  const fallbackResult = makeGame(30, {
    status: 'complete',
    total: 3,
    unlocked: 2,
    tiers: { bronze: 2, silver: 0, gold: 0 },
    fallbackAttemptedAt: 1234,
  })
  await writeAchievementBatch(steamId, [fallbackResult], new Map())

  snapshot = await readProfileSnapshot(steamId)
  const persistedFallback = snapshot.games.find((game) => game.appid === '30')
  assert.equal(persistedFallback.achievementSummaryStatus, 'complete')
  assert.equal(persistedFallback.unlockedCount, 2)
  assert.equal(persistedFallback.achievementFallbackAttemptedAt, 1234)
})
