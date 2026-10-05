<template>
  <section
    v-if="history.length"
    class="recent-searches"
    aria-labelledby="recent-searches-title"
  >
    <div class="recent-searches__header">
      <h2 id="recent-searches-title" class="recent-searches__title">
        {{ $t('landing.recentSearches.title') }}
      </h2>
      <button
        type="button"
        class="recent-searches__clear"
        :aria-label="$t('landing.recentSearches.clearAria')"
        @click="clearHistory"
      >
        {{ $t('landing.recentSearches.clear') }}
      </button>
    </div>

    <div class="recent-searches__frame">
      <TransitionGroup
        name="recent-item"
        tag="ul"
        class="recent-searches__list"
      >
        <li
          v-for="item in history"
          :key="item.steamId"
          class="recent-searches__entry"
        >
          <RouterLink
            :to="{ name: 'profile', params: { steamId: item.steamId } }"
            class="recent-searches__link"
            @click="handleSelect(item)"
          >
            <div class="recent-searches__avatar-frame">
              <img
                v-if="item.avatar && !hasAvatarError(item.steamId)"
                class="recent-searches__avatar"
                :src="item.avatar"
                :alt="`${item.personaName}'s avatar`"
                loading="lazy"
                @error="onAvatarError(item.steamId)"
              />
              <UserRound
                v-else
                class="recent-searches__avatar-fallback"
                :size="18"
                :stroke-width="1.5"
                aria-hidden="true"
              />
            </div>

            <div class="recent-searches__meta">
              <span class="recent-searches__name" :title="item.personaName">
                {{ item.personaName }}
              </span>
              <span class="recent-searches__steam-id">
                STEAMID <span class="recent-searches__steam-id-val">{{ item.steamId }}</span>
              </span>
            </div>

            <div class="recent-searches__actions">
              <button
                type="button"
                class="recent-searches__remove"
                :aria-label="$t('landing.recentSearches.removeAria', { name: item.personaName })"
                :title="$t('landing.recentSearches.removeAria', { name: item.personaName })"
                @click.stop.prevent="removeProfile(item.steamId)"
              >
                <X :size="14" :stroke-width="1.8" aria-hidden="true" />
              </button>
              <span class="recent-searches__arrow" aria-hidden="true">
                <ArrowUpRight :size="16" :stroke-width="1.8" />
              </span>
            </div>
          </RouterLink>
        </li>
      </TransitionGroup>
    </div>
  </section>
</template>

<script setup>
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ArrowUpRight, UserRound, X } from '@lucide/vue'
import { useSearchHistory } from '../../composables/useSearchHistory.js'

const { history, addProfile, removeProfile, clearHistory } = useSearchHistory()

// Set of steamIds where the avatar failed to load, triggering fallback
const failedAvatars = ref(new Set())

function onAvatarError(steamId) {
  failedAvatars.value.add(steamId)
}

function hasAvatarError(steamId) {
  return failedAvatars.value.has(steamId)
}

function handleSelect(item) {
  // Update lastVisitedAt and bring entry to the top of the list
  addProfile(item)
}
</script>
