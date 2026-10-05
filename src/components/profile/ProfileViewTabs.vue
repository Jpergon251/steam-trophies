<script setup>
defineProps({ modelValue: { type: String, required: true } });
defineEmits(["update:modelValue"]);
</script>

<template>
  <nav class="profile-view-tabs" aria-label="Collection views" role="tablist">
    <button
      v-for="tab in ['display', 'games']"
      :key="tab"
      class="profile-view-tabs__tab"
      :class="{ 'is-active': modelValue === tab }"
      type="button"
      role="tab"
      :aria-selected="modelValue === tab"
      @click="$emit('update:modelValue', tab)"
    >
      {{ $t(`profile.tabs.${tab}`) }}
    </button>
  </nav>
</template>
