<script setup>
defineProps({
  game: { type: Object, required: true },
  compact: { type: Boolean, default: false },
})
defineEmits(['select'])
</script>

<template>
  <button class="game-card" :class="{ 'game-card--compact': compact }" type="button" @click="$emit('select', game)">
    <img
      class="game-card__image"
      :src="
        game.img_icon_url
          ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg`
          : ''
      "
      :alt="`${game.name} icon`"
    />
    <span class="game-card__body">
      <strong>{{ game.name }}</strong>
      <span v-if="game.playtime_2weeks">{{ Math.round(game.playtime_2weeks / 60) }} h recently</span>
      <span v-else>{{ Math.round((game.playtime_forever || 0) / 60) }} h played</span>
      <span v-if="game.achievement_count">{{ game.achievements_unlocked ?? 0 }} / {{ game.achievement_count }} achievements</span>
      <span v-else>No trophy data yet</span>
    </span>
    <span class="game-card__arrow">View →</span>
  </button>
</template>
