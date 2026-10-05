<template>
  <section id="home" class="landing__content" aria-labelledby="landing-title">
    <p class="landing__eyebrow">
      <span class="landing__eyebrow-line" />Your achievements, reimagined<span
        class="landing__eyebrow-line"
      />
    </p>
    <h1 id="landing-title" class="landing__title">
      Steam <span>Trophies</span>
    </h1>
    <p class="landing__description">
      Transform your Steam achievements into a collection worth showing.
    </p>

    <SteamSearch :loading="status === 'loading'" @submit="handleSearch" />

    <p v-if="status === 'error'" class="landing__search-error" role="alert">{{ errorMessage }}</p>
    <p v-else-if="status === 'loading'" class="landing__search-loading" role="status">Searching for your Steam profile…</p>

    <Transition name="profile-preview-reveal">
      <SteamProfilePreview v-if="status === 'success' && profile" :profile="profile" />
    </Transition>

    <div class="landing__collection" aria-label="Four trophy tiers">
      <div class="landing__tier landing__tier--bronze">
        <Medal class="landing__tier-icon" :size="17" :stroke-width="1.5" /><span
          >Bronze</span
        >
      </div>
      <div class="landing__tier landing__tier--silver">
        <Award class="landing__tier-icon" :size="17" :stroke-width="1.5" /><span
          >Silver</span
        >
      </div>
      <div class="landing__tier landing__tier--gold">
        <Trophy
          class="landing__tier-icon"
          :size="17"
          :stroke-width="1.5"
        /><span>Gold</span>
      </div>
      <div class="landing__tier landing__tier--diamond">
        <Gem class="landing__tier-icon" :size="17" :stroke-width="1.5" /><span
          >Diamond</span
        >
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref } from 'vue'
import { Award, Gem, Medal, Trophy } from '@lucide/vue'
import SteamProfilePreview from '../components/profile/SteamProfilePreview.vue'
import SteamSearch from '../components/ui/SteamSearch.vue'
import { searchSteamProfile } from '../services/steam.js'

const profile = ref(null)
const status = ref('idle')
const errorMessage = ref('')
let searchVersion = 0
function getSearchErrorMessage(error) {
  if (error.status === 400) return "That doesn't look like a valid Steam profile."
  if (error.status === 404) return 'Steam profile not found.'
  if (error.status === 502 || !error.status) return "We couldn't connect to Steam right now."
  return 'Something went wrong while searching.'
}

async function handleSearch(query) {
  const currentSearch = ++searchVersion
  profile.value = null
  errorMessage.value = ''
  status.value = 'loading'

  try {
    profile.value = await searchSteamProfile(query)
    if (currentSearch === searchVersion) status.value = 'success'
  } catch (error) {
    console.error('Steam profile search failed.', error)
    if (currentSearch === searchVersion) {
      errorMessage.value = getSearchErrorMessage(error)
      status.value = 'error'
    }
  }
}
</script>