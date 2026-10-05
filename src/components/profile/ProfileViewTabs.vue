<script setup>
defineProps({ modelValue: { type: String, required: true } });
defineEmits(["update:modelValue"]);
</script>

<template>
  <nav class="profile-view-tabs" aria-label="Collection views" role="tablist">
    <button
      v-for="tab in [
        { key: 'display', label: 'Display' },
        { key: 'games', label: 'Games' },
      ]"
      :key="tab.key"
      class="profile-view-tabs__tab"
      :class="{ 'is-active': modelValue === tab.key }"
      type="button"
      role="tab"
      :aria-selected="modelValue === tab.key"
      @click="$emit('update:modelValue', tab.key)"
    >
      {{ tab.label }}
    </button>
  </nav>
</template>
