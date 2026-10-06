export async function runSequentialBatches(items, batchSize, processBatch) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError('Batch size must be a positive integer.')
  }
  let completed = 0
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize)
    await processBatch(batch, Math.floor(offset / batchSize))
    completed += batch.length
  }
  return completed
}

export async function runBoundedQueue(items, concurrency, processItem, onItemError = () => {}) {
  let nextIndex = 0
  const workerCount = Math.min(
    items.length,
    Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1,
  )
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex]
      nextIndex += 1
      try {
        await processItem(item)
      } catch (error) {
        await onItemError(item, error)
      }
    }
  })
  await Promise.all(workers)
}

export function selectStaleSummaryGames(games, isStale, now = Date.now()) {
  return games.filter((game) => isStale(game, now))
}

export function selectUnknownFallbackGames(games, now, ttl) {
  return games.filter((game) => {
    if (game.achievementSummaryStatus !== 'unknown') return false
    const attemptedAt = Number(game.achievementFallbackAttemptedAt) || 0
    return !attemptedAt || now - attemptedAt >= ttl
  })
}
