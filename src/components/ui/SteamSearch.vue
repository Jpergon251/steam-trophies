<template>
  <form class="steam-search" role="search" @submit.prevent="submitSearch">
    <div
      class="steam-search__field"
      :class="{ 'steam-search__field--filled': query }"
    >
      <Search
        class="steam-search__icon"
        :size="19"
        :stroke-width="1.7"
        aria-hidden="true"
      />
      <input
        v-model="query"
        class="steam-search__input"
        type="search"
        name="steam-profile"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        :placeholder="$t('landing.searchPlaceholder')"
        :aria-label="$t('landing.searchPlaceholder')"
        :disabled="loading"
      />
      <button
        class="steam-search__submit"
        type="submit"
        :aria-label="$t('landing.searchSubmit')"
        :disabled="loading"
      >
        <ArrowUpRight :size="18" :stroke-width="1.8" aria-hidden="true" />
      </button>
    </div>
    <p class="steam-search__hint" aria-live="polite">
      <template v-if="loading">{{ $t("landing.searching") }}</template>
      <template v-else>
        {{ $t("landing.searchHintBefore") }}
        <kbd>Enter</kbd>
        {{ $t("landing.searchHintAfter") }}
      </template>
    </p>
  </form>
</template>

<script setup>
import { ref } from "vue";
import { ArrowUpRight, Search } from "@lucide/vue";

defineProps({
  loading: {
    type: Boolean,
    default: false,
  },
});
const emit = defineEmits(["submit"]);
const query = ref("");

function submitSearch() {
  const value = query.value.trim();
  if (value) emit("submit", value);
}
</script>
