<script setup>
import { computed } from 'vue'
import TrophyShelf from './TrophyShelf.vue'

const props = defineProps({
  trophies: { type: Array, default: () => [] },
  games: { type: Array, default: () => [] },
  status: { type: String, default: 'idle' },
  progress: { type: Object, default: () => ({ processed: 0, total: 0 }) },
})
defineEmits(['select-trophy', 'select-diamond'])

const tierKeys = ['bronze', 'silver', 'gold']

const shelves = computed(() => ({
  bronze: props.trophies.filter((item) => item.tier === 'bronze'),
  silver: props.trophies.filter((item) => item.tier === 'silver'),
  gold: props.trophies.filter((item) => item.tier === 'gold'),
  diamond: props.games.filter((game) => game.isDiamond),
}))
</script>

<template>
  <section class="trophy-cabinet" aria-label="Trophy cabinet">
    <p v-if="status === 'loading'" class="trophy-cabinet__loading" role="status">
      {{ $t('profile.cabinet.loading', { processed: progress.processed, total: progress.total }) }}
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
      :loading="status === 'loading'"
      @select="$emit('select-trophy', $event)"
    />
    <TrophyShelf
      tier="diamond"
      :label="$t('profile.cabinet.diamond')"
      :trophies="shelves.diamond"
      :loading="status === 'loading'"
      diamonds
      @select-diamond="$emit('select-diamond', $event)"
    />
  </section>
</template>
