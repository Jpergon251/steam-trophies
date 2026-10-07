<script setup>
import { ArrowUpRight, Diamond } from "@lucide/vue";

const props = defineProps({ game: { type: Object, required: true } });
defineEmits(["select"]);
function handleArtworkError(event) {
  const image = event.currentTarget;
  if (image.dataset.fallbackApplied === "true") {
    image.hidden = true;
    return;
  }
  image.dataset.fallbackApplied = "true";
  image.src = props.game.fallbackUrl || props.game.headerUrl;
}
</script>

<template>
  <button
    class="archive-game"
    :class="{ 'archive-game--diamond': game.isDiamond }"
    type="button"
    :aria-label="$t('profile.games.openGame', { name: game.name })"
    @click="$emit('select', game)"
  >
    <span class="archive-game__artwork">
      <img
        v-if="game.coverUrl"
        :src="game.coverUrl"
        :alt="$t('profile.games.artworkAlt', { name: game.name })"
        loading="lazy"
        @error="handleArtworkError"
      />
      <span v-else class="archive-game__fallback">{{
        game.name?.slice(0, 1) || "S"
      }}</span>
      <span class="archive-game__overlay" />
      <span
        v-if="game.isDiamond"
        class="archive-game__diamond"
        :aria-label="$t('profile.games.diamondAchieved')"
        ><Diamond :size="13" fill="currentColor" aria-hidden="true" /><span
          >{{ $t('profile.games.diamondTrophy') }}</span
        ></span
      >
      <span class="archive-game__content">
        <strong class="archive-game__name" :title="game.name">{{
          game.name
        }}</strong>
        <template v-if="game.achievementSummaryKnown && game.achievementCount">
          <span class="archive-game__progress"
            ><span
              >{{ game.achievementSummaryStatus === 'partial' ? '≥ ' : '' }}{{ game.unlockedCount }} /
              {{ game.achievementCount }} {{ $t('profile.games.achievements') }}</span
            ><b v-if="game.achievementSummaryStatus !== 'partial'">{{ game.progress }}%</b></span
          >
          <span
            v-if="game.achievementSummaryStatus !== 'partial'"
            class="archive-game__track"
            :class="{ 'archive-game__track--diamond': game.isDiamond }"
            role="progressbar"
            :aria-valuenow="game.progress"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="$t('profile.games.completionAria', { name: game.name })"
            ><span :style="{ width: `${game.progress}%` }"
          /></span>
        </template>
        <span v-else class="archive-game__no-trophies">
          {{ game.achievementSummaryKnown ? $t('profile.games.noTrophies') : $t('profile.games.achievementDataUnavailable') }}
        </span>
      </span>
      <ArrowUpRight class="archive-game__arrow" :size="17" aria-hidden="true" />
    </span>
    <span v-if="game.playtime_forever" class="archive-game__playtime"
      >{{ $t('profile.games.hoursPlayed', { hours: Math.round(game.playtime_forever / 60) }) }}</span
    >
  </button>
</template>
