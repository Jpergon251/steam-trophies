export function hasKnownAchievementSummary(game) {
  if (game?.achievementSummaryStatus === 'unknown') return false
  return (
    game?.achievementSummaryStatus === 'complete' ||
    game?.achievementSummaryStatus === 'partial' ||
    [1, 2].includes(Number(game?.achievementSummaryVersion)) ||
    game?.achievementsDetailsComplete === true
  )
}

export function getKnownProfileStats(games = []) {
  const stats = {
    bronze: 0,
    silver: 0,
    gold: 0,
    completed: 0,
    knownGames: 0,
    unknownGames: 0,
  }

  for (const game of games) {
    if (!hasKnownAchievementSummary(game)) {
      stats.unknownGames += 1
      continue
    }

    stats.knownGames += 1
    const tiers = game.tierCounts || game.trophyCounts || {}
    stats.bronze += Number(tiers.bronze) || 0
    stats.silver += Number(tiers.silver) || 0
    stats.gold += Number(tiers.gold) || 0

    const total = Number(game.achievementCount ?? game.totalAchievements) || 0
    const unlocked = Number(game.unlockedCount ?? game.unlockedAchievements) || 0
    if (total > 0 && unlocked === total) stats.completed += 1
  }

  return stats
}

export function getProfileSummaryStatus(games, { profileLoaded, syncing }) {
  const stats = getKnownProfileStats(games)
  if (!profileLoaded) return syncing ? 'loading' : 'error'
  if (stats.unknownGames === 0) return 'complete'
  if (stats.knownGames > 0) return 'partial'
  return syncing ? 'loading' : 'error'
}
