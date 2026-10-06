<script setup>
import { ArrowUpRight, Diamond, Trophy } from '@lucide/vue'

const props = defineProps({
  game: { type: Object, required: true },
})
defineEmits(['select'])

function handleArtworkError(event) {
  const image = event.currentTarget
  if (image.dataset.fallbackApplied === 'true') {
    image.hidden = true
    return
  }
  image.dataset.fallbackApplied = 'true'
  image.src = props.game.fallbackUrl || props.game.headerUrl
}
</script>

<template>
  <button
    class="archive-list-row"
    :class="{ 'archive-list-row--diamond': game.isDiamond }"
    type="button"
    :aria-label="$t('profile.games.openGame', { name: game.name })"
    @click="$emit('select', game)"
  >
    <span class="archive-list-row__artwork">
      <img
        v-if="game.coverUrl"
        :src="game.coverUrl"
        :alt="`${game.name} artwork`"
        loading="lazy"
        decoding="async"
        @error="handleArtworkError"
      />
      <span v-else class="archive-list-row__fallback">
        {{ game.name?.slice(0, 1) || 'S' }}
      </span>
    </span>

    <span class="archive-list-row__body">
      <span class="archive-list-row__heading">
        <strong class="archive-list-row__name" :title="game.name">{{ game.name }}</strong>
        <template v-if="game.achievementSummaryKnown && game.achievementCount">
          <span class="archive-list-row__completion">
            <span>{{ game.achievementSummaryStatus === 'partial' ? '≥ ' : '' }}{{ game.unlockedCount }} / {{ game.achievementCount }} {{ $t('profile.games.trophies') }}</span>
            <b v-if="game.achievementSummaryStatus !== 'partial'">{{ game.progress }}%</b>
          </span>
        </template>
        <span v-else class="archive-list-row__empty">
          {{ game.achievementSummaryKnown ? $t('profile.games.noTrophies') : $t('profile.games.achievementDataUnavailable') }}
        </span>
      </span>

      <span v-if="game.achievementSummaryKnown && game.achievementCount" class="archive-list-row__details">
        <span class="archive-list-row__tiers">
          <span
            v-for="tier in ['bronze', 'silver', 'gold']"
            :key="tier"
            class="archive-list-row__tier trophy-tier"
            :class="`trophy-tier--${tier}`"
            :aria-label="`${$t(`profile.cabinet.${tier}`)} ${game.tierCounts?.[tier] || 0}`"
          >
            <Trophy :size="15" aria-hidden="true" />
            <span>{{ game.tierCounts?.[tier] || 0 }}</span>
          </span>
          <span
            v-if="game.isDiamond"
            class="archive-list-row__diamond trophy-tier trophy-tier--diamond"
            :aria-label="$t('profile.cabinet.diamondCompleted')"
          >
            <Diamond :size="16" fill="currentColor" aria-hidden="true" />
          </span>
        </span>
        <span
          v-if="game.achievementSummaryStatus !== 'partial'"
          class="archive-list-row__track"
          role="progressbar"
          :aria-valuenow="game.progress"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="`${game.name} ${game.progress}%`"
        >
          <span :style="{ width: `${game.progress}%` }" />
        </span>
      </span>
    </span>
    <ArrowUpRight class="archive-list-row__arrow" :size="17" aria-hidden="true" />
  </button>
</template>
