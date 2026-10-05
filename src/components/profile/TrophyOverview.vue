<script setup>
import TrophyCategoryTabs from "./TrophyCategoryTabs.vue";

defineProps({
  categories: { type: Array, required: true },
  selected: { type: String, required: true },
});
defineEmits(["select"]);
</script>

<template>
  <section class="trophy-overview" aria-labelledby="trophy-overview-title">
    <div class="profile-page__section-heading">
      <p class="profile-page__label">THE COLLECTION</p>
      <h2 id="trophy-overview-title">Trophy overview</h2>
    </div>
    <TrophyCategoryTabs
      :categories="categories"
      :selected="selected"
      @select="$emit('select', $event)"
    />
    <p class="trophy-overview__hint">
      Select a category to curate the display.
    </p>
  </section>
</template>
