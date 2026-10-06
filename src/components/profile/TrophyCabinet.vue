<script setup>
import { computed } from 'vue'
import TrophyShelf from './TrophyShelf.vue'
import { getTrophyTier } from '../../data/trophyTiers.js'

const props = defineProps({
  trophies: { type: Array, default: () => [] },
  games: { type: Array, default: () => [] },
  status: { type: String, default: 'idle' },
})
defineEmits(['select-trophy', 'select-diamond', 'request-achievement-icons'])

const tierKeys = ['bronze', 'silver', 'gold']

function trophyTier(trophy) {
  return getTrophyTier(trophy.global_percent) || trophy.tier
}

const shelves = computed(() => ({
  bronze: props.trophies.filter((item) => trophyTier(item) === 'bronze'),
  silver: props.trophies.filter((item) => trophyTier(item) === 'silver'),
  gold: props.trophies.filter((item) => trophyTier(item) === 'gold'),
  diamond: props.games.filter((game) => game.isDiamond),
}))
</script>

<template>
  <section class="trophy-cabinet" aria-label="Trophy cabinet">
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
      :trophies="shelves[key]"
      :loading="status !== 'success'"
      @select="$emit('select-trophy', $event)"
      @request-achievement-icons="$emit('request-achievement-icons', $event)"
    />
    <TrophyShelf
      tier="diamond"
      :label="$t('profile.cabinet.diamond')"
      :trophies="shelves.diamond"
      :loading="status !== 'success'"
      diamonds
      @select-diamond="$emit('select-diamond', $event)"
    />
  </section>
</template>
