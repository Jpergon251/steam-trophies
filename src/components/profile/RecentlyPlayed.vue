<script setup>
import SteamGameCard from "./SteamGameCard.vue";

defineProps({
  games: { type: Array, default: () => [] },
  status: { type: String, default: "idle" },
});
defineEmits(["select"]);
</script>

<template>
  <section class="recently-played" aria-labelledby="recently-played-title">
    <div class="profile-page__section-heading">
      <p class="profile-page__label">THE LATEST ACQUISITIONS</p>
      <h2 id="recently-played-title">Recently Played</h2>
    </div>
    <div v-if="status === 'loading'" class="profile-page__inline-state">
      Retrieving recent play history
    </div>
    <div v-else-if="status === 'error'" class="profile-page__inline-state">
      Recent games are unavailable right now.
    </div>
    <div v-else-if="!games.length" class="profile-page__inline-state">
      No recently played games to display.
    </div>
    <div v-else class="recently-played__list">
      <SteamGameCard
        v-for="game in games"
        :key="game.appid"
        :game="game"
        compact
        @select="$emit('select', $event)"
      />
    </div>
  </section>
</template>
