<script setup>
import { getTrophyTier } from "../../data/trophyTiers.js";
defineProps({ trophy: { type: Object, required: true } });
</script>

<template>
  <article
    class="trophy-item"
    :class="[
      `trophy-item--${getTrophyTier(trophy.global_percent) || 'unclassified'}`,
      { 'trophy-item--locked': !trophy.achieved },
    ]"
  >
    <img
      v-if="trophy.icon"
      :src="trophy.icon"
      :alt="trophy.name"
      class="trophy-item__icon"
    />
    <div class="trophy-item__content">
      <div class="trophy-item__heading">
        <h3>{{ trophy.name }}</h3>
        <span
          v-if="getTrophyTier(trophy.global_percent)"
          class="trophy-item__tier"
          >{{ getTrophyTier(trophy.global_percent) }}</span
        >
      </div>
      <p>{{ trophy.description || "No description available." }}</p>
      <small v-if="trophy.achieved && trophy.unlocktime"
        >Unlocked
        {{ new Date(trophy.unlocktime * 1000).toLocaleDateString() }}</small
      >
      <small v-else-if="trophy.global_percent != null"
        >{{ Number(trophy.global_percent).toFixed(1) }}% global unlock
        rate</small
      >
      <small v-else>Global rarity unavailable</small>
    </div>
  </article>
</template>
