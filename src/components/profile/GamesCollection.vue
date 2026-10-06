<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ChevronLeft, ChevronRight, LayoutGrid, List } from '@lucide/vue'
import GameCard from './GameCard.vue'
import GameListRow from './GameListRow.vue'
import GamesToolbar from './GamesToolbar.vue'
import { useI18n } from '../../i18n'

const GAMES_VIEW_STORAGE_KEY = 'steam-trophies-games-view'

function readGamesViewPreference() {
  try {
    return window.localStorage.getItem(GAMES_VIEW_STORAGE_KEY) === 'list' ? 'list' : 'grid'
  } catch (error) {
    console.warn('Could not load games view preference:', error)
    return 'grid'
  }
}

const props = defineProps({
  games: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  error: { type: Boolean, default: false },
})
const emit = defineEmits(['select'])
const route = useRoute()
const { t } = useI18n()

const query = ref(typeof route.query.q === 'string' ? route.query.q : '')
const activeFilter = ref(typeof route.query.filter === 'string' ? route.query.filter : 'all')
const sortBy = ref(typeof route.query.sort === 'string' ? route.query.sort : 'recent')
const currentPage = ref(Math.max(1, Number(route.query.page) || 1))
const gamesView = ref(readGamesViewPreference())
const pageSize = 24

const filters = computed(() => [
  {
    key: 'all',
    label: t('profile.games.filters.all'),
    count: props.loading && !props.games.length ? null : props.games.length,
  },
  {
    key: 'played',
    label: t('profile.games.filters.played'),
    count: props.loading && !props.games.length ? null : props.games.filter((game) => Number(game.playtime_forever) > 0).length,
  },
  {
    key: 'progress',
    label: t('profile.games.filters.progress'),
    count: props.loading && !props.games.length ? null : props.games.filter((game) => game.achievementsAvailable !== false && game.unlockedCount > 0 && !game.isDiamond).length,
  },
  {
    key: 'completed',
    label: t('profile.games.filters.completed'),
    count: props.loading && !props.games.length ? null : props.games.filter((game) => game.isDiamond).length,
  },
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

function changePage(page) {
  currentPage.value = Math.min(totalPages.value, Math.max(1, page))
  document.querySelector('.games-collection')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function setGamesView(view) {
  if (view !== 'grid' && view !== 'list') return
  gamesView.value = view
  try {
    window.localStorage.setItem(GAMES_VIEW_STORAGE_KEY, view)
  } catch (error) {
    console.warn('Could not save games view preference:', error)
  }
}

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
      <div>
        <p class="profile-page__label">{{ $t('profile.games.privateArchive') }}</p>
        <h2 id="games-collection-title">{{ $t('profile.games.title') }}</h2>
        <p>{{ $t('profile.games.subtitle') }}</p>
      </div>
      <div class="games-archive-heading__tools">
        <div class="games-archive-heading__count">
          <strong>{{ displayCount ?? '—' }}</strong>
          <span>{{ $t('profile.games.gamesCount') }}</span>
        </div>
        <div class="games-view-toggle" role="group" :aria-label="$t('profile.games.viewModeAria')">
          <button
            type="button"
            :class="{ 'is-active': gamesView === 'grid' }"
            :aria-label="$t('profile.games.gridViewAria')"
            :aria-pressed="gamesView === 'grid'"
            @click="setGamesView('grid')"
          >
            <LayoutGrid :size="18" aria-hidden="true" />
          </button>
          <button
            type="button"
            :class="{ 'is-active': gamesView === 'list' }"
            :aria-label="$t('profile.games.listViewAria')"
            :aria-pressed="gamesView === 'list'"
            @click="setGamesView('list')"
          >
            <List :size="18" aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>

    <GamesToolbar
      v-model:query="query"
      v-model:filter="activeFilter"
      v-model:sort="sortBy"
      :filters="filters"
      :loading="loading"
    />

    <div v-if="loading" class="games-archive-state" role="status">
      <span class="games-archive-state__mark" />
      <p>{{ $t('profile.games.loadingTitle') }}</p>
      <small>{{ $t('profile.games.loadingDesc') }}</small>
    </div>
    <div v-else-if="error" class="games-archive-state">
      <p>{{ $t('profile.games.errorTitle') }}</p>
      <small>{{ $t('profile.games.errorDesc') }}</small>
    </div>
    <div v-else-if="!matchingGames.length" class="games-archive-state">
      <p>{{ $t('profile.games.emptyTitle') }}</p>
      <small>{{ $t('profile.games.emptyDesc') }}</small>
    </div>
    <template v-else>
      <div v-if="gamesView === 'grid'" class="archive-grid">
        <GameCard v-for="game in paginatedGames" :key="game.appid" :game="game" @select="openGame" />
      </div>
      <div v-else class="archive-list">
        <GameListRow v-for="game in paginatedGames" :key="game.appid" :game="game" @select="openGame" />
      </div>
      <footer class="games-archive-footer">
        <span>{{ $t('profile.games.showingRange', { start: rangeStart, end: rangeEnd, total: matchingGames.length.toLocaleString() }) }}</span>
        <nav v-if="totalPages > 1" class="games-pagination" :aria-label="$t('profile.games.pagesAria')">
          <button
            type="button"
            :disabled="currentPage === 1"
            :aria-label="$t('profile.games.prevPage')"
            @click="changePage(currentPage - 1)"
          >
            <ChevronLeft :size="16" />
          </button>
          <div class="games-pagination__pages">
            <button
              v-for="page in visiblePages"
              :key="page"
              type="button"
              :class="{ 'is-current': page === currentPage }"
              :aria-current="page === currentPage ? 'page' : undefined"
              @click="changePage(page)"
            >
              {{ page }}
            </button>
            <span v-if="totalPages > 5 && currentPage < totalPages - 2">…</span>
            <button
              v-if="totalPages > 5 && currentPage < totalPages - 2"
              type="button"
              @click="changePage(totalPages)"
            >
              {{ totalPages }}
            </button>
          </div>
          <button
            type="button"
            :disabled="currentPage === totalPages"
            :aria-label="$t('profile.games.nextPage')"
            @click="changePage(currentPage + 1)"
          >
            <ChevronRight :size="16" />
          </button>
        </nav>
      </footer>
    </template>
  </section>
</template>
