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
    :aria-label="`View ${game.name} details`"
    @click="$emit('select', game)"
  >
    <span class="archive-game__artwork">
      <img
        v-if="game.coverUrl"
        :src="game.coverUrl"
        :alt="`${game.name} artwork`"
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
        aria-label="Diamond trophy achieved"
        ><Diamond :size="13" fill="currentColor" aria-hidden="true" /><span
          >Diamond trophy</span
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
              {{ game.achievementCount }} achievements</span
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
            :aria-label="`${game.name} completion`"
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
      >{{ Math.round(game.playtime_forever / 60) }} h played</span
    >
  </button>
</template>
