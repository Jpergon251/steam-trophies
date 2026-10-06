import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getKnownProfileStats,
  getProfileSummaryStatus,
  hasKnownAchievementSummary,
} from '../src/data/profileStats.js'

const completeGame = (appid, bronze = 0, silver = 0, gold = 0, total = 10, unlocked = 5) => ({
  appid: String(appid),
  achievementSummaryVersion: 1,
  tierCounts: { bronze, silver, gold },
  achievementCount: total,
  unlockedCount: unlocked,
})

test('all known summaries produce complete statistics', () => {
  const games = Array.from({ length: 164 }, (_, index) =>
    completeGame(index, 3, 2, 1),
  )

  assert.deepEqual(getKnownProfileStats(games), {
    bronze: 492,
    silver: 328,
    gold: 164,
    completed: 0,
    knownGames: 164,
    unknownGames: 0,
  })
  assert.equal(getProfileSummaryStatus(games, { profileLoaded: true, syncing: false }), 'complete')
})

test('partial summaries count only known games and report unknown games', () => {
  const knownGames = Array.from({ length: 73 }, (_, index) =>
    completeGame(index, 1, 2, 3),
  )
  const unknownGames = Array.from({ length: 91 }, (_, index) => ({
    appid: String(1000 + index),
    achievementSummaryVersion: 0,
    tierCounts: { bronze: 0, silver: 0, gold: 0 },
    achievementCount: null,
    unlockedCount: null,
    isDiamond: false,
  }))
  const games = [...knownGames, ...unknownGames]

  assert.deepEqual(getKnownProfileStats(games), {
    bronze: 73,
    silver: 146,
    gold: 219,
    completed: 0,
    knownGames: 73,
    unknownGames: 91,
  })
  assert.equal(getProfileSummaryStatus(games, { profileLoaded: true, syncing: false }), 'partial')
})

test('zero summaries after loading is an error/unknown state', () => {
  const games = [{ appid: '1', achievementSummaryVersion: 0 }]

  assert.equal(getProfileSummaryStatus(games, { profileLoaded: true, syncing: false }), 'error')
  assert.equal(getProfileSummaryStatus(games, { profileLoaded: true, syncing: true }), 'loading')
})

test('a fully unlocked known game is Diamond', () => {
  const stats = getKnownProfileStats([completeGame(1, 2, 3, 1, 6, 6)])

  assert.equal(stats.completed, 1)
})

test('unknown games contribute no tiers or Diamond count', () => {
  const unknown = {
    appid: '1',
    achievementSummaryVersion: 0,
    achievementsDetailsComplete: false,
    tierCounts: { bronze: 99, silver: 99, gold: 99, diamond: 1 },
    achievementCount: null,
    unlockedCount: null,
    isDiamond: true,
  }

  assert.equal(hasKnownAchievementSummary(unknown), false)
  assert.deepEqual(getKnownProfileStats([unknown]), {
    bronze: 0,
    silver: 0,
    gold: 0,
    completed: 0,
    knownGames: 0,
    unknownGames: 1,
  })
})

test('only games in the owned-games input contribute, not Steam Families extras', () => {
  const ownedGames = [completeGame(1, 2, 1, 0)]
  const steamFamilyGameNotOwned = completeGame(2, 500, 500, 500, 1, 1)
  const ownedStats = getKnownProfileStats(ownedGames)

  assert.deepEqual(ownedStats, {
    bronze: 2,
    silver: 1,
    gold: 0,
    completed: 0,
    knownGames: 1,
    unknownGames: 0,
  })
  assert.notDeepEqual(
    ownedStats,
    getKnownProfileStats([...ownedGames, steamFamilyGameNotOwned]),
  )
})
