<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Check, Diamond, LockKeyhole, Trophy, X } from "@lucide/vue";
import { getTrophyTier } from "../../data/trophyTiers.js";

const props = defineProps({ trophy: { type: Object, default: null } });
const emit = defineEmits(["close"]);
const tier = computed(() => getTrophyTier(props.trophy?.global_percent));
const isDiamond = computed(() => props.trophy?.isDiamond === true);
const isUnlocked = computed(() => props.trophy?.achieved === true || Number(props.trophy?.achieved) === 1);
const diamondGame = computed(() => props.trophy?.game || null);
const gameIsCompleted = computed(() => Boolean(diamondGame.value?.isDiamond));
const modalRoot = ref(null);
const closeButton = ref(null);
const shineKey = ref(0);
const shineActive = ref(false);
const iconFailed = ref(false);
let previousFocus = null;
let shineTimer = 0;
let shineResetTimer = 0;

function clearShineTimers() {
  window.clearTimeout(shineTimer);
  window.clearTimeout(shineResetTimer);
  shineTimer = 0;
  shineResetTimer = 0;
}

function scheduleShine() {
  if (!props.trophy || isDiamond.value || !isUnlocked.value) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  shineTimer = window.setTimeout(() => {
    shineKey.value += 1;
    shineActive.value = true;
    shineResetTimer = window.setTimeout(() => {
      shineActive.value = false;
      scheduleShine();
    }, 750);
  }, 5000 + Math.random() * 5000);
}

function handleKey(event) {
  if (event.key === "Escape") emit("close");
  if (event.key === "Tab" && modalRoot.value) {
    const focusable = [...modalRoot.value.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
watch(() => props.trophy, async (trophy, previousTrophy) => {
  clearShineTimers();
  shineActive.value = false;
  iconFailed.value = false;
  if (!trophy) {
    previousFocus?.focus?.();
    previousFocus = null;
    return;
  }
  scheduleShine();
  if (!previousTrophy) previousFocus = document.activeElement;
  await nextTick();
  closeButton.value?.focus();
});
onMounted(() => window.addEventListener("keydown", handleKey));
onBeforeUnmount(() => {
  clearShineTimers();
  window.removeEventListener("keydown", handleKey);
  previousFocus?.focus?.();
});
</script>

<template>
  <Transition name="trophy-modal">
    <div
      v-if="trophy"
      ref="modalRoot"
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
        `trophy-tier--${tier || 'unclassified'}`,
        { 'trophy-modal__card--diamond': isDiamond, 'trophy-modal__card--locked': !isUnlocked && !isDiamond, 'trophy-modal__card--diamond-locked': isDiamond && !gameIsCompleted },
      ]"
      :style="isDiamond && diamondGame && (diamondGame.headerUrl || diamondGame.coverUrl) ? { '--modal-artwork': `url('${diamondGame.headerUrl || diamondGame.coverUrl}')` } : undefined"
    >
      <button
        ref="closeButton"
        class="trophy-modal__close"
        type="button"
        :aria-label="$t('profile.modal.closeAria')"
        @click="$emit('close')"
      >
        <X :size="18" />
      </button>

      <template v-if="isDiamond && diamondGame">
        <div class="diamond-exhibit__halo" aria-hidden="true">
          <div class="diamond-exhibit__orbit diamond-exhibit__orbit--one" />
          <div class="diamond-exhibit__orbit diamond-exhibit__orbit--two" />
        </div>
        <div class="diamond-exhibit__gem" :class="{ 'diamond-exhibit__gem--locked': !gameIsCompleted }" aria-hidden="true">
          <span class="diamond-exhibit__ambient" :style="diamondGame.headerUrl || diamondGame.coverUrl ? { '--modal-gem-artwork': `url('${diamondGame.headerUrl || diamondGame.coverUrl}')` } : undefined" />
          <Diamond class="diamond-exhibit__gem-icon" :size="174" :stroke-width="0.9" />
          <span class="diamond-exhibit__facet" />
          <LockKeyhole v-if="!gameIsCompleted" class="diamond-exhibit__gem-lock" :size="22" />
        </div>
        <p class="diamond-exhibit__eyebrow">{{ $t('profile.modal.diamondReward') }}</p>
        <p v-if="!gameIsCompleted" class="diamond-exhibit__locked-label"><LockKeyhole :size="14" /> {{ $t('profile.modal.stillLocked') }}</p>
        <p v-else-if="diamondGame.achievementsUpdatedAt" class="diamond-exhibit__earned-date">{{ $t('profile.modal.completedDate', { date: new Date(Number(diamondGame.achievementsUpdatedAt)).toLocaleDateString() }) }}</p>
        <h2 id="trophy-modal-title">{{ diamondGame.name }}</h2>
        <div class="diamond-exhibit__reward">
          <span>{{ gameIsCompleted ? $t('profile.modal.diamondReward') : $t('profile.modal.lockedTrophy') }}</span>
          <small>{{ gameIsCompleted ? $t('profile.modal.completed') : $t('profile.modal.completeAtHundred') }}</small>
        </div>
        <div class="diamond-exhibit__completion">
          <strong>{{ diamondGame.unlockedCount ?? 0 }}</strong>
          <span>/ {{ diamondGame.achievementCount ?? 0 }} {{ $t('profile.modal.achievements') }}</span>
        </div>
        <p v-if="gameIsCompleted" class="diamond-exhibit__description">{{ $t('profile.modal.diamondDescription') }}</p>
        <p v-else class="diamond-exhibit__description">{{ $t('profile.modal.achievementsRemaining', { count: Math.max(0, Number(diamondGame.achievementCount || 0) - Number(diamondGame.unlockedCount || 0)) }) }}</p>
      </template>

      <template v-else>
        <div class="trophy-modal__piece" :class="[`trophy-modal__piece--${tier || 'unclassified'}`, `trophy-tier--${tier || 'unclassified'}`, { 'trophy-modal__piece--locked': !isUnlocked }]">
          <Trophy
            class="trophy-modal__trophy-icon"
            :class="`trophy-modal__trophy-icon--${tier || 'unclassified'}`"
            :size="150"
            :stroke-width="1.1"
            aria-hidden="true"
          />
          <span
            :key="shineKey"
            class="trophy-modal__shine"
            :class="{ 'trophy-modal__shine--active': shineActive }"
            aria-hidden="true"
          />
        </div>
        <p class="trophy-modal__eyebrow">{{ $t('profile.modal.shelfTier', { tier: $t(`profile.cabinet.${tier || 'unclassified'}`) }) }}</p>
        <div class="trophy-modal__achievement-title">
          <img
            v-if="trophy.icon && !iconFailed"
            class="trophy-modal__achievement-image"
            :src="trophy.icon"
            :alt="`${trophy.name} achievement icon`"
            @error="iconFailed = true"
          />
          <h2 id="trophy-modal-title">{{ trophy.name }}</h2>
        </div>
        <div class="trophy-modal__game">
          <img v-if="trophy.gameIcon" :src="trophy.gameIcon" :alt="`${trophy.gameName} icon`" />
          <strong>{{ trophy.gameName }}</strong>
        </div>
        <p class="trophy-modal__description">{{ trophy.description || $t('game.noDescription') }}</p>
        <p v-if="isUnlocked" class="trophy-modal__unlocked-state"><Check :size="15" /> {{ $t('profile.modal.unlocked') }}</p>
        <p v-else class="trophy-modal__locked-state"><LockKeyhole :size="14" /> {{ $t('profile.modal.stillLocked') }}</p>
        <dl>
          <div>
            <dt>{{ $t('profile.modal.rarity') }}</dt>
            <dd v-if="trophy.global_percent != null">{{ Number(trophy.global_percent).toFixed(2) }}%</dd>
            <dd v-else>—</dd>
          </div>
          <div v-if="isUnlocked && trophy.unlocktime">
            <dt>{{ $t('profile.modal.obtained') }}</dt>
            <dd>{{ new Date(Number(trophy.unlocktime) * 1000).toLocaleDateString() }}</dd>
          </div>
        </dl>
      </template>
    </article>
    </div>
  </Transition>
</template>
