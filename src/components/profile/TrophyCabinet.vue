<script setup>
import { computed } from 'vue'
import TrophyShelf from './TrophyShelf.vue'

const props = defineProps({ trophies: { type: Array, default: () => [] }, games: { type: Array, default: () => [] }, status: { type: String, default: 'idle' }, progress: { type: Object, default: () => ({ processed: 0, total: 0 }) } })
defineEmits(['select-trophy', 'select-diamond'])
const tiers = [
  { key: 'bronze', label: 'Bronze' },
  { key: 'silver', label: 'Silver' },
  { key: 'gold', label: 'Gold' },
]
const shelves = computed(() => ({
  bronze: props.trophies.filter((item) => item.tier === 'bronze'),
  silver: props.trophies.filter((item) => item.tier === 'silver'),
  gold: props.trophies.filter((item) => item.tier === 'gold'),
  diamond: props.games.filter((game) => game.isDiamond),
}))
</script>

<template>
  <section class="trophy-cabinet" aria-label="Trophy cabinet">
    <p v-if="status === 'loading'" class="trophy-cabinet__loading" role="status">Cataloguing your collection · {{ progress.processed }} / {{ progress.total }} games</p>
    <p v-else-if="status === 'error'" class="profile-page__inline-state">Some trophy data could not be loaded.</p>
    <TrophyShelf v-for="tier in tiers" :key="tier.key" :tier="tier.key" :label="tier.label" :trophies="shelves[tier.key]" :loading="status === 'loading'" @select="$emit('select-trophy', $event)" />
    <TrophyShelf tier="diamond" label="Diamond" :trophies="shelves.diamond" :loading="status === 'loading'" diamonds @select-diamond="$emit('select-diamond', $event)" />
  </section>
</template>
