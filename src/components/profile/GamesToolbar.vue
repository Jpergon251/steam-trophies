<script setup>
import { Search } from '@lucide/vue'

defineProps({ query: { type: String, required: true }, filter: { type: String, required: true }, sort: { type: String, required: true }, filters: { type: Array, required: true }, loading: { type: Boolean, default: false } })
const emit = defineEmits(['update:query', 'update:filter', 'update:sort'])
</script>

<template>
  <div class="games-toolbar">
    <label class="games-search"><Search :size="17" aria-hidden="true" /><input :value="query" type="search" placeholder="Search your games..." aria-label="Search your games" @input="emit('update:query', $event.target.value)" /></label>
    <div class="games-toolbar__controls">
      <nav class="games-filters" aria-label="Filter games">
        <button v-for="option in filters" :key="option.key" type="button" :class="{ 'is-active': filter === option.key }" @click="emit('update:filter', option.key)">{{ option.label }}<span v-if="!loading">{{ option.count }}</span></button>
      </nav>
      <label class="games-sort"><span>Sort by</span><select :value="sort" aria-label="Sort games" @change="emit('update:sort', $event.target.value)"><option value="recent">Recently played</option><option value="trophies">Most trophies</option><option value="completion">Completion</option><option value="alphabetical">Alphabetical</option><option value="playtime">Playtime</option></select></label>
    </div>
  </div>
</template>
