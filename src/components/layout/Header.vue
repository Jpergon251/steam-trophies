<template>
  <header v-if="isLandingPage || isProfilePage" class="landing__topline" :class="{ 'landing__topline--profile': isProfilePage }">
    <RouterLink class="landing__wordmark" :to="{ name: 'home' }" :aria-label="$t('header.home')">
      <span class="landing__mark" aria-hidden="true">
        <Trophy :size="16" :stroke-width="1.6" />
      </span>
      <span>{{ $t('header.title') }}</span>
    </RouterLink>

    <span class="landing__edition">{{ $t('header.edition') }}</span>

    <div class="landing__topline-actions">
      <div v-if="isProfilePage && canRefresh" class="landing__refresh-group">
        <button
          class="landing__refresh"
          :aria-label="$t('header.refreshAria')"
          @click="manualRefresh"
        >
          {{ $t('header.refresh') }}
        </button>
        <span class="landing__countdown" aria-live="polite">{{ formattedCountdown }}</span>
      </div>

      <LanguageSelector />
    </div>
  </header>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSteamProfilesStore } from '../../stores/steamProfiles.js'
import { Trophy } from '@lucide/vue'
import LanguageSelector from './LanguageSelector.vue'

const store = useSteamProfilesStore()
const route = useRoute()
const isLandingPage = computed(() => route.name === 'home')
const isProfilePage = computed(() => route.name === 'profile')
const currentSteamId = computed(() => isProfilePage.value ? String(route.params.steamId || '') : '')
const profileLoaded = computed(() => Boolean(currentSteamId.value && store.profileFor(currentSteamId.value)))
const syncActive = computed(() => Boolean(currentSteamId.value && store.syncs[currentSteamId.value]?.active))
const canRefresh = computed(() => profileLoaded.value && !syncActive.value)

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
  countdown.value = 60
  store.syncProfile(id).catch(() => {})
}

function tick() {
  if (!canRefresh.value) return
  if (countdown.value <= 1) {
    manualRefresh()
  } else {
    countdown.value--
  }
}

watch([currentSteamId, canRefresh], ([id, ready]) => {
  countdown.value = 60
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
  if (ready && id) intervalId = setInterval(tick, 1000)
})

onMounted(() => {
  if (canRefresh.value) intervalId = setInterval(tick, 1000)
})

onBeforeUnmount(() => {
  if (intervalId) clearInterval(intervalId)
})
</script>

<style scoped>
.landing__topline-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.85rem;
}

.landing__refresh-group {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.landing__refresh {
  padding: 0.3rem 0.65rem;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #f5f5f5;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: all 180ms ease;
}

.landing__refresh:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
}

.landing__refresh:active {
  transform: translateY(1px);
}

.landing__countdown {
  color: #a1a1a1;
  font-size: 0.75rem;
  font-family: 'JetBrains Mono', monospace;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
</style>
