<template>
  <header v-if="isLandingPage || isProfilePage" class="landing__topline">
    <RouterLink class="landing__wordmark" :to="{ name: 'home' }" :aria-label="$t('header.home')">
      <span class="landing__mark" aria-hidden="true">
        <Trophy :size="16" :stroke-width="1.6" />
      </span>
      <span class="landing__wordmark-label">{{ $t('header.title') }}</span>
    </RouterLink>

    <div class="landing__topline-actions">
      <div v-if="isProfilePage && profileLoaded" class="landing__refresh-group">
        <button
          class="landing__refresh"
          :disabled="!canRefresh"
          :aria-busy="syncActive"
          :aria-label="refreshLabel"
          @click="manualRefresh"
        >
          <RefreshCw class="landing__refresh-icon" :size="17" :stroke-width="1.8" aria-hidden="true" />
          <span class="landing__refresh-label">{{ refreshLabel }}</span>
        </button>
        <span class="landing__countdown" aria-live="polite">
          {{ canRefresh ? formattedCountdown : $t('header.refreshing') }}
        </span>
      </div>

      <LanguageSelector />
    </div>
  </header>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSteamProfilesStore } from '../../stores/steamProfiles.js'
import { RefreshCw, Trophy } from '@lucide/vue'
import LanguageSelector from './LanguageSelector.vue'
import { useI18n } from '../../i18n'

const store = useSteamProfilesStore()
const route = useRoute()
const { t } = useI18n()
const isLandingPage = computed(() => route.name === 'home')
const isProfilePage = computed(() => route.name === 'profile')
const currentSteamId = computed(() => isProfilePage.value ? String(route.params.steamId || '') : '')
const profileLoaded = computed(() => Boolean(currentSteamId.value && store.profileFor(currentSteamId.value)))
const syncActive = computed(() => Boolean(currentSteamId.value && store.syncs[currentSteamId.value]?.active))
const syncState = computed(() => currentSteamId.value ? store.syncs[currentSteamId.value] : null)
const refreshPending = ref(false)
const canRefresh = computed(() =>
  profileLoaded.value &&
  !syncActive.value &&
  !refreshPending.value,
)
const refreshLabel = computed(() => {
  if (syncActive.value) return t('header.syncing')
  if (syncState.value?.phase === 'complete') return t('header.syncComplete')
  if (['partial-error', 'error'].includes(syncState.value?.phase)) return t('header.syncPartial')
  return t('header.sync')
})

const countdown = ref(60)
let intervalId = null

const formattedCountdown = computed(() => {
  const m = Math.floor(countdown.value / 60)
  const s = countdown.value % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
})

function manualRefresh() {
  const id = currentSteamId.value
  if (!canRefresh.value || !id) return
  refreshPending.value = true
  store.syncProfile(id)
    .catch(() => {})
    .finally(() => {
      refreshPending.value = false
    })
}

function tick() {
  if (!canRefresh.value) return
  if (countdown.value <= 1) {
    countdown.value = 0
    manualRefresh()
  } else {
    countdown.value--
  }
}

watch([currentSteamId, canRefresh], ([id, ready], previousValues = []) => {
  const [previousId] = previousValues
  countdown.value = 60
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
  if (id !== previousId) refreshPending.value = false
  if (ready && id) intervalId = setInterval(tick, 1000)
}, { immediate: true })

onBeforeUnmount(() => {
  if (intervalId) clearInterval(intervalId)
})
</script>
