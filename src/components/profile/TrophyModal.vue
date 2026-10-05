<script setup>
import { computed, onBeforeUnmount, onMounted } from "vue";
import { LockKeyhole, Trophy, X } from "@lucide/vue";
import { getTrophyTier } from "../../data/trophyTiers.js";
const props = defineProps({ trophy: { type: Object, default: null } });
const emit = defineEmits(["close"]);
const tier = computed(() => getTrophyTier(props.trophy?.global_percent));
const isDiamond = computed(() => props.trophy?.isDiamond === true);
const isUnlocked = computed(() => props.trophy?.achieved === true || Number(props.trophy?.achieved) === 1);
const diamondGame = computed(() => props.trophy?.game || null);
function handleKey(event) {
  if (event.key === "Escape") emit("close");
}
onMounted(() => window.addEventListener("keydown", handleKey));
onBeforeUnmount(() => window.removeEventListener("keydown", handleKey));
</script>

<template>
  <div
    v-if="trophy"
    class="trophy-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="trophy-modal-title"
    @click.self="$emit('close')"
  >
    <article
      class="trophy-modal__card"
      :class="[
        `trophy-modal__card--${tier || 'unclassified'}`,
        { 'trophy-modal__card--diamond': isDiamond, 'trophy-modal__card--locked': !isUnlocked && !isDiamond },
      ]"
    >
      <button
        class="trophy-modal__close"
        type="button"
        aria-label="Close trophy details"
        @click="$emit('close')"
      >
        <X :size="18" />
      </button>
      <template v-if="isDiamond && diamondGame">
        <div class="diamond-exhibit__halo" aria-hidden="true"><div class="diamond-exhibit__orbit diamond-exhibit__orbit--one" /><div class="diamond-exhibit__orbit diamond-exhibit__orbit--two" /></div>
        <div class="diamond-exhibit__artwork">
          <img v-if="diamondGame.coverUrl" :src="diamondGame.coverUrl" :alt="`${diamondGame.name} game artwork`" />
          <Trophy v-else class="diamond-exhibit__fallback" :size="104" :stroke-width="1" aria-hidden="true" />
          <span class="diamond-exhibit__seal">◆</span>
        </div>
        <p class="diamond-exhibit__eyebrow">PERFECT COLLECTION</p>
        <h2 id="trophy-modal-title">{{ diamondGame.name }}</h2>
        <div class="diamond-exhibit__reward"><span>DIAMOND</span><small>100% COMPLETED</small></div>
        <div class="diamond-exhibit__completion"><strong>{{ diamondGame.unlockedCount }}</strong><span>/ {{ diamondGame.achievementCount }} achievements unlocked</span></div>
        <p class="diamond-exhibit__description">Every achievement in this game has been earned. A complete set, preserved in your cabinet.</p>
      </template>
      <template v-else>
        <img v-if="trophy.icon" class="trophy-modal__achievement-image" :src="trophy.icon" :alt="`${trophy.name} achievement icon`" />
        <Trophy v-else class="trophy-modal__trophy-icon" :class="`trophy-modal__trophy-icon--${tier || 'unclassified'}`" :size="150" :stroke-width="1.1" aria-hidden="true" />
        <h2 id="trophy-modal-title">{{ trophy.name }}</h2>
        <div class="trophy-modal__game">
        <img
          v-if="trophy.gameIcon"
          :src="trophy.gameIcon"
          :alt="`${trophy.gameName} icon`"
        /><strong>{{ trophy.gameName }}</strong>
      </div>
      <p>{{ trophy.description || "No description available." }}</p>
        <p v-if="!isUnlocked" class="trophy-modal__locked-state"><LockKeyhole :size="14" /> STILL LOCKED</p>
        <dl>
          <div v-if="isUnlocked && trophy.unlocktime">
            <dt>Unlocked</dt>
            <dd>{{ new Date(trophy.unlocktime * 1000).toLocaleDateString() }}</dd>
          </div>
          <div>
            <dt>Global rarity</dt>
            <dd v-if="trophy.global_percent != null">{{ Number(trophy.global_percent).toFixed(1) }}%</dd>
            <dd v-else>Unavailable</dd>
          </div>
        </dl>
      </template>
    </article>
  </div>
</template>
