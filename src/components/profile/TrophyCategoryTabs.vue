<script setup>
defineProps({
  categories: { type: Array, required: true },
  selected: { type: String, required: true },
});
defineEmits(["select"]);
</script>

<template>
  <nav class="trophy-categories" aria-label="Trophy categories">
    <button
      v-for="category in categories"
      :key="category.key"
      type="button"
      class="trophy-category"
      :class="[
        `trophy-category--${category.key}`,
        { 'is-selected': selected === category.key },
      ]"
      :aria-pressed="selected === category.key"
      @click="$emit('select', category.key)"
    >
      <span class="trophy-category__name">{{ category.label }}</span>
      <span class="trophy-category__count">{{ category.count }}</span>
    </button>
  </nav>
</template>
