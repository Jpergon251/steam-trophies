<script setup>
import { computed } from 'vue'
import TrophyShelf from './TrophyShelf.vue'
import { hasKnownAchievementSummary } from '../../data/profileStats.js'

const props = defineProps({
  games: { type: Array, default: () => [] },
  loadTrophyWindow: { type: Function, default: null },
  status: { type: String, default: 'idle' },
})
defineEmits(['select-trophy', 'select-diamond', 'request-achievement-icons'])

const tierKeys = ['bronze', 'silver', 'gold']

const diamondGames = computed(() => props.games.filter((game) => {
  if (!hasKnownAchievementSummary(game)) return false
  const total = Number(game.achievementCount ?? game.totalAchievements) || 0
  const unlocked = Number(game.unlockedCount ?? game.unlockedAchievements) || 0
  return total > 0 && unlocked === total
}))
const tierCounts = computed(() => props.games.reduce((counts, game) => {
  if (!hasKnownAchievementSummary(game)) return counts
  counts.bronze += Number(game.tierCounts?.bronze) || 0
  counts.silver += Number(game.tierCounts?.silver) || 0
  counts.gold += Number(game.tierCounts?.gold) || 0
  return counts
}, { bronze: 0, silver: 0, gold: 0 }))

function loadWindow(tier, start, end) {
  return props.loadTrophyWindow?.(tier, start, end) || Promise.resolve([])
}
</script>

<template>
  <section class="trophy-cabinet" :aria-label="$t('profile.cabinet.title')">
    <p v-if="status === 'loading'" class="trophy-cabinet__loading" role="status">
      {{ $t('profile.cabinet.loading') }}
    </p>
    <p v-else-if="status === 'error'" class="profile-page__inline-state">
      {{ $t('profile.cabinet.error') }}
    </p>
    <TrophyShelf
      v-for="key in tierKeys"
      :key="key"
      :tier="key"
      :label="$t(`profile.cabinet.${key}`)"
      :total-count="tierCounts[key]"
      :load-window="(start, end) => loadWindow(key, start, end)"
      :loading="status === 'loading'"
      @select="$emit('select-trophy', $event)"
      @request-achievement-icons="$emit('request-achievement-icons', $event)"
    />
    <TrophyShelf
      tier="diamond"
      :label="$t('profile.cabinet.diamond')"
      :trophies="diamondGames"
      :loading="status === 'loading'"
      diamonds
      @select-diamond="$emit('select-diamond', $event)"
    />
  </section>
</template>
