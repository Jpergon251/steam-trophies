<script setup>
import { RouterView } from 'vue-router'
import Header from './components/layout/Header.vue'
import Footer from './components/layout/Footer.vue'
</script>

<template>
  <div class="app-layout">
    <main class="app-main">
      <RouterView v-slot="{ Component, route }">
        <Transition name="page-transition" mode="out-in">
          <div :key="route.path">
            <Header v-if="route.name === 'home' || route.name === 'profile'" />
            <component :is="Component" />
            <Footer v-if="route.name === 'home'" />
          </div>
        </Transition>
      </RouterView>
    </main>
  </div>
</template>

