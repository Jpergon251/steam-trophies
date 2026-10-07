<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Diamond, LockKeyhole, Search, Trophy } from '@lucide/vue'
import { getTrophyTier } from '../data/trophyTiers.js'
import { onBeforeRouteLeave, RouterLink, useRoute } from 'vue-router'
import { useSteamProfilesStore } from '../stores/steamProfiles.js'
import { useI18n } from '../i18n'

const route = useRoute()
const steamStore = useSteamProfilesStore()
const { t } = useI18n()

const steamId = computed(() => String(route.params.steamId || ''))
const appid = computed(() => String(route.params.appid || ''))
const profileState = computed(() => steamStore.profiles[steamId.value])
const profile = computed(() => steamStore.profileFor(steamId.value))
const game = computed(() => steamStore.gamesFor(steamId.value).find((item) => String(item.appid) === appid.value) || null)
const detailsPending = ref(false)
const detailsError = ref(null)
const failedAchievementIcons = ref(new Set())
const isLoading = computed(() => {
  if (detailsPending.value) return true
  if (game.value) return !game.value.achievementsDetailsComplete && !detailsError.value
  if (!profileState.value?.hydratedAt) return !steamStore.errorFor(steamId.value)
  return Boolean(steamStore.syncs[steamId.value]?.active && steamStore.syncs[steamId.value]?.phase === 'library')
})
const loadError = computed(() => detailsError.value || steamStore.errorFor(steamId.value))
const sync = computed(() => steamStore.syncs[steamId.value] || null)
const achievements = computed(() => game.value?.achievements || [])
const isUnlocked = (achievement) => achievement.achieved === true || Number(achievement.achieved) === 1
const achievementTier = (achievement) => getTrophyTier(achievement.global_percent) || 'unclassified'
const counts = computed(() => {
  const total = Number(game.value?.achievementCount) || 0
  const unlocked = Number(game.value?.unlockedCount) || 0
  return { total, unlocked, locked: Math.max(0, total - unlocked) }
})
const completion = computed(() => counts.value.total ? Math.round(counts.value.unlocked / counts.value.total * 1000) / 10 : 0)
const isDiamond = computed(() => counts.value.total > 0 && counts.value.unlocked === counts.value.total)
const unlockedTierCounts = computed(() => {
  const totals = { bronze: 0, silver: 0, gold: 0 }
  achievements.value.filter(isUnlocked).forEach((achievement) => {
    const tier = achievementTier(achievement)
    if (totals[tier] !== undefined) totals[tier] += 1
  })
  return totals
})
const artworkStyle = computed(() => {
  const url = game.value?.headerUrl || game.value?.coverUrl
  return url ? { '--game-artwork': `url("${url}")` } : undefined
})
const hasGlobalRarity = (achievement) => achievement.global_percent !== null && achievement.global_percent !== undefined && Number.isFinite(Number(achievement.global_percent))
const activeFilter = ref('all')
const search = ref('')
const sortBy = ref('steam')
const currentPage = ref(1)
const pageSize = 100

const filterOptions = computed(() => [
  { key: 'all', label: t('game.filters.all'), count: counts.value.total },
  { key: 'unlocked', label: t('game.filters.unlocked'), count: counts.value.unlocked },
  { key: 'locked', label: t('game.filters.locked'), count: counts.value.locked },
])

const sortOptions = computed(() => [
  { value: 'steam', label: t('game.sortOptions.steam') },
  { value: 'name-asc', label: t('game.sortOptions.nameAsc') },
  { value: 'name-desc', label: t('game.sortOptions.nameDesc') },
  { value: 'common', label: t('game.sortOptions.common') },
  { value: 'rare', label: t('game.sortOptions.rare') },
  { value: 'recent', label: t('game.sortOptions.recent') },
  { value: 'oldest', label: t('game.sortOptions.oldest') },
  { value: 'locked-first', label: t('game.sortOptions.lockedFirst') },
  { value: 'unlocked-first', label: t('game.sortOptions.unlockedFirst') },
])

const visibleAchievements = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  const filtered = achievements.value.filter((achievement) => {
    const unlocked = isUnlocked(achievement)
    if (activeFilter.value === 'unlocked' && !unlocked) return false
    if (activeFilter.value === 'locked' && unlocked) return false
    if (!query) return true
    return `${achievement.name || ''} ${achievement.description || ''}`.toLocaleLowerCase().includes(query)
  })
  if (sortBy.value === 'steam') return filtered
  const sourceOrder = new Map(achievements.value.map((achievement, index) => [achievement.apiname || `${achievement.name}-${index}`, index]))
  const originalIndex = (achievement) => sourceOrder.get(achievement.apiname || `${achievement.name}-${achievements.value.indexOf(achievement)}`) ?? 0
  return [...filtered].sort((a, b) => {
    const name = (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
    const rarityA = Number(a.global_percent)
    const rarityB = Number(b.global_percent)
    const hasRarityA = hasGlobalRarity(a)
    const hasRarityB = hasGlobalRarity(b)
    const unlockA = Number(a.unlocktime) || 0
    const unlockB = Number(b.unlocktime) || 0
    const unlockedA = isUnlocked(a)
    const unlockedB = isUnlocked(b)

    if (sortBy.value === 'name-asc') return name || originalIndex(a) - originalIndex(b)
    if (sortBy.value === 'name-desc') return -name || originalIndex(a) - originalIndex(b)
    if (sortBy.value === 'common' || sortBy.value === 'rare') {
      if (hasRarityA !== hasRarityB) return hasRarityA ? -1 : 1
      const rarityOrder = sortBy.value === 'rare' ? rarityA - rarityB : rarityB - rarityA
      return rarityOrder || originalIndex(a) - originalIndex(b)
    }
    if (sortBy.value === 'recent' || sortBy.value === 'oldest') {
      if (unlockedA !== unlockedB) return unlockedA ? -1 : 1
      const unlockOrder = sortBy.value === 'recent' ? unlockB - unlockA : unlockA - unlockB
      return unlockOrder || originalIndex(a) - originalIndex(b)
    }
    if (sortBy.value === 'locked-first') return Number(unlockedA) - Number(unlockedB) || originalIndex(a) - originalIndex(b)
    if (sortBy.value === 'unlocked-first') return Number(unlockedB) - Number(unlockedA) || originalIndex(a) - originalIndex(b)
    return originalIndex(a) - originalIndex(b)
  })
})

const totalPages = computed(() => Math.ceil(visibleAchievements.value.length / pageSize))
const paginatedAchievements = computed(() => visibleAchievements.value.slice(
  (currentPage.value - 1) * pageSize,
  currentPage.value * pageSize,
))

watch([activeFilter, search, sortBy], () => {
  currentPage.value = 1
})

watch(totalPages, (pages) => {
  if (pages > 0 && currentPage.value > pages) currentPage.value = pages
})

function changeAchievementPage(page) {
  currentPage.value = Math.min(totalPages.value, Math.max(1, page))
  document.querySelector('.achievement-archive')?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  })
}

const backQuery = computed(() => {
  const query = { view: 'games' }
  for (const key of ['q', 'filter', 'sort', 'page']) {
    const value = route.query[key]
    if (typeof value === 'string' && value) query[key] = value
  }
  return query
})

watch([steamId, appid], async ([id, gameId]) => {
  if (!id) return
  detailsError.value = null
  detailsPending.value = true
  try {
    if (!steamStore.profiles[id]?.hydratedAt) await steamStore.loadProfile(id)
    await steamStore.loadGameAchievementDetails(id, gameId)
  } catch (error) {
    detailsError.value = error
  } finally {
    detailsPending.value = false
  }
}, { immediate: true })

onBeforeRouteLeave((to) => {
  const nextSteamId = String(to.params.steamId || '')
  if (nextSteamId !== steamId.value) steamStore.cancelProfileSync(steamId.value)
})

onBeforeUnmount(() => {
  steamStore.evictGameDetails(steamId.value)
})

watch(appid, () => {
  activeFilter.value = 'all'
  search.value = ''
  sortBy.value = 'steam'
  currentPage.value = 1
  failedAchievementIcons.value = new Set()
})

function achievementIconFailed(achievement, index) {
  const key = achievement.apiname || `${achievement.name}-${index}`
  return failedAchievementIcons.value.has(key)
}

function markAchievementIconFailed(achievement, index) {
  const key = achievement.apiname || `${achievement.name}-${index}`
  failedAchievementIcons.value = new Set(failedAchievementIcons.value).add(key)
}
</script>

<template>
  <main class="game-page">
    <div class="game-page__ambient" aria-hidden="true" />
    <div class="game-page__shell">
      <div v-if="isLoading" class="game-page__state" role="status">
        {{ $t('game.loadingArchive') }}
      </div>

      <section v-else-if="!game || detailsError" class="game-page__state" :role="loadError ? 'alert' : 'status'">
        <Trophy :size="26" :stroke-width="1.2" aria-hidden="true" />
        <h1>{{ loadError ? $t('game.archiveUnavailable') : $t('game.gameNotFound') }}</h1>
        <p>{{ loadError ? $t('game.errorRefresh') : $t('game.removedFromLibrary') }}</p>
        <RouterLink class="game-page__state-link" :to="{ name: 'profile', params: { steamId }, query: backQuery }">
          {{ $t('game.returnToGames') }}
        </RouterLink>
      </section>

      <template v-else>
        <header class="game-archive-header" :class="{ 'game-archive-header--diamond': isDiamond }" :style="artworkStyle">
          <div class="game-archive-header__backdrop" aria-hidden="true" />
          <div class="game-archive-header__inner">
            <RouterLink class="game-page__back" :to="{ name: 'profile', params: { steamId }, query: backQuery }">
              <ArrowLeft :size="17" aria-hidden="true" /> {{ $t('game.backToGames') }}
            </RouterLink>
            <div class="game-archive-header__content">
              <p class="game-page__eyebrow">{{ $t('game.eyebrow', { name: profile?.personaname || $t('game.defaultPlayer') }) }}</p>
              <h1>{{ game.name }}</h1>
              <div class="game-archive-header__completion">
                <strong>{{ completion }}<span>%</span></strong>
                <div class="game-archive-header__completion-info">
                  <span v-if="isDiamond" class="game-archive-header__diamond"><Diamond :size="15" fill="currentColor" /> {{ $t('game.diamondAchieved') }}</span>
                  <span v-else>{{ $t('game.achievementsRemaining', { count: counts.locked }) }}</span>
                  <span class="game-archive-header__count">{{ counts.unlocked }} / {{ counts.total }} {{ $t('game.achievementsShort') }}</span>
                </div>
              </div>
              <div class="game-archive-header__progress" role="progressbar" :aria-valuenow="completion" aria-valuemin="0" aria-valuemax="100" :aria-label="$t('profile.games.completionPercentAria', { name: game.name, percent: completion })">
                <span :class="{ 'is-diamond': isDiamond }" :style="{ width: `${completion}%` }" />
              </div>
              <p v-if="sync?.active" class="game-archive-header__updating">{{ $t('game.updatingAchievements') }}</p>
              <div v-if="isDiamond" class="game-diamond-exhibit" :aria-label="$t('game.diamondAchieved')">
                <span class="game-diamond-exhibit__aura" aria-hidden="true" />
                <span class="game-diamond-exhibit__medal" aria-hidden="true"><Diamond :size="24" fill="currentColor" :stroke-width="1.35" /></span>
                <span class="game-diamond-exhibit__copy">
                  <strong>{{ $t('game.diamondTrophy') }}</strong>
                  <small>{{ $t('game.perfectSet') }}</small>
                </span>
              </div>
              <p v-if="game.playtime_forever" class="game-archive-header__playtime">{{ $t('game.hoursPlayed', { hours: Math.round(game.playtime_forever / 60) }) }}</p>
            </div>
          </div>
        </header>

        <section class="game-progress-summary" :aria-label="$t('game.progress')">
          <div class="game-progress-summary__lead">
            <span class="game-page__eyebrow">{{ $t('game.progress') }}</span>
            <strong>{{ counts.unlocked }} <span>/ {{ counts.total }}</span></strong>
            <span class="game-progress-summary__caption">{{ $t('game.stats.unlocked') }}</span>
          </div>
          <div class="game-progress-summary__tiers" :aria-label="$t('game.trophyCollection')">
            <div class="game-tier game-tier--bronze"><Trophy :size="23" :stroke-width="1.8" aria-hidden="true" /><strong>{{ unlockedTierCounts.bronze }}</strong><span>{{ $t('game.tiers.bronze') }}</span></div>
            <div class="game-tier game-tier--silver"><Trophy :size="23" :stroke-width="1.8" aria-hidden="true" /><strong>{{ unlockedTierCounts.silver }}</strong><span>{{ $t('game.tiers.silver') }}</span></div>
            <div class="game-tier game-tier--gold"><Trophy :size="23" :stroke-width="1.8" aria-hidden="true" /><strong>{{ unlockedTierCounts.gold }}</strong><span>{{ $t('game.tiers.gold') }}</span></div>
            <div v-if="isDiamond" class="game-tier game-tier--diamond"><Diamond :size="23" fill="currentColor" aria-hidden="true"/><strong>1</strong><span>{{ $t('game.tiers.diamond') }}</span></div>
          </div>
          <div v-if="game.playtime_forever" class="game-progress-summary__playtime">
            <span class="game-page__eyebrow">{{ $t('game.playtime') }}</span>
            <strong>{{ $t('game.hoursPlayed', { hours: Math.round(game.playtime_forever / 60) }) }}</strong>
          </div>
        </section>

        <section class="achievement-archive" aria-labelledby="achievement-archive-title">
          <header class="achievement-archive__heading">
            <div>
              <p class="game-page__eyebrow">{{ $t('game.theCollection') }}</p>
              <h2 id="achievement-archive-title">{{ $t('game.achievementsTitle') }}</h2>
            </div>
            <p>{{ $t('game.summaryCount', { total: counts.total, unlocked: counts.unlocked, locked: counts.locked }) }}</p>
          </header>

          <div v-if="counts.total" class="achievement-toolbar">
            <nav class="achievement-filters" :aria-label="$t('game.filterAria')">
              <button
                v-for="filter in filterOptions"
                :key="filter.key"
                type="button"
                :class="{ 'is-active': activeFilter === filter.key }"
                :aria-pressed="activeFilter === filter.key"
                @click="activeFilter = filter.key"
              >
                {{ filter.label }} <span>{{ filter.count }}</span>
              </button>
            </nav>
            <label class="achievement-search">
              <Search :size="16" aria-hidden="true" />
              <input
                v-model="search"
                type="search"
                :placeholder="$t('game.searchPlaceholder')"
                :aria-label="$t('game.searchAria')"
              />
            </label>
            <label class="achievement-sort">
              <span>{{ $t('game.sortBy') }}</span>
              <select v-model="sortBy" :aria-label="$t('game.sortBy')">
                <option v-for="option in sortOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </label>
          </div>

          <div v-if="!counts.total" class="achievement-archive__empty">
            {{ $t('game.emptyNoAchievements') }}
          </div>
          <div v-else-if="!visibleAchievements.length" class="achievement-archive__empty">
            {{ $t('game.emptyNoMatch') }}
          </div>
          <ol v-else class="achievement-list">
            <li
              v-for="(achievement, index) in paginatedAchievements"
              :key="achievement.apiname || `${achievement.name}-${(currentPage - 1) * pageSize + index}`"
              class="achievement-row"
              :class="[`achievement-row--${achievementTier(achievement)}`, `trophy-tier--${achievementTier(achievement)}`, { 'achievement-row--locked': !isUnlocked(achievement) }]"
            >
              <Trophy
                class="achievement-row__tier-icon"
                :size="30"
                :stroke-width="1.5"
                :aria-label="$t(`game.tiers.${achievementTier(achievement)}`)"
                role="img"
              />
              <div class="achievement-row__icon-wrap">
                <img
                  v-if="achievement.icon && !achievementIconFailed(achievement, index)"
                  class="achievement-row__icon"
                  :src="achievement.icon"
                  :alt="$t('game.achievementIconAlt', { name: achievement.name })"
                  loading="lazy"
                  @error="markAchievementIconFailed(achievement, index)"
                />
                <Trophy v-else class="achievement-row__fallback" :size="38" :stroke-width="1.2" aria-hidden="true" />
                <span v-if="isUnlocked(achievement)" class="achievement-row__earned-mark" :aria-label="$t('profile.modal.unlocked')"><Check :size="14" /></span>
                <span v-else class="achievement-row__locked-mark" :aria-label="$t('profile.modal.lockedAria')"><LockKeyhole :size="13" /></span>
              </div>
              <div class="achievement-row__body">
                <div class="achievement-row__title-line">
                  <h3>{{ achievement.name || achievement.apiname }}</h3>
                  <span v-if="hasGlobalRarity(achievement)" class="achievement-row__rarity">
                    {{ Number(achievement.global_percent).toFixed(2) }}% · {{ $t(`game.tiers.${achievementTier(achievement)}`) }}
                  </span>
                </div>
                <p>{{ achievement.description || $t('game.noDescription') }}</p>
                <div class="achievement-row__meta">
                  <span v-if="isUnlocked(achievement)" class="achievement-row__unlocked">
                    <Check :size="14" /> {{ $t('game.obtained') }}<span v-if="achievement.unlocktime"> · {{ new Date(Number(achievement.unlocktime) * 1000).toLocaleDateString() }}</span>
                  </span>
                  <span v-else class="achievement-row__locked-label">
                    <LockKeyhole :size="13" /> {{ $t('game.stillLocked') }}
                  </span>
                  <span v-if="hasGlobalRarity(achievement)" class="achievement-row__rarity-mobile">
                    {{ Number(achievement.global_percent).toFixed(2) }}% · {{ $t(`game.tiers.${achievementTier(achievement)}`) }}
                  </span>
                </div>
              </div>
            </li>
          </ol>
          <nav
            v-if="totalPages > 1"
            class="achievement-pagination"
            :aria-label="$t('game.pagesAria')"
          >
            <button
              type="button"
              :disabled="currentPage === 1"
              :aria-label="$t('game.previousPage')"
              @click="changeAchievementPage(currentPage - 1)"
            >
              <ChevronLeft :size="16" />
            </button>
            <span>{{ $t('game.pageOf', { page: currentPage, total: totalPages }) }}</span>
            <button
              type="button"
              :disabled="currentPage === totalPages"
              :aria-label="$t('game.nextPage')"
              @click="changeAchievementPage(currentPage + 1)"
            >
              <ChevronRight :size="16" />
            </button>
          </nav>
        </section>
      </template>
    </div>
  </main>
</template>
