<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, Diamond } from "@lucide/vue";

import VirtualTrophyRail from "./VirtualTrophyRail.vue";
import { getTrophyTier } from "../../data/trophyTiers.js";

const props = defineProps({
  tier: { type: String, required: true },
  label: { type: String, required: true },
  trophies: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  diamonds: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
});

const emit = defineEmits(["select", "select-diamond", "request-achievement-icons"]);

const rail = ref(null);
const track = ref(null);
const activeIndex = ref(0);
const activeVirtualIndex = ref(0);
const windowAnchorIndex = ref(0);
const touchStart = ref(null);
const virtualStart = ref(0);
const virtualEnd = ref(Math.min(props.trophies.length, 30));
const beforeSpacerWidth = ref(0);
const afterSpacerWidth = ref(0);
const railWidth = ref(0);
const railPaddingStart = ref(0);
const itemGap = ref(0);
const cardWidth = ref(208);

const isDiamondLoop = computed(
  () => props.diamonds && props.trophies.length > 2,
);

const indexedTrophies = computed(() => {
  const count = props.trophies.length;

  if (isDiamondLoop.value) {
    return Array.from({ length: 5 }, (_, slot) => {
      const virtualIndex = windowAnchorIndex.value + slot - 2;
      const index = ((virtualIndex % count) + count) % count;

      return {
        item: props.trophies[index],
        index,
        virtualIndex,
      };
    });
  }

  return props.trophies.map((item, index) => ({
    item,
    index,
    virtualIndex: index,
  }));
});

let dragState = null;
let scrollFrame = 0;
let scrollEndTimer = 0;
let navigationFrame = 0;
let virtualFrame = 0;
let resizeObserver;
let diamondNavigationInProgress = false;
let originalScrollBehavior = null;
let originalScrollSnapType = null;

function cancelNavigationAnimation() {
  if (navigationFrame) {
    cancelAnimationFrame(navigationFrame);
    navigationFrame = 0;
  }

  if (originalScrollBehavior !== null && rail.value) {
    rail.value.style.scrollBehavior = originalScrollBehavior;
    originalScrollBehavior = null;
  }
  if (originalScrollSnapType !== null && rail.value) {
    rail.value.style.scrollSnapType = originalScrollSnapType;
    originalScrollSnapType = null;
  }
}

function getDisplayCards() {
  return [
    ...(rail.value?.querySelectorAll(
      ".trophy-card, .diamond-trophy",
    ) || []),
  ];
}

function measureDiamondScaleMetrics() {
  if (!props.diamonds || !rail.value || !isDiamondLoop.value) return;

  const cards = getDisplayCards();
  if (cards.length < 3) return;

  const node = rail.value;
  const railBounds = node.getBoundingClientRect();
  const viewportLeft = railBounds.left + (node.offsetWidth - node.clientWidth) / 2;
  const centers = cards.map((card) => {
    const bounds = card.getBoundingClientRect();
    return bounds.left + bounds.width / 2 - viewportLeft + node.scrollLeft;
  });
  const stride = Math.abs(centers[3] - centers[2]);
  if (!stride) return;

  const styles = getComputedStyle(cards[2]);
  return {
    cards,
    centers,
    stride,
    centerScale: Number.parseFloat(styles.getPropertyValue("--diamond-center-scale")) || 1.1,
    adjacentScale: Number.parseFloat(styles.getPropertyValue("--diamond-adjacent-scale")) || 0.92,
    distantScale: Number.parseFloat(styles.getPropertyValue("--diamond-distant-scale")) || 0.86,
  };
}

function updateDiamondScales(metrics = measureDiamondScaleMetrics()) {
  if (!metrics || !rail.value) return;

  const center = rail.value.scrollLeft + rail.value.clientWidth / 2;
  const updates = [];
  let closestCard = null;
  let closestDistance = Infinity;
  metrics.cards.forEach((card, index) => {
    const distance = Math.abs(metrics.centers[index] - center) / metrics.stride;
    if (distance < closestDistance) {
      closestDistance = distance;
      closestCard = card;
    }
    const scale = distance < 1
      ? metrics.centerScale + (metrics.adjacentScale - metrics.centerScale) * distance
      : distance < 2
        ? metrics.adjacentScale + (metrics.distantScale - metrics.adjacentScale) * (distance - 1)
        : metrics.distantScale;
    updates.push({ card, scale });
  });
  updates.forEach(({ card, scale }) => {
    card.style.setProperty("--diamond-scale", scale.toFixed(3));
    card.style.zIndex = "1";
  });
  if (closestCard) closestCard.style.zIndex = "5";
}

function updateVirtualWindow() {
  const count = props.trophies.length;
  const stride = cardWidth.value + itemGap.value;

  if (!rail.value || !count || stride <= 0) {
    virtualStart.value = 0;
    virtualEnd.value = count;
    beforeSpacerWidth.value = 0;
    afterSpacerWidth.value = 0;
    return;
  }

  const firstVisible = Math.max(
    0,
    Math.floor((rail.value.scrollLeft - railPaddingStart.value) / stride),
  );
  const visibleEnd = Math.ceil(
    (rail.value.scrollLeft + railWidth.value - railPaddingStart.value) / stride,
  ) + 1;
  const overscan = Math.ceil(railWidth.value / stride);
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(count, Math.max(start + 1, visibleEnd + overscan));

  const beforeWidth = start ? Math.max(0, start * stride - itemGap.value) : 0;
  const trailingCount = count - end;
  const afterWidth = trailingCount
    ? Math.max(0, trailingCount * stride - itemGap.value)
    : 0;

  if (start !== virtualStart.value) virtualStart.value = start;
  if (end !== virtualEnd.value) virtualEnd.value = end;
  if (beforeWidth !== beforeSpacerWidth.value) beforeSpacerWidth.value = beforeWidth;
  if (afterWidth !== afterSpacerWidth.value) afterSpacerWidth.value = afterWidth;
}

function measureVirtualRail() {
  if (!rail.value || !track.value) return;

  const styles = getComputedStyle(track.value);
  const trophyCard = track.value.querySelector(".trophy-card");
  if (trophyCard) cardWidth.value = trophyCard.getBoundingClientRect().width;
  railWidth.value = rail.value.clientWidth;
  railPaddingStart.value = Number.parseFloat(styles.paddingInlineStart) || 0;
  itemGap.value = Number.parseFloat(styles.columnGap) || 0;
  updateVirtualWindow();
}

function onVirtualRailScroll() {
  if (virtualFrame) return;
  virtualFrame = requestAnimationFrame(() => {
    virtualFrame = 0;
    updateVirtualWindow();
  });
}

function centerCard(card, behavior = "smooth", onComplete) {
  if (!rail.value || !card) return;

  cancelNavigationAnimation();

  const node = rail.value;
  const railRect = rail.value.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();

  const delta =
    cardRect.left +
    cardRect.width / 2 -
    (railRect.left + rail.value.clientWidth / 2);

  const target = rail.value.scrollLeft + delta;

  const prefersReducedMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  if (behavior !== "smooth" || prefersReducedMotion) {
    const originalBehavior = node.style.scrollBehavior;
    const originalSnapType = node.style.scrollSnapType;
    node.style.scrollBehavior = "auto";
    node.style.scrollSnapType = "none";
    node.scrollLeft = target;
    node.style.scrollBehavior = originalBehavior;
    node.style.scrollSnapType = originalSnapType;
    onComplete?.();
    return;
  }

  if (originalScrollBehavior === null) {
    originalScrollBehavior = node.style.scrollBehavior;
    originalScrollSnapType = node.style.scrollSnapType;
  }
  node.style.scrollBehavior = "auto";
  node.style.scrollSnapType = "none";

  const start = node.scrollLeft;
  const distance = target - start;
  const startedAt = performance.now();
  const duration = 650;
  const scaleMetrics = props.diamonds ? measureDiamondScaleMetrics() : null;

  const animate = (now) => {
    const progress = Math.min((now - startedAt) / duration, 1);
    const easedProgress = progress < 0.5
      ? 4 * progress ** 3
      : 1 - ((-2 * progress + 2) ** 3) / 2;

    if (!rail.value) return;
    node.scrollLeft = start + distance * easedProgress;
    if (scaleMetrics) updateDiamondScales(scaleMetrics);

    if (progress < 1) {
      navigationFrame = requestAnimationFrame(animate);
    } else {
      navigationFrame = 0;
      node.style.scrollBehavior = originalScrollBehavior ?? "";
      node.style.scrollSnapType = originalScrollSnapType ?? "";
      originalScrollBehavior = null;
      originalScrollSnapType = null;
      onComplete?.();
    }
  };

  navigationFrame = requestAnimationFrame(animate);
}

function syncDiamondSelection(recenter = false) {
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

  const selectedVirtualIndex = isDiamondLoop.value
    ? windowAnchorIndex.value + nearestIndex - 2
    : nearestIndex;

  activeVirtualIndex.value = selectedVirtualIndex;
  activeIndex.value = ((selectedVirtualIndex % count) + count) % count;

  if (recenter && isDiamondLoop.value && nearestIndex !== 2) {
    windowAnchorIndex.value = selectedVirtualIndex;
    requestAnimationFrame(() => {
      centerCard(getDisplayCards()[2], "auto");
      updateDiamondScales();
    });
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

  const safeIndex = ((index % count) + count) % count;

  if (!isDiamondLoop.value) {
    activeVirtualIndex.value = safeIndex;
    activeIndex.value = safeIndex;
    centerCard(cards[safeIndex], behavior);
    return;
  }

  const currentIndex = ((activeVirtualIndex.value % count) + count) % count;
  let delta = safeIndex - currentIndex;

  if (delta > count / 2) delta -= count;
  if (delta < -count / 2) delta += count;
  if (Math.abs(delta) === count / 2) {
    delta = Math.sign(index - activeIndex.value) * Math.abs(delta);
  }

  scrollToVirtualIndex(activeVirtualIndex.value + delta, behavior);
}

function scrollToVirtualIndex(virtualIndex, behavior = "smooth") {
  if (isDiamondLoop.value) {
    startDiamondNavigation(virtualIndex);
    return;
  }

  const slot = virtualIndex - windowAnchorIndex.value + 2;
  const card = getDisplayCards()[slot];
  if (!card) return;

  activeVirtualIndex.value = virtualIndex;
  activeIndex.value =
    ((virtualIndex % props.trophies.length) + props.trophies.length) %
    props.trophies.length;
  centerCard(card, behavior);
}

function startDiamondNavigation(targetIndex) {
  if (!isDiamondLoop.value || !rail.value || diamondNavigationInProgress) return;

  const card = getDisplayCards().find(
    (item) => Number(item.dataset.virtualIndex) === targetIndex,
  );
  if (!card || targetIndex === activeVirtualIndex.value) return;

  diamondNavigationInProgress = true;
  if (scrollFrame) {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  }
  clearTimeout(scrollEndTimer);
  centerCard(card, "smooth", () => {
    activeVirtualIndex.value = targetIndex;
    activeIndex.value =
      ((targetIndex % props.trophies.length) + props.trophies.length) %
      props.trophies.length;
    windowAnchorIndex.value = targetIndex;

    nextTick(() => {
      centerCard(getDisplayCards()[2], "auto");
      updateDiamondScales();
      diamondNavigationInProgress = false;
    });
  });
}

function scrollByShelf(direction) {
  if (props.diamonds) {
    if (isDiamondLoop.value) {
      if (diamondNavigationInProgress) return;
      startDiamondNavigation(activeVirtualIndex.value + direction);
      return;
    }

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
    activeVirtualIndex.value = 0;
    windowAnchorIndex.value = 0;
    diamondNavigationInProgress = false;

    await nextTick();

    requestAnimationFrame(() => {
      if (isDiamondLoop.value && rail.value) {
        const cards = getDisplayCards();
        centerCard(cards[2], "auto");
        updateDiamondScales();
      } else if (props.diamonds) {
        scrollToIndex(0, "auto");
      }
      if (!props.diamonds) measureVirtualRail();
    });
  },
  { immediate: true },
);

onMounted(() => {
  if (!props.diamonds) {
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(measureVirtualRail);
    } else {
      window.addEventListener("resize", measureVirtualRail);
    }
    if (rail.value) resizeObserver?.observe(rail.value);
    measureVirtualRail();
  }
});

watch(rail, (element, previousElement) => {
  if (props.diamonds) return;
  if (previousElement) resizeObserver?.unobserve(previousElement);
  if (element) resizeObserver?.observe(element);
  nextTick(measureVirtualRail);
});

function onRailScroll() {
  if (!props.diamonds) {
    onVirtualRailScroll();
    return;
  }

  if (diamondNavigationInProgress) return;

  if (scrollFrame) {
    cancelAnimationFrame(scrollFrame);
  }

  scrollFrame = requestAnimationFrame(() => {
    updateDiamondScales();
    syncDiamondSelection();
  });

  clearTimeout(scrollEndTimer);

  if (!diamondNavigationInProgress) {
    scrollEndTimer = window.setTimeout(() => syncDiamondSelection(true), 120);
  }
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

  if (props.diamonds) {
    cancelNavigationAnimation();
    syncDiamondSelection();
    diamondNavigationInProgress = false;
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
  if (props.diamonds) {
    clearTimeout(scrollEndTimer);
    scrollEndTimer = window.setTimeout(() => syncDiamondSelection(true), 120);
  }
}

onBeforeUnmount(() => {
  cancelAnimationFrame(scrollFrame);
  cancelNavigationAnimation();
  cancelAnimationFrame(virtualFrame);
  clearTimeout(scrollEndTimer);
  resizeObserver?.disconnect();
  window.removeEventListener("resize", measureVirtualRail);
});
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
      v-if="
        !trophies.length &&
        !loading &&
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
        <div ref="track" class="trophy-shelf__track">
          <template v-if="diamonds">
            <button
              v-for="{ item: game, virtualIndex } in indexedTrophies"
              :key="virtualIndex"
              class="diamond-trophy"
              :data-virtual-index="virtualIndex"
              :class="{
                'is-selected':
                  isDiamondLoop &&
                  virtualIndex === activeVirtualIndex,

                'is-adjacent':
                  isDiamondLoop &&
                  Math.abs(virtualIndex - activeVirtualIndex) === 1,
              }"
              type="button"
              :aria-label="`View Diamond completion details for ${game.name}`"
              :aria-current="
                isDiamondLoop &&
                virtualIndex === activeVirtualIndex
                  ? 'true'
                  : undefined
              "
              @click="
                !isDiamondLoop ||
                virtualIndex === activeVirtualIndex
                  ? emit('select-diamond', game)
                  : scrollToVirtualIndex(virtualIndex)
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

          <VirtualTrophyRail
            v-else
            :trophies="trophies"
            :start="virtualStart"
            :end="virtualEnd"
            :before-width="beforeSpacerWidth"
            :after-width="afterSpacerWidth"
            @select="emit('select', {
              ...$event,
              tier:
                getTrophyTier($event.global_percent) ||
                $event.tier ||
                'bronze',
            })"
            @request-achievement-icons="emit('request-achievement-icons', $event)"
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