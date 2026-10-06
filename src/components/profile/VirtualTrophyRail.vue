<script setup>
import { computed } from 'vue'
import TrophyCard from './TrophyCard.vue'

const props = defineProps({
  trophies: { type: Array, required: true },
  start: { type: Number, required: true },
  end: { type: Number, required: true },
  beforeWidth: { type: Number, required: true },
  afterWidth: { type: Number, required: true },
})

const emit = defineEmits(['select', 'request-achievement-icons'])
const visibleTrophies = computed(() => props.trophies.slice(props.start, props.end))
</script>

<template>
  <span
    v-if="beforeWidth"
    class="trophy-virtual-spacer"
    :style="{ flex: `0 0 ${beforeWidth}px` }"
    aria-hidden="true"
  />
  <TrophyCard
    v-for="(trophy, offset) in visibleTrophies"
    :key="`${trophy.appid}-${trophy.apiname}-${start + offset}`"
    :trophy="trophy"
    @select="emit('select', $event)"
    @request-achievement-icons="emit('request-achievement-icons', $event)"
  />
  <span
    v-if="afterWidth"
    class="trophy-virtual-spacer"
    :style="{ flex: `0 0 ${afterWidth}px` }"
    aria-hidden="true"
  />
</template>
