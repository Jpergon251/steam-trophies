<template>
  <header class="landing__topline">
    <RouterLink class="landing__wordmark" :to="{ name: 'home' }" :aria-label="$t('header.home')">
      <span class="landing__mark" aria-hidden="true">
        <Trophy :size="16" :stroke-width="1.6" />
      </span>
      <span>{{ $t('header.title') }}</span>
    </RouterLink>

    <span class="landing__edition">{{ $t('header.edition') }}</span>

    <div class="landing__topline-actions">
      <div v-if="currentSteamId" class="landing__refresh-group">
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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useSteamProfilesStore } from '../../stores/steamProfiles.js'
import { Trophy } from '@lucide/vue'
import LanguageSelector from './LanguageSelector.vue'

const store = useSteamProfilesStore()

// Determine current steamId – pick first available profile in state
const currentSteamId = computed(() => {
  const ids = Object.keys(store.profiles)
  return ids.length ? ids[0] : null
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
  if (!id) return
  store.syncProfile(id).catch(() => {})
  countdown.value = 60
}

function tick() {
  if (!currentSteamId.value) return
  if (countdown.value <= 0) {
    manualRefresh()
  } else {
    countdown.value--
  }
}

onMounted(() => {
  intervalId = setInterval(tick, 1000)
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
