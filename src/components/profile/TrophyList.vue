<script setup>
import TrophyItem from "./TrophyItem.vue";
defineProps({ trophies: { type: Array, default: () => [] } });
</script>

<template>
  <div class="trophy-list">
    <TrophyItem
      v-for="trophy in trophies"
      :key="trophy.apiname"
      :trophy="trophy"
    />
  </div>
</template>
