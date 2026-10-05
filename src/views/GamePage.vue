<script setup>
import { computed, ref, watch } from 'vue'
import { ArrowLeft, Check, Diamond, LockKeyhole, Search, Trophy } from '@lucide/vue'
import { getTrophyTier } from '../data/trophyTiers.js'
import { RouterLink, useRoute } from 'vue-router'
import { useSteamProfilesStore } from '../stores/steamProfiles.js'

const route = useRoute()
const steamStore = useSteamProfilesStore()
const steamId = computed(() => String(route.params.steamId || ''))
const appid = computed(() => String(route.params.appid || ''))
const profileState = computed(() => steamStore.profiles[steamId.value])
const profile = computed(() => steamStore.profileFor(steamId.value))
const game = computed(() => steamStore.gamesFor(steamId.value).find((item) => String(item.appid) === appid.value) || null)
const isLoading = computed(() => {
  if (game.value) return false
  if (!profileState.value?.hydratedAt) return !steamStore.errorFor(steamId.value)
  return Boolean(steamStore.syncs[steamId.value]?.active && steamStore.syncs[steamId.value]?.phase === 'library')
})
const loadError = computed(() => steamStore.errorFor(steamId.value))
const sync = computed(() => steamStore.syncs[steamId.value] || null)
const achievements = computed(() => game.value?.achievements || [])
const isUnlocked = (achievement) => achievement.achieved === true || Number(achievement.achieved) === 1
const achievementTier = (achievement) => getTrophyTier(achievement.global_percent) || 'unclassified'
const counts = computed(() => {
  const unlocked = achievements.value.filter(isUnlocked).length
  return { total: achievements.value.length, unlocked, locked: achievements.value.length - unlocked }
})
const completion = computed(() => counts.value.total ? Math.round(counts.value.unlocked / counts.value.total * 1000) / 10 : 0)
const isDiamond = computed(() => counts.value.total > 0 && counts.value.unlocked === counts.value.total)
const hasGlobalRarity = (achievement) => achievement.global_percent !== null && achievement.global_percent !== undefined && Number.isFinite(Number(achievement.global_percent))
const rarestAchievement = computed(() => achievements.value.reduce((rarest, achievement) => {
  if (!hasGlobalRarity(achievement)) return rarest
  return !rarest || Number(achievement.global_percent) < Number(rarest.global_percent) ? achievement : rarest
}, null))

const activeFilter = ref('all')
const search = ref('')
const sortBy = ref('steam')
const filterOptions = computed(() => [
  { key: 'all', label: 'All', count: counts.value.total },
  { key: 'unlocked', label: 'Unlocked', count: counts.value.unlocked },
  { key: 'locked', label: 'Locked', count: counts.value.locked },
])
const sortOptions = [
  { value: 'steam', label: 'Default · Steam order' },
  { value: 'name-asc', label: 'Name · A to Z' },
  { value: 'name-desc', label: 'Name · Z to A' },
  { value: 'common', label: 'Rarity · Most common' },
  { value: 'rare', label: 'Rarity · Rarest first' },
  { value: 'recent', label: 'Recently unlocked' },
  { value: 'oldest', label: 'Oldest unlocked' },
  { value: 'locked-first', label: 'Locked first' },
  { value: 'unlocked-first', label: 'Unlocked first' },
]
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

const backQuery = computed(() => {
  const query = { view: 'games' }
  for (const key of ['q', 'filter', 'sort', 'page']) {
    const value = route.query[key]
    if (typeof value === 'string' && value) query[key] = value
  }
  return query
})

watch([steamId, appid], async ([id]) => {
  if (!id) return
  if (!steamStore.profiles[id]?.hydratedAt) await steamStore.loadProfile(id)
}, { immediate: true })
watch(appid, () => {
  activeFilter.value = 'all'
  search.value = ''
  sortBy.value = 'steam'
})
</script>

<template>
  <main class="game-page">
    <div class="game-page__ambient" aria-hidden="true" />
    <div class="game-page__shell">
      <RouterLink class="game-page__back" :to="{ name: 'profile', params: { steamId }, query: backQuery }">
        <ArrowLeft :size="16" aria-hidden="true" /> Back to games
      </RouterLink>

      <div v-if="isLoading" class="game-page__state" role="status">Loading your cached game archive…</div>
      <section v-else-if="!game" class="game-page__state" :role="loadError ? 'alert' : 'status'">
        <Trophy :size="26" :stroke-width="1.2" aria-hidden="true" />
        <h1>{{ loadError ? 'Game archive unavailable' : 'Game not found in this archive' }}</h1>
        <p>{{ loadError ? 'Steam could not refresh this profile right now.' : 'This game may have been removed from the profile’s current Steam library.' }}</p>
        <RouterLink class="game-page__state-link" :to="{ name: 'profile', params: { steamId }, query: backQuery }">Return to games</RouterLink>
      </section>

      <template v-else>
        <header class="game-archive-header" :style="game.headerUrl ? { '--game-artwork': `url(${game.headerUrl})` } : game.coverUrl ? { '--game-artwork': `url(${game.coverUrl})` } : undefined">
          <div class="game-archive-header__content">
            <p class="game-page__eyebrow">DIGITAL TROPHY ARCHIVE · {{ profile?.personaname || 'STEAM PLAYER' }}</p>
            <h1>{{ game.name }}</h1>
            <p class="game-archive-header__playtime" v-if="game.playtime_forever">{{ Math.round(game.playtime_forever / 60) }} hours played</p>
            <div class="game-archive-header__status">
              <span v-if="isDiamond" class="game-archive-header__diamond"><Diamond :size="15" /> Diamond achieved</span>
              <span v-else>{{ counts.locked }} achievements remaining</span>
              <span v-if="sync?.active" class="game-archive-header__updating">Updating achievements…</span>
            </div>
            <div class="game-archive-header__progress" role="progressbar" :aria-valuenow="completion" aria-valuemin="0" aria-valuemax="100" :aria-label="`${game.name} achievement completion`">
              <span :class="{ 'is-diamond': isDiamond }" :style="{ width: `${completion}%` }" />
            </div>
            <div v-if="isDiamond" class="game-diamond-exhibit" aria-label="Diamond trophy achieved">
              <span class="game-diamond-exhibit__aura" aria-hidden="true" />
              <span class="game-diamond-exhibit__medal" aria-hidden="true">
                <Diamond :size="24" :stroke-width="1.35" />
                <span class="game-diamond-exhibit__seal"><Diamond :size="9" fill="currentColor" /></span>
              </span>
              <span class="game-diamond-exhibit__copy"><strong>Diamond trophy</strong><small>Perfect set · 100% complete</small></span>
            </div>
          </div>
          <div class="game-archive-header__stats">
            <div><strong>{{ counts.unlocked }}</strong><span>UNLOCKED</span></div>
            <div><strong>{{ counts.total }}</strong><span>TOTAL</span></div>
            <div><strong>{{ counts.locked }}</strong><span>LOCKED</span></div>
            <div><strong>{{ completion }}%</strong><span>COMPLETE</span></div>
            <div v-if="rarestAchievement"><strong>{{ Number(rarestAchievement.global_percent).toFixed(1) }}%</strong><span>RAREST</span></div>
          </div>
        </header>

        <section class="achievement-archive" aria-labelledby="achievement-archive-title">
          <header class="achievement-archive__heading">
            <div><p class="game-page__eyebrow">THE COLLECTION</p><h2 id="achievement-archive-title">Achievements</h2></div>
            <p>{{ counts.total }} total · {{ counts.unlocked }} unlocked · {{ counts.locked }} locked</p>
          </header>

          <div v-if="counts.total" class="achievement-toolbar">
            <nav class="achievement-filters" aria-label="Filter achievements">
              <button v-for="filter in filterOptions" :key="filter.key" type="button" :class="{ 'is-active': activeFilter === filter.key }" :aria-pressed="activeFilter === filter.key" @click="activeFilter = filter.key">{{ filter.label }} <span>{{ filter.count }}</span></button>
            </nav>
            <label class="achievement-search">
              <Search :size="16" aria-hidden="true" />
              <input v-model="search" type="search" placeholder="Search achievements…" aria-label="Search achievements by name or description" />
            </label>
            <label class="achievement-sort"><span>Sort by</span><select v-model="sortBy" aria-label="Sort achievements"><option v-for="option in sortOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          </div>

          <div v-if="!counts.total" class="achievement-archive__empty">NO ACHIEVEMENTS AVAILABLE</div>
          <div v-else-if="!visibleAchievements.length" class="achievement-archive__empty">No achievements match this search and filter.</div>
          <ol v-else class="achievement-list">
            <li v-for="(achievement, index) in visibleAchievements" :key="achievement.apiname || `${achievement.name}-${index}`" class="achievement-row" :class="[`achievement-row--${achievementTier(achievement)}`, { 'achievement-row--locked': !isUnlocked(achievement) }]">
              <div class="achievement-row__icon-wrap">
                <img v-if="achievement.icon" class="achievement-row__icon" :src="achievement.icon" :alt="`${achievement.name} icon`" loading="lazy" />
                <Trophy v-else class="achievement-row__fallback" :size="38" :stroke-width="1.2" aria-hidden="true" />
                <span v-if="isUnlocked(achievement)" class="achievement-row__earned-mark" aria-label="Unlocked"><Check :size="14" /></span>
                <span v-else class="achievement-row__locked-mark" aria-label="Locked"><LockKeyhole :size="13" /></span>
              </div>
              <div class="achievement-row__body">
                <div class="achievement-row__title-line"><h3>{{ achievement.name || achievement.apiname }}</h3><span v-if="achievement.global_percent != null" class="achievement-row__rarity">{{ Number(achievement.global_percent).toFixed(2) }}% global</span></div>
                <p>{{ achievement.description || 'No description available.' }}</p>
                <div class="achievement-row__meta">
                  <span v-if="isUnlocked(achievement)" class="achievement-row__unlocked"><Check :size="14" /> Obtained<span v-if="achievement.unlocktime"> · {{ new Date(Number(achievement.unlocktime) * 1000).toLocaleDateString() }}</span></span>
                  <span v-else class="achievement-row__locked-label"><LockKeyhole :size="13" /> Still locked</span>
                  <span v-if="achievement.global_percent != null" class="achievement-row__rarity-mobile">{{ Number(achievement.global_percent).toFixed(2) }}% global rarity</span>
                </div>
              </div>
            </li>
          </ol>
        </section>
      </template>
    </div>
  </main>
</template>
