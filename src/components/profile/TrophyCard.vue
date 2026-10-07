<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { LockKeyhole, Trophy } from '@lucide/vue'
import { getTrophyTier } from '../../data/trophyTiers.js'

const props = defineProps({ trophy: { type: Object, required: true } })
const emit = defineEmits(['select', 'request-achievement-icons'])
const tier = computed(() => getTrophyTier(props.trophy.global_percent) || props.trophy.tier || 'unclassified')
const isUnlocked = () => props.trophy.achieved === true || Number(props.trophy.achieved) === 1
const achievementIcons = computed(() => [...new Set([props.trophy.icon, props.trophy.icongray].filter(Boolean))])
const achievementIconIndex = ref(0)
const cardElement = ref(null)
const gameIconFailed = ref(false)
let visibilityObserver

function requestAchievementIcons() {
  if (props.trophy.appid) emit('request-achievement-icons', String(props.trophy.appid))
}

watch(achievementIcons, () => {
  achievementIconIndex.value = 0
})
watch(() => props.trophy.gameIcon, () => {
  gameIconFailed.value = false
})
onMounted(() => {
  if (typeof IntersectionObserver === 'undefined' || !cardElement.value) return
  visibilityObserver = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting || entry.intersectionRatio < 0.2) return
    visibilityObserver.unobserve(entry.target)
    if (!achievementIcons.value.length) requestAchievementIcons()
  }, { threshold: 0.2 })
  visibilityObserver.observe(cardElement.value)
})
onBeforeUnmount(() => visibilityObserver?.disconnect())
</script>

<template>
  <button
    ref="cardElement"
    class="trophy-card"
    :class="[
      `trophy-card--${tier}`,
      `trophy-tier--${tier}`,
      { 'trophy-card--locked': !isUnlocked() },
    ]"
    type="button"
    @click="emit('select', trophy)"
  >
    <span class="trophy-card__emblem">
      <span class="trophy-card__icon-wrap" :class="{ 'trophy-card__icon-wrap--locked': !isUnlocked() }">
        <img
          v-if="achievementIcons[achievementIconIndex]"
          class="trophy-card__achievement-icon"
          :src="achievementIcons[achievementIconIndex]"
          :alt="$t('profile.modal.achievementIconAlt', { name: trophy.name })"
          loading="lazy"
          decoding="async"
          @error="achievementIconIndex < achievementIcons.length - 1
            ? achievementIconIndex += 1
            : requestAchievementIcons()"
        />
        <Trophy
          v-else
          class="trophy-card__fallback"
          :class="{ 'trophy-card__fallback--locked': !isUnlocked() }"
          :size="48"
          :stroke-width="1.25"
          aria-hidden="true"
        />
      </span>
      <span class="trophy-card__tier-badge" :class="`trophy-card__tier-badge--${tier}`" aria-hidden="true">
        <Trophy :size="32" :stroke-width="1.8" />
      </span>
      <LockKeyhole v-if="!isUnlocked()" class="trophy-card__lock" :size="13" :aria-label="$t('profile.modal.lockedAria')" />
    </span>
    <small v-if="trophy.global_percent != null" class="trophy-card__rarity">{{ Number(trophy.global_percent).toFixed(1) }}%</small>
    <strong>{{ trophy.name }}</strong>
    <span v-if="trophy.gameName" class="trophy-card__game">
      <img
        v-if="trophy.gameIcon && !gameIconFailed"
        class="trophy-card__game-icon"
        :src="trophy.gameIcon"
        :alt="$t('profile.modal.gameIconAlt', { name: trophy.gameName })"
        loading="lazy"
        decoding="async"
        @error="gameIconFailed = true"
      />
      <span class="trophy-card__game-name">{{ trophy.gameName }}</span>
    </span>
  </button>
</template>
