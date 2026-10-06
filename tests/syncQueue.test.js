import test from 'node:test'
import assert from 'node:assert/strict'
import {
  runBoundedQueue,
  runSequentialBatches,
  selectStaleSummaryGames,
  selectUnknownFallbackGames,
} from '../src/data/syncQueue.js'

test('each batch finishes persistence before the next batch starts', async () => {
  const events = []
  const count = await runSequentialBatches([1, 2, 3, 4, 5], 2, async (batch, index) => {
    events.push(`request-${index}`)
    await Promise.resolve()
    events.push(`persist-${index}`)
  })

  assert.equal(count, 5)
  assert.deepEqual(events, [
    'request-0', 'persist-0',
    'request-1', 'persist-1',
    'request-2', 'persist-2',
  ])
})

test('an interruption leaves previously persisted batches intact', async () => {
  const persisted = []

  await assert.rejects(
    runSequentialBatches([1, 2, 3, 4, 5], 2, async (batch, index) => {
      if (index === 2) throw new Error('network interrupted')
      persisted.push(...batch)
    }),
    /network interrupted/,
  )

  assert.deepEqual(persisted, [1, 2, 3, 4])
})

test('fallback queue never exceeds its configured concurrency', async () => {
  let active = 0
  let maxActive = 0
  const handled = []
  await runBoundedQueue(Array.from({ length: 20 }, (_, index) => index), 2, async (item) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    handled.push(item)
    active -= 1
  })

  assert.equal(maxActive, 2)
  assert.equal(new Set(handled).size, 20)
})

test('one fallback error is recorded without stopping the remaining games', async () => {
  const handled = []
  const failures = []
  await runBoundedQueue(
    [1, 2, 3],
    2,
    async (item) => {
      if (item === 2) throw new Error('Steam unavailable')
      handled.push(item)
    },
    async (item, error) => failures.push([item, error.message]),
  )

  assert.deepEqual(handled.sort(), [1, 3])
  assert.deepEqual(failures, [[2, 'Steam unavailable']])
})

test('incremental sync selects stale summaries and only due unknown fallbacks', () => {
  const games = [
    { appid: '1', achievementSummaryStatus: 'complete', updatedAt: 100 },
    { appid: '2', achievementSummaryStatus: 'unknown', achievementFallbackAttemptedAt: 0 },
    { appid: '3', achievementSummaryStatus: 'unknown', achievementFallbackAttemptedAt: 950 },
    { appid: '4', achievementSummaryStatus: 'partial', achievementFallbackAttemptedAt: 0 },
    { appid: '5', achievementSummaryVersion: 0 },
  ]
  const stale = selectStaleSummaryGames(
    games,
    (game) => game.appid === '4' || game.appid === '5',
  )
  const fallback = selectUnknownFallbackGames(games, 1_000, 100)

  assert.deepEqual(stale.map((game) => game.appid), ['4', '5'])
  assert.deepEqual(fallback.map((game) => game.appid), ['2'])
})
