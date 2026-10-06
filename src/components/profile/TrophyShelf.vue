<script setup>
import { computed, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, Diamond } from "@lucide/vue";

import TrophyCard from "./TrophyCard.vue";
import { getTrophyTier } from "../../data/trophyTiers.js";

const props = defineProps({
  tier: { type: String, required: true },
  label: { type: String, required: true },
  trophies: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  diamonds: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
});

const emit = defineEmits(["select", "select-diamond"]);

const rail = ref(null);
const activeIndex = ref(0);
const touchStart = ref(null);

const isDiamondLoop = computed(
  () => props.diamonds && props.trophies.length > 2,
);

const indexedTrophies = computed(() => {
  const items = props.trophies.map((item, index) => ({
    item,
    index,
  }));

  return isDiamondLoop.value ? [...items, ...items, ...items] : items;
});

let dragState = null;
let scrollFrame = 0;
let scrollEndTimer = 0;

function getDisplayCards() {
  return [
    ...(rail.value?.querySelectorAll(
      ".trophy-card, .diamond-trophy",
    ) || []),
  ];
}

function centerCard(card, behavior = "smooth") {
  if (!rail.value || !card) return;

  const railRect = rail.value.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();

  const delta =
    cardRect.left +
    cardRect.width / 2 -
    (railRect.left + rail.value.clientWidth / 2);

  rail.value.scrollTo({
    left: rail.value.scrollLeft + delta,
    behavior,
  });
}

function syncDiamondSelection() {
  if (!props.diamonds) return;

  const cards = getDisplayCards();

  if (!rail.value || !cards.length || !props.trophies.length) return;

  const center =
    rail.value.getBoundingClientRect().left +
    rail.value.clientWidth / 2;

  let nearestIndex = 0;
  let nearestDistance = Infinity;

  cards.forEach((card, index) => {
    const bounds = card.getBoundingClientRect();

    const distance = Math.abs(
      bounds.left +
        bounds.width / 2 -
        center,
    );

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });

  const count = props.trophies.length;

  activeIndex.value = nearestIndex % count;

  if (
    isDiamondLoop.value &&
    (nearestIndex < count || nearestIndex >= count * 2)
  ) {
    const targetIndex = count + activeIndex.value;

    const sourceRect =
      cards[nearestIndex].getBoundingClientRect();

    const targetRect =
      cards[targetIndex].getBoundingClientRect();

    rail.value.scrollLeft +=
      targetRect.left - sourceRect.left;
  }
}

function scrollToIndex(index, behavior = "smooth") {
  const count = props.trophies.length;
  const cards = getDisplayCards();

  if (!rail.value || !cards.length || !count) return;

  if (!props.diamonds) {
    rail.value.scrollBy({
      left:
        rail.value.clientWidth *
        0.72 *
        Math.sign(index || 1),
      behavior,
    });

    return;
  }

  const safeIndex =
    (index + count) % count;

  const displayIndex =
    isDiamondLoop.value
      ? count + safeIndex
      : safeIndex;

  activeIndex.value = safeIndex;

  centerCard(
    cards[displayIndex],
    behavior,
  );
}

function scrollByShelf(direction) {
  if (props.diamonds) {
    scrollToIndex(
      activeIndex.value + direction,
    );
  } else {
    rail.value?.scrollBy({
      left:
        rail.value.clientWidth *
        0.72 *
        direction,
      behavior: "smooth",
    });
  }
}

watch(
  () => props.trophies.length,
  async () => {
    activeIndex.value = 0;

    await Promise.resolve();

    requestAnimationFrame(() => {
      if (
        isDiamondLoop.value &&
        rail.value
      ) {
        const cards = getDisplayCards();

        centerCard(
          cards[props.trophies.length],
          "auto",
        );
      } else if (props.diamonds) {
        scrollToIndex(0, "auto");
      }
    });
  },
);

function onRailScroll() {
  if (scrollFrame) {
    cancelAnimationFrame(scrollFrame);
  }

  scrollFrame =
    requestAnimationFrame(
      syncDiamondSelection,
    );

  clearTimeout(scrollEndTimer);

  scrollEndTimer = window.setTimeout(
    syncDiamondSelection,
    120,
  );
}

function onTouchStart(event) {
  touchStart.value = {
    x: event.changedTouches[0]?.clientX,
    y: event.changedTouches[0]?.clientY,
  };
}

function onTouchEnd(event) {
  if (!touchStart.value) return;

  const dx =
    event.changedTouches[0]?.clientX -
    touchStart.value.x;

  const dy =
    event.changedTouches[0]?.clientY -
    touchStart.value.y;

  if (
    Math.abs(dx) > 40 &&
    Math.abs(dx) > Math.abs(dy)
  ) {
    scrollByShelf(
      dx < 0 ? 1 : -1,
    );
  }

  touchStart.value = null;
}

function onWheel(event) {
  const node = rail.value;

  if (!node) return;

  if (
    Math.abs(event.deltaY) >
    Math.abs(event.deltaX)
  ) {
    event.preventDefault();
    node.scrollLeft += event.deltaY;
  }
}

function onDragStart(event) {
  if (
    event.pointerType !== "mouse" ||
    event.button !== 0
  ) {
    return;
  }

  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startScrollLeft:
      rail.value?.scrollLeft || 0,
    moved: false,
    captured: false,
  };
}

function onDragMove(event) {
  const node = rail.value;

  if (
    !node ||
    !dragState ||
    dragState.pointerId !==
      event.pointerId
  ) {
    return;
  }

  const deltaX =
    event.clientX -
    dragState.startX;

  if (Math.abs(deltaX) > 4) {
    dragState.moved = true;
  }

  if (dragState.moved) {
    if (!dragState.captured) {
      node.setPointerCapture?.(
        event.pointerId,
      );

      dragState.captured = true;
    }

    node.scrollLeft =
      dragState.startScrollLeft -
      deltaX;

    event.preventDefault();
  }
}

function onDragEnd(event) {
  if (
    dragState &&
    event?.pointerId !== undefined &&
    dragState.pointerId !==
      event.pointerId
  ) {
    return;
  }

  dragState = null;
}
</script>

<template>
  <section
    class="trophy-shelf"
    :class="[
      `trophy-shelf--${tier}`,
      {
        'trophy-shelf--diamond': diamonds,
        'trophy-shelf--compact': compact,
      },
    ]"
    :aria-labelledby="`shelf-${tier}`"
  >
    <header class="trophy-shelf__header">
      <div class="trophy-shelf__title">
        <p
          v-if="!compact"
          class="profile-page__label"
        >
          THE CABINET
        </p>

        <h2 :id="`shelf-${tier}`">
          {{ label }}
        </h2>
      </div>

      <span
        v-if="!compact"
        class="trophy-shelf__count"
      >
        <span v-if="loading">…</span>

        <span v-else>
          {{ trophies.length }}
        </span>

        <small>
          {{
            trophies.length === 1
              ? diamonds
                ? "game"
                : "trophy"
              : diamonds
                ? "games"
                : "trophies"
          }}
        </small>
      </span>
    </header>

    <div
      v-if="loading && !compact"
      class="trophy-shelf__state"
      role="status"
    >
      Cataloguing this shelf…
    </div>

    <div
      v-else-if="
        !trophies.length &&
        !compact
      "
      class="trophy-shelf__state"
    >
      {{
        diamonds
          ? "No diamonds yet"
          : `No ${label.toLowerCase()} trophies yet`
      }}
    </div>

    <div
      v-else-if="trophies.length"
      class="trophy-display-stage"
      :class="{
        'trophy-display-stage--diamond':
          diamonds,
        'trophy-display-stage--flat':
          !diamonds,
      }"
      @touchstart.passive="onTouchStart"
      @touchend.passive="onTouchEnd"
    >
      <div
        ref="rail"
        class="trophy-shelf__rail"
        tabindex="0"
        :aria-label="`${label} trophy display`"
        @scroll.passive="onRailScroll"
        @wheel="onWheel"
        @pointerdown="onDragStart"
        @pointermove="onDragMove"
        @pointerup="onDragEnd"
        @pointercancel="onDragEnd"
      >
        <div class="trophy-shelf__track">
          <template v-if="diamonds">
            <button
              v-for="(
                { item: game, index: sourceIndex },
                index
              ) in indexedTrophies"
              :key="`${game.appid}-${index}`"
              class="diamond-trophy"
              :class="{
                'is-selected':
                  isDiamondLoop &&
                  index % trophies.length ===
                    activeIndex,

                'is-adjacent':
                  isDiamondLoop &&
                  Math.abs(
                    (index % trophies.length) -
                      activeIndex,
                  ) === 1,
              }"
              type="button"
              :aria-label="`View Diamond completion details for ${game.name}`"
              :aria-current="
                isDiamondLoop &&
                index % trophies.length ===
                  activeIndex
                  ? 'true'
                  : undefined
              "
              @click="
                !isDiamondLoop ||
                index % trophies.length ===
                  activeIndex
                  ? emit(
                      'select-diamond',
                      game,
                    )
                  : scrollToIndex(
                      sourceIndex,
                    )
              "
            >
              <span
                class="diamond-trophy__artwork"
                :style="{
                  backgroundImage: game.headerUrl || game.coverUrl
                    ? `url('${game.headerUrl || game.coverUrl}')`
                    : undefined,
                }"
                aria-hidden="true"
              />
              <span class="diamond-trophy__artwork-overlay" aria-hidden="true" />
              <span class="diamond-trophy__object" aria-hidden="true">
                <Diamond
                  class="diamond-trophy__icon"
                  :size="164"
                  :stroke-width="1.35"
                />
              </span>

              <strong>
                {{
                  $t(
                    "profile.cabinet.diamondTrophyName",
                  )
                }}
              </strong>

              <small>
                {{
                  $t(
                    "profile.cabinet.diamondCompleted",
                  )
                }}
              </small>

              <span
                class="diamond-trophy__game-name"
              >
                {{ game.name }}
              </span>
            </button>
          </template>

          <TrophyCard
            v-else
            v-for="(
              { item: trophy }, index
            ) in indexedTrophies"
            :key="`${trophy.appid}-${trophy.apiname}-${index}`"
            :trophy="trophy"
            @select="
              emit('select', {
                ...$event,
                tier:
                  $event.tier ||
                  getTrophyTier(
                    $event.global_percent,
                  ) ||
                  'bronze',
              })
            "
          />
        </div>
      </div>

      <div
        class="trophy-display-stage__navigation"
        :aria-label="`${label} showcase navigation`"
      >
        <button
          v-if="trophies.length > 1"
          class="trophy-display-stage__arrow trophy-display-stage__arrow--previous"
          type="button"
          :aria-label="`Previous ${label} trophy`"
          @click="scrollByShelf(-1)"
        >
          <ChevronLeft :size="21" />
        </button>

        <span
          v-if="diamonds"
          class="trophy-display-stage__counter"
        >
          {{ String(activeIndex + 1).padStart(2, "0") }}
          /
          {{ String(trophies.length).padStart(2, "0") }}
        </span>

        <button
          v-if="trophies.length > 1"
          class="trophy-display-stage__arrow trophy-display-stage__arrow--next"
          type="button"
          :aria-label="`Next ${label} trophy`"
          @click="scrollByShelf(1)"
        >
          <ChevronRight :size="21" />
        </button>
      </div>
    </div>

    <div
      v-if="!compact"
      class="trophy-shelf__glass"
      aria-hidden="true"
    >
      <span />
    </div>
  </section>
</template>