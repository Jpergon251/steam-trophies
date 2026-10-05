<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import GameCard from './GameCard.vue'
import GamesToolbar from './GamesToolbar.vue'

const props = defineProps({ games: { type: Array, default: () => [] }, loading: { type: Boolean, default: false }, error: { type: Boolean, default: false } })
const emit = defineEmits(['select'])
const route = useRoute()
const query = ref(typeof route.query.q === 'string' ? route.query.q : '')
const activeFilter = ref(typeof route.query.filter === 'string' ? route.query.filter : 'all')
const sortBy = ref(typeof route.query.sort === 'string' ? route.query.sort : 'recent')
const currentPage = ref(Math.max(1, Number(route.query.page) || 1))
const pageSize = 24
const filters = computed(() => [
  { key: 'all', label: 'All', count: props.loading && !props.games.length ? null : props.games.length },
  { key: 'played', label: 'Played', count: props.loading && !props.games.length ? null : props.games.filter((game) => Number(game.playtime_forever) > 0).length },
  { key: 'progress', label: 'In progress', count: props.loading && !props.games.length ? null : props.games.filter((game) => game.achievementsAvailable !== false && game.unlockedCount > 0 && !game.isDiamond).length },
  { key: 'completed', label: 'Completed', count: props.loading && !props.games.length ? null : props.games.filter((game) => game.isDiamond).length },
])
const matchingGames = computed(() => {
  const search = query.value.trim().toLocaleLowerCase()
  let result = props.games.filter((game) => !search || game.name.toLocaleLowerCase().includes(search))
  if (activeFilter.value === 'played') result = result.filter((game) => Number(game.playtime_forever) > 0)
  if (activeFilter.value === 'progress') result = result.filter((game) => game.achievementsAvailable !== false && game.unlockedCount > 0 && !game.isDiamond)
  if (activeFilter.value === 'completed') result = result.filter((game) => game.isDiamond)
  return [...result].sort((a, b) => {
    if (sortBy.value === 'alphabetical') return a.name.localeCompare(b.name)
    if (sortBy.value === 'trophies') return b.unlockedCount - a.unlockedCount || a.name.localeCompare(b.name)
    if (sortBy.value === 'completion') return b.progress - a.progress || a.name.localeCompare(b.name)
    if (sortBy.value === 'playtime') return (b.playtime_forever || 0) - (a.playtime_forever || 0) || a.name.localeCompare(b.name)
    const recentlyPlayed = (b.rtime_last_played || 0) - (a.rtime_last_played || 0)
    return recentlyPlayed || (b.playtime_forever || 0) - (a.playtime_forever || 0) || a.name.localeCompare(b.name)
  })
})
const totalPages = computed(() => Math.ceil(matchingGames.value.length / pageSize))
const displayCount = computed(() => props.loading && !props.games.length ? null : props.games.length.toLocaleString())
const paginatedGames = computed(() => matchingGames.value.slice((currentPage.value - 1) * pageSize, currentPage.value * pageSize))
const visiblePages = computed(() => {
  const pages = totalPages.value
  if (pages <= 5) return Array.from({ length: pages }, (_, i) => i + 1)
  let start = Math.max(1, currentPage.value - 2)
  const end = Math.min(pages, start + 4)
  start = Math.max(1, end - 4)
  return Array.from({ length: end - start + 1 }, (_, i) => start + i)
})
const rangeStart = computed(() => matchingGames.value.length ? (currentPage.value - 1) * pageSize + 1 : 0)
const rangeEnd = computed(() => Math.min(currentPage.value * pageSize, matchingGames.value.length))
watch([query, activeFilter, sortBy], () => { currentPage.value = 1 })
watch(totalPages, (pages) => { if (pages > 0 && currentPage.value > pages) currentPage.value = pages })
function changePage(page) { currentPage.value = Math.min(totalPages.value, Math.max(1, page)); document.querySelector('.games-collection')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
function openGame(game) {
  emit('select', {
    game,
    context: {
      q: query.value,
      filter: activeFilter.value,
      sort: sortBy.value,
      page: String(currentPage.value),
    },
  })
}
</script>

<template>
  <section class="games-collection" aria-labelledby="games-collection-title">
    <header class="games-archive-heading">
      <div><p class="profile-page__label">PRIVATE ARCHIVE</p><h2 id="games-collection-title">Your collection</h2><p>Explore your complete game library</p></div>
      <div class="games-archive-heading__count"><strong>{{ displayCount ?? '—' }}</strong><span>GAMES</span></div>
    </header>
    <GamesToolbar v-model:query="query" v-model:filter="activeFilter" v-model:sort="sortBy" :filters="filters" :loading="loading" />
    <div v-if="loading" class="games-archive-state" role="status"><span class="games-archive-state__mark" /><p>Building your collection</p><small>Steam library and achievements are being catalogued</small></div>
    <div v-else-if="error" class="games-archive-state"><p>We couldn’t open this archive</p><small>Your game library is unavailable right now. Please try again later.</small></div>
    <div v-else-if="!matchingGames.length" class="games-archive-state"><p>No games found</p><small>Try another title or change your filters.</small></div>
    <template v-else>
      <div class="archive-grid"><GameCard v-for="game in paginatedGames" :key="game.appid" :game="game" @select="openGame" /></div>
      <footer class="games-archive-footer">
        <span>Showing {{ rangeStart }}–{{ rangeEnd }} of {{ matchingGames.length.toLocaleString() }}</span>
        <nav v-if="totalPages > 1" class="games-pagination" aria-label="Games pages">
          <button type="button" :disabled="currentPage === 1" aria-label="Previous page" @click="changePage(currentPage - 1)"><ChevronLeft :size="16" /></button>
          <div class="games-pagination__pages"><button v-for="page in visiblePages" :key="page" type="button" :class="{ 'is-current': page === currentPage }" :aria-current="page === currentPage ? 'page' : undefined" @click="changePage(page)">{{ page }}</button><span v-if="totalPages > 5 && currentPage < totalPages - 2">…</span><button v-if="totalPages > 5 && currentPage < totalPages - 2" type="button" @click="changePage(totalPages)">{{ totalPages }}</button></div>
          <button type="button" :disabled="currentPage === totalPages" aria-label="Next page" @click="changePage(currentPage + 1)"><ChevronRight :size="16" /></button>
        </nav>
      </footer>
    </template>
  </section>
</template>
