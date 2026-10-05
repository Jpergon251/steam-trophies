<script setup>
import { Search } from '@lucide/vue'

defineProps({
  query: { type: String, required: true },
  filter: { type: String, required: true },
  sort: { type: String, required: true },
  filters: { type: Array, required: true },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['update:query', 'update:filter', 'update:sort'])
</script>

<template>
  <div class="games-toolbar">
    <label class="games-search">
      <Search :size="17" aria-hidden="true" />
      <input
        :value="query"
        type="search"
        :placeholder="$t('profile.games.searchPlaceholder')"
        :aria-label="$t('profile.games.searchAria')"
        @input="emit('update:query', $event.target.value)"
      />
    </label>
    <div class="games-toolbar__controls">
      <nav class="games-filters" :aria-label="$t('profile.games.filterAria')">
        <button
          v-for="option in filters"
          :key="option.key"
          type="button"
          :class="{ 'is-active': filter === option.key }"
          @click="emit('update:filter', option.key)"
        >
          {{ option.label }}
          <span v-if="!loading">{{ option.count }}</span>
        </button>
      </nav>
      <label class="games-sort">
        <span>{{ $t('profile.games.sortBy') }}</span>
        <select :value="sort" :aria-label="$t('profile.games.sortBy')" @change="emit('update:sort', $event.target.value)">
          <option value="recent">{{ $t('profile.games.sortOptions.recent') }}</option>
          <option value="trophies">{{ $t('profile.games.sortOptions.trophies') }}</option>
          <option value="completion">{{ $t('profile.games.sortOptions.completion') }}</option>
          <option value="alphabetical">{{ $t('profile.games.sortOptions.alphabetical') }}</option>
          <option value="playtime">{{ $t('profile.games.sortOptions.playtime') }}</option>
        </select>
      </label>
    </div>
  </div>
</template>
