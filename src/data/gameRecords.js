import { markRaw } from 'vue'

export function markRawGameRecord(game) {
  return markRaw(game)
}

export function replaceGameRecords(games, replacements) {
  const nextGames = games.slice()
  for (const [index, game] of replacements) {
    nextGames[index] = markRawGameRecord(game)
  }
  return nextGames
}
