<script setup>
import { computed, ref, watch } from 'vue'
import { Diamond, ExternalLink, LoaderCircle, MoveLeft, Trophy, UserRound } from '@lucide/vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSteamProfilesStore } from '../stores/steamProfiles.js'
import TrophyModal from '../components/profile/TrophyModal.vue'
import ProfileViewTabs from '../components/profile/ProfileViewTabs.vue'
import TrophyCabinet from '../components/profile/TrophyCabinet.vue'
import GamesCollection from '../components/profile/GamesCollection.vue'
import { useI18n } from '../i18n'

const route = useRoute()
const router = useRouter()
const steamStore = useSteamProfilesStore()
const { t } = useI18n()

const status = ref('loading')
const errorCode = ref(null)
const selectedView = ref('display')
const selectedTrophy = ref(null)
const steamId = computed(() => String(route.params.steamId || ''))
const profile = computed(() => activeSteamId.value === steamId.value ? steamStore.profileFor(steamId.value) : null)
const games = computed(() => activeSteamId.value === steamId.value ? steamStore.gamesFor(steamId.value) : [])
const trophyCollection = computed(() => activeSteamId.value === steamId.value ? steamStore.trophiesFor(steamId.value) : [])
const gameByAppId = computed(() => new Map(games.value.map((game) => [String(game.appid), game])))
const profileStats = computed(() => games.value.reduce((stats, game) => {
  const tiers = game.tierCounts || game.trophyCounts || {}
  stats.bronze += Number(tiers.bronze) || 0
  stats.silver += Number(tiers.silver) || 0
  stats.gold += Number(tiers.gold) || 0
  stats.completed += game.isDiamond ? 1 : 0
  return stats
}, { bronze: 0, silver: 0, gold: 0, completed: 0 }))
const unlockedTrophyCount = computed(() =>
  profileStats.value.bronze + profileStats.value.silver + profileStats.value.gold,
)
const gamesStatus = computed(() => steamStore.errorFor(steamId.value) && !games.value.length ? 'error' : profile.value ? 'success' : 'loading')
const syncState = computed(() => steamStore.syncs[steamId.value] || null)
const collectionStatus = computed(() => {
  if (!profile.value) return steamStore.isSyncing(steamId.value) ? 'loading' : 'success'
  return syncState.value?.phase === 'achievements' && !trophyCollection.value.length ? 'loading' : 'success'
})
const refreshError = computed(() => steamStore.errorFor(steamId.value) && profile.value ? t('profile.cacheStatus.cached') : '')
const gamesLoading = computed(() => gamesStatus.value === 'loading' || (!games.value.length && collectionStatus.value === 'loading'))
const activeSteamId = ref(steamId.value)
const collectionProgress = computed(() => {
  const sync = steamStore.syncs[steamId.value]
  return sync && typeof sync === 'object' ? sync : { processed: 0, total: 0 }
})
const isHydrating = computed(() => steamStore.isHydrating(steamId.value))

const errorMessage = computed(() => {
  if (!errorCode.value) return ''
  if (errorCode.value === 400) return t('landing.searchErrorInvalid')
  if (errorCode.value === 404) return t('landing.searchErrorNotFound')
  if (errorCode.value === 502) return t('landing.searchErrorConnection')
  return t('landing.searchErrorGeneric')
})

async function loadProfile(id) {
  if (!id) return
  const previousId = activeSteamId.value
  if (previousId && previousId !== id) steamStore.clearProfileMemory(previousId)
  activeSteamId.value = id
  selectedTrophy.value = null
  errorCode.value = null
  // Hydration (IndexedDB -> Pinia) happens first and may resolve the UI
  // instantly when a cache exists.
  await steamStore.loadProfile(id)
  if (activeSteamId.value !== id) return
  if (steamStore.profileFor(id)) {
    status.value = 'success'
    return
  }
  // No cache yet: surface first-load state and wait for the background sync
  // to produce data or an error.
  status.value = 'loading'
  try {
    await steamStore.syncProfile(id)
    if (activeSteamId.value !== id) return
    if (steamStore.profileFor(id)) status.value = 'success'
  } catch (error) {
    if (activeSteamId.value !== id) return
    errorCode.value = error.status || 500
    status.value = 'error'
  }
}

watch(steamId, (id) => loadProfile(id), { immediate: true })
watch(() => route.query.view, (view) => {
  if (view === 'games') selectedView.value = 'games'
}, { immediate: true })

async function openGame({ game, context }) {
  const profileLocation = {
    name: 'profile',
    params: { steamId: steamId.value },
    query: { view: 'games', ...context },
  }
  await router.replace(profileLocation)
  await router.push({
    name: 'game',
    params: { steamId: steamId.value, appid: game.appid },
    query: context,
  })
}
</script>

<template>
  <main class="profile-page">
    <div class="profile-page__ambient" aria-hidden="true" />
    <RouterLink class="profile-page__back" :to="{ name: 'home' }">
      <MoveLeft :size="16" :stroke-width="1.7" aria-hidden="true" /> {{ $t('profile.backToDiscovery') }}
    </RouterLink>

    <section class="profile-page__content" aria-labelledby="profile-page-title">
      <div
        v-if="status === 'loading' && !profile"
        class="profile-page__state"
        role="status"
      >
        <LoaderCircle
          class="profile-page__loader"
          :size="22"
          :stroke-width="1.6"
          aria-hidden="true"
        />
        <span>{{ $t('profile.retrieving') }}</span>
      </div>

      <div
        v-else-if="status === 'error' && !profile"
        class="profile-page__state profile-page__state--error"
        role="alert"
      >
        <p>{{ errorMessage }}</p>
        <RouterLink class="profile-page__retry" :to="{ name: 'home' }">
          {{ $t('profile.searchAnother') }}
        </RouterLink>
      </div>

      <template v-else-if="profile">
        <div class="profile-page__identity">
          <div class="profile-page__avatar-frame">
            <img
              v-if="profile.avatarfull || profile.avatarmedium"
              class="profile-page__avatar"
              :src="profile.avatarfull || profile.avatarmedium"
              :alt="$t('profile.avatarAlt', { name: profile.personaname })"
            />
            <UserRound
              v-else
              class="profile-page__avatar-fallback"
              :size="32"
              :stroke-width="1.4"
              aria-hidden="true"
            />
          </div>
          <p class="profile-page__label">{{ $t('profile.steamProfile') }}</p>
          <h1 id="profile-page-title" class="profile-page__name">
            {{ profile.personaname }}
          </h1>
          <p v-if="profile.realname" class="profile-page__real-name">
            {{ profile.realname }}
          </p>
          <p class="profile-page__steam-id">
            {{ $t('profile.steamId') }} <span>{{ profile.steamid }}</span>
          </p>
          <a
            class="profile-page__steam-link"
            :href="
              profile.profileurl ||
              `https://steamcommunity.com/profiles/${profile.steamid}`
            "
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ $t('profile.openSteamProfile') }}
            <ExternalLink :size="14" :stroke-width="1.7" aria-hidden="true" />
          </a>
        </div>

        <div v-if="gamesStatus === 'error'" class="profile-page__inline-state">
          {{ $t('profile.privateCollection') }}
        </div>
        <template v-else>
          <section class="profile-overview" :aria-label="$t('profile.overview')">
            <div class="profile-overview__stats">
              <div class="profile-overview__stat">
                <strong>{{ games.length.toLocaleString() }}</strong>
                <span>{{ $t('profile.stats.games') }}</span>
              </div>
              <div class="profile-overview__stat">
                <strong>{{ unlockedTrophyCount.toLocaleString() }}</strong>
                <span>{{ $t('profile.stats.trophies') }}</span>
              </div>
              <div class="profile-overview__stat">
                <strong>{{ profileStats.completed.toLocaleString() }}</strong>
                <span>{{ $t('profile.stats.completed') }}</span>
              </div>
            </div>
            <div class="profile-overview__tiers" :aria-label="$t('profile.trophyBreakdown')">
              <span
                v-for="tier in ['bronze', 'silver', 'gold']"
                :key="tier"
                class="profile-overview__tier trophy-tier"
                :class="`trophy-tier--${tier}`"
              >
                <Trophy :size="16" aria-hidden="true" />
                <span>{{ $t(`profile.cabinet.${tier}`) }}</span>
                <strong>{{ profileStats[tier].toLocaleString() }}</strong>
              </span>
              <span class="profile-overview__tier trophy-tier trophy-tier--diamond">
                <Diamond :size="16" fill="currentColor" aria-hidden="true" />
                <span>{{ $t('profile.cabinet.diamond') }}</span>
                <strong>{{ profileStats.completed.toLocaleString() }}</strong>
              </span>
            </div>
          </section>
          <div class="collection-shell">
            <ProfileViewTabs v-model="selectedView" />
            <div v-if="selectedView === 'display'" class="profile-cabinet-heading">
              <span aria-hidden="true" />
              <h2>{{ $t('profile.cabinet.title') }}</h2>
              <span aria-hidden="true" />
            </div>
            <p v-if="refreshError" class="profile-page__cache-status" role="status">{{ refreshError }}</p>
            <p v-else-if="isHydrating" class="profile-page__cache-status" role="status">
              {{ $t('profile.cacheStatus.loadingCache') }}
            </p>
            <p v-else-if="syncState?.active && syncState.phase === 'library'" class="profile-page__cache-status" role="status">
              {{ $t('profile.cacheStatus.updating') }}
            </p>
            <p v-else-if="syncState?.active && syncState.total" class="profile-page__cache-status" role="status">
              {{ $t('profile.cacheStatus.updatingProgress', { processed: syncState.processed, total: syncState.total }) }}
            </p>
            <TrophyCabinet
              v-if="selectedView === 'display'"
              :trophies="trophyCollection"
              :games="games"
              :status="collectionStatus"
              :progress="collectionProgress"
              @select-trophy="selectedTrophy = { ...$event, game: gameByAppId.get(String($event.appid)) || null }"
              @select-diamond="selectedTrophy = { isDiamond: true, game: $event, name: $event.name }"
            />
            <GamesCollection
              v-else-if="selectedView === 'games'"
              :games="games"
              :loading="gamesLoading"
              :error="gamesStatus === 'error'"
              @select="openGame"
            />
          </div>
        </template>
        <TrophyModal :trophy="selectedTrophy" @close="selectedTrophy = null" />
      </template>
    </section>
  </main>
</template>
