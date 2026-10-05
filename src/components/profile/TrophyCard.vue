<script setup>
import { LockKeyhole, Trophy } from '@lucide/vue'
import { getTrophyTier } from '../../data/trophyTiers.js'

const props = defineProps({ trophy: { type: Object, required: true } })
defineEmits(['select'])
const isUnlocked = () => props.trophy.achieved === true || Number(props.trophy.achieved) === 1
</script>

<template>
  <button
    class="trophy-card"
    :class="[
      `trophy-card--${trophy.tier || getTrophyTier(trophy.global_percent) || 'unclassified'}`,
      { 'trophy-card--locked': !isUnlocked() },
    ]"
    type="button"
    @click="$emit('select', trophy)"
  >
    <img
      v-if="trophy.gameIcon"
      class="trophy-card__game-icon"
      :src="trophy.gameIcon"
      :alt="`${trophy.gameName} icon`"
    />
    <span class="trophy-card__icon-wrap">
      <img v-if="trophy.icon" class="trophy-card__achievement-icon" :src="trophy.icon" :alt="`${trophy.name} achievement icon`" loading="lazy" />
      <Trophy
        v-else
        class="trophy-card__trophy"
        :class="`trophy-card__trophy--${getTrophyTier(trophy.global_percent) || 'unclassified'}`"
        :size="74"
        :stroke-width="1.25"
        aria-hidden="true"
      />
    </span>
    <LockKeyhole v-if="!isUnlocked()" class="trophy-card__lock" :size="13" aria-label="Locked" />
    <small v-if="trophy.global_percent != null" class="trophy-card__rarity">{{ Number(trophy.global_percent).toFixed(1) }}%</small>
    <strong>{{ trophy.name }}</strong>
  </button>
</template>
