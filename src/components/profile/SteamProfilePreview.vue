<script setup>
import { ExternalLink, MoveUpRight, UserRound } from "@lucide/vue";
import { RouterLink } from "vue-router";

const props = defineProps({
  profile: {
    type: Object,
    required: true,
  },
});

const steamProfileUrl = `https://steamcommunity.com/profiles/${props.profile.steamid}`;
const profileRoute = { name: 'profile', params: { steamId: props.profile.steamid } };
</script>

<template>
  <article class="profile-preview" aria-label="Steam profile found">
    <div class="profile-preview__identity">
      <div class="profile-preview__avatar-frame">
        <img
          v-if="profile.avatarfull || profile.avatarmedium"
          class="profile-preview__avatar"
          :src="profile.avatarfull || profile.avatarmedium"
          :alt="`${profile.personaname}'s avatar`"
        />
        <UserRound
          v-else
          class="profile-preview__avatar-fallback"
          :size="28"
          :stroke-width="1.4"
          aria-hidden="true"
        />
      </div>

      <div class="profile-preview__details">
        <p class="profile-preview__eyebrow">Profile located</p>
        <h2 class="profile-preview__name">{{ profile.personaname }}</h2>
        <p v-if="profile.realname" class="profile-preview__real-name">
          {{ profile.realname }}
        </p>
        <p class="profile-preview__steam-id">
          STEAMID <span>{{ profile.steamid }}</span>
        </p>
      </div>
    </div>

    <div class="profile-preview__actions">
      <a
        class="profile-preview__steam-link"
        :href="steamProfileUrl"
        target="_blank"
        rel="noopener noreferrer"
      >
        Steam profile
        <ExternalLink :size="13" :stroke-width="1.7" aria-hidden="true" />
      </a>
      <RouterLink
        class="profile-preview__enter"
        :to="profileRoute"
      >
        View profile
        <MoveUpRight :size="16" :stroke-width="1.7" aria-hidden="true" />
      </RouterLink>
    </div>
  </article>
</template>
