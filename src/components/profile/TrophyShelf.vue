<script setup>
import { ref } from 'vue'
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import TrophyCard from './TrophyCard.vue'

const props = defineProps({ tier: { type: String, required: true }, label: { type: String, required: true }, trophies: { type: Array, default: () => [] }, loading: { type: Boolean, default: false }, diamonds: { type: Boolean, default: false }, compact: { type: Boolean, default: false } })
const emit = defineEmits(['select', 'select-diamond'])
const rail = ref(null)
let dragState = null
function scrollByShelf(direction) {
  const item = rail.value?.querySelector('.trophy-card, .diamond-trophy')
  const amount = item ? (item.getBoundingClientRect().width + 28) * 4 : 520
  rail.value?.scrollBy({ left: amount * direction, behavior: 'smooth' })
}
function onWheel(event) {
  const node = rail.value
  if (!node) return
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.preventDefault()
    node.scrollLeft += event.deltaY
  }
}
function onDragStart(event) {
  // Only primary mouse drags; touch and pen keep native scrolling/swiping.
  if (event.pointerType !== 'mouse' || event.button !== 0) return
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startScrollLeft: rail.value?.scrollLeft || 0,
    moved: false,
    captured: false,
  }
}
function onDragMove(event) {
  const node = rail.value
  if (!node || !dragState || dragState.pointerId !== event.pointerId) return
  const deltaX = event.clientX - dragState.startX
  if (Math.abs(deltaX) > 4) dragState.moved = true
  if (dragState.moved) {
    if (!dragState.captured) {
      node.setPointerCapture?.(event.pointerId)
      dragState.captured = true
    }
    node.scrollLeft = dragState.startScrollLeft - deltaX
    event.preventDefault()
  }
}
function onDragEnd(event) {
  if (dragState && event?.pointerId !== undefined && dragState.pointerId !== event.pointerId) return
  dragState = null
}
</script>

<template>
  <section class="trophy-shelf" :class="[`trophy-shelf--${tier}`, { 'trophy-shelf--diamond': diamonds, 'trophy-shelf--compact': compact }]" :aria-labelledby="`shelf-${tier}`">
    <header class="trophy-shelf__header">
      <div class="trophy-shelf__title"><p v-if="!compact" class="profile-page__label">THE CABINET</p><h2 :id="`shelf-${tier}`">{{ label }}</h2></div>
      <span v-if="!compact" class="trophy-shelf__count"><span v-if="loading">…</span><span v-else>{{ trophies.length }}</span> <small>{{ trophies.length === 1 ? (diamonds ? 'game' : 'trophy') : (diamonds ? 'games' : 'trophies') }}</small></span>
      <div v-if="!compact" class="trophy-shelf__controls" :aria-label="`${label} shelf navigation`">
        <button type="button" :aria-label="`Scroll ${label} left`" @click="scrollByShelf(-1)"><ChevronLeft :size="17" /></button>
        <button type="button" :aria-label="`Scroll ${label} right`" @click="scrollByShelf(1)"><ChevronRight :size="17" /></button>
      </div>
    </header>
    <div v-if="loading && !compact" class="trophy-shelf__state" role="status">Cataloguing this shelf…</div>
    <div v-else-if="!trophies.length && !compact" class="trophy-shelf__state">{{ diamonds ? 'No diamonds yet' : `No ${label.toLowerCase()} trophies yet` }}</div>
    <div v-else-if="trophies.length" ref="rail" class="trophy-shelf__rail" tabindex="0" :aria-label="`${label} trophy display`" @wheel="onWheel" @pointerdown="onDragStart" @pointermove="onDragMove" @pointerup="onDragEnd" @pointercancel="onDragEnd">
      <template v-if="diamonds">
        <button v-for="game in trophies" :key="game.appid" class="diamond-trophy" type="button" aria-label="View Diamond completion details" @click="emit('select-diamond', game)">
          <span class="diamond-trophy__pedestal"><img v-if="game.coverUrl" :src="game.coverUrl" :alt="`${game.name} game icon`" loading="lazy" /><span v-else class="diamond-trophy__fallback">◇</span><span class="diamond-trophy__mark">◆</span></span>
          <strong>DIAMOND</strong><small>100% completed</small>
        </button>
      </template>
      <TrophyCard v-else v-for="trophy in trophies" :key="`${trophy.appid}-${trophy.apiname}`" :trophy="trophy" @select="emit('select', { ...trophy, tier: trophy.tier || (trophy.global_percent != null && Number(trophy.global_percent) <= 10 ? 'gold' : trophy.global_percent != null && Number(trophy.global_percent) <= 30 ? 'silver' : 'bronze') })" />
    </div>
    <div v-if="!compact" class="trophy-shelf__glass" aria-hidden="true"><span /></div>
  </section>
</template>
