<template>
  <div class="landing">
    <section id="home" class="landing__content" aria-labelledby="landing-title">
      <p class="landing__eyebrow">
        <span class="landing__eyebrow-line" />{{ $t('landing.eyebrow') }}<span
          class="landing__eyebrow-line"
        />
      </p>
      <h1 id="landing-title" class="landing__title">
        {{ $t('landing.title') }} <span>{{ $t('landing.titleHighlight') }}</span>
      </h1>
      <p class="landing__description">
        {{ $t('landing.description') }}
      </p>

      <SteamSearch :loading="status === 'loading'" @submit="handleSearch" />

      <p v-if="status === 'error'" class="landing__search-error" role="alert">{{ errorMessage }}</p>
      <p v-else-if="status === 'loading'" class="landing__search-loading" role="status">
        {{ $t('landing.searchLoading') }}
      </p>

      <Transition name="profile-preview-reveal">
        <SteamProfilePreview v-if="status === 'success' && profile" :profile="profile" />
      </Transition>

      <RecentSearches />

      <div class="landing__collection" aria-label="Four trophy tiers">
        <div class="landing__tier landing__tier--bronze">
          <Medal class="landing__tier-icon" :size="17" :stroke-width="1.5" />
          <span>{{ $t('landing.tiers.bronze') }}</span>
        </div>
        <div class="landing__tier landing__tier--silver">
          <Award class="landing__tier-icon" :size="17" :stroke-width="1.5" />
          <span>{{ $t('landing.tiers.silver') }}</span>
        </div>
        <div class="landing__tier landing__tier--gold">
          <Trophy class="landing__tier-icon" :size="17" :stroke-width="1.5" />
          <span>{{ $t('landing.tiers.gold') }}</span>
        </div>
        <div class="landing__tier landing__tier--diamond">
          <Gem class="landing__tier-icon" :size="17" :stroke-width="1.5" />
          <span>{{ $t('landing.tiers.diamond') }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { Award, Gem, Medal, Trophy } from '@lucide/vue'
import SteamProfilePreview from '../components/profile/SteamProfilePreview.vue'
import SteamSearch from '../components/ui/SteamSearch.vue'
import RecentSearches from '../components/landing/RecentSearches.vue'
import { searchSteamProfile } from '../services/steam.js'
import { useSearchHistory } from '../composables/useSearchHistory.js'
import { useI18n } from '../i18n'

const { t } = useI18n()
const { addProfile } = useSearchHistory()

const profile = ref(null)
const status = ref('idle')
const errorCode = ref(null)
let searchVersion = 0

const errorMessage = computed(() => {
  if (!errorCode.value) return ''
  if (errorCode.value === 400) return t('landing.searchErrorInvalid')
  if (errorCode.value === 404) return t('landing.searchErrorNotFound')
  if (errorCode.value === 502) return t('landing.searchErrorConnection')
  return t('landing.searchErrorGeneric')
})

async function handleSearch(query) {
  const currentSearch = ++searchVersion
  profile.value = null
  errorCode.value = null
  status.value = 'loading'

  try {
    const result = await searchSteamProfile(query)
    if (currentSearch === searchVersion) {
      profile.value = result
      status.value = 'success'
      if (result && result.steamid) {
        addProfile(result)
      }
    }
  } catch (error) {
    console.error('Steam profile search failed.', error)
    if (currentSearch === searchVersion) {
      errorCode.value = error.status || 500
      status.value = 'error'
    }
  }
}
</script>