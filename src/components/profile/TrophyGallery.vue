<script setup>
import TrophyCard from "./TrophyCard.vue";
defineProps({ trophies: { type: Array, default: () => [] } });
defineEmits(["select"]);
</script>

<template>
  <div class="trophy-gallery">
    <TrophyCard
      v-for="trophy in trophies"
      :key="`${trophy.appid}-${trophy.apiname}`"
      :trophy="trophy"
      @select="$emit('select', $event)"
    />
  </div>
</template>
