<script setup>
import { RouterView } from 'vue-router'
import Header from './components/layout/Header.vue'
import Footer from './components/layout/Footer.vue'

const randomBetween = (min, max) => Math.random() * (max - min) + min
const randomSign = () => (Math.random() < 0.5 ? -1 : 1)
const trophyParticleColors = [
  { color: '#e3a15d', glow: 'rgba(227, 161, 93, 0.42)' },
  { color: '#f0f2f4', glow: 'rgba(240, 242, 244, 0.36)' },
  { color: '#ffe58a', glow: 'rgba(255, 229, 138, 0.4)' },
  { color: '#e2f8ff', glow: 'rgba(226, 248, 255, 0.44)' },
]
const particleCount = Math.round(randomBetween(18, 22))
const brightParticleIndex = Math.floor(Math.random() * Math.min(particleCount, 12))

const particles = Array.from(
  { length: particleCount },
  (_, index) => {
    const bright = index === brightParticleIndex || Math.random() < 0.06
    const tierColor = Math.random() < 0.34
      ? trophyParticleColors[Math.floor(Math.random() * trophyParticleColors.length)]
      : null
    const crossing = !bright && Math.random() < 0.18
    const duration = bright
      ? randomBetween(75, 110)
      : crossing
        ? randomBetween(55, 95)
        : randomBetween(45, 85)
    const driftDistance = crossing ? randomBetween(72, 112) : randomBetween(8, 34)
    const driftDirection = randomSign()
    const driftY = randomBetween(-13, 13)
    const endX = driftDirection * driftDistance
    const turnOneX = randomBetween(-16, 16)
    const turnTwoX = randomBetween(-16, 16)
    const turnOneY = randomBetween(-12, 12)
    const turnTwoY = randomBetween(-12, 12)
    const turnOne = {
      x: endX * 0.25 + turnOneX,
      y: driftY * 0.25 + turnOneY,
    }
    const turnTwo = {
      x: endX * 0.7 + turnTwoX,
      y: driftY * 0.7 + turnTwoY,
    }

    return {
      id: index,
      bright,
      crossing,
      style: {
        '--particle-x': `${randomBetween(2, 98).toFixed(1)}%`,
        '--particle-y': `${randomBetween(5, 95).toFixed(1)}%`,
        '--particle-size': `${randomBetween(bright ? 2 : 1.5, bright ? 3.2 : 4.2).toFixed(1)}px`,
        '--particle-duration': `${duration.toFixed(1)}s`,
        '--particle-delay': `${(-randomBetween(0, duration)).toFixed(1)}s`,
        '--particle-drift-x': `${endX.toFixed(1)}vw`,
        '--particle-drift-x-mobile': `${(driftDirection * Math.min(driftDistance, crossing ? 90 : 20)).toFixed(1)}vw`,
        '--particle-drift-y': `${driftY.toFixed(1)}vh`,
        '--particle-drift-y-mobile': `${(driftY * 0.65).toFixed(1)}vh`,
        '--particle-turn-one-x': `${turnOne.x.toFixed(1)}vw`,
        '--particle-turn-one-x-mobile': `${(turnOne.x * 0.6).toFixed(1)}vw`,
        '--particle-turn-one-y': `${turnOne.y.toFixed(1)}vh`,
        '--particle-turn-one-y-mobile': `${(turnOne.y * 0.65).toFixed(1)}vh`,
        '--particle-turn-two-x': `${turnTwo.x.toFixed(1)}vw`,
        '--particle-turn-two-x-mobile': `${(turnTwo.x * 0.6).toFixed(1)}vw`,
        '--particle-turn-two-y': `${turnTwo.y.toFixed(1)}vh`,
        '--particle-turn-two-y-mobile': `${(turnTwo.y * 0.65).toFixed(1)}vh`,
        '--peak-opacity': bright
          ? randomBetween(0.46, 0.58).toFixed(2)
          : randomBetween(0.2, 0.34).toFixed(2),
        ...(tierColor && {
          '--particle-color': tierColor.color,
          '--particle-glow-color': tierColor.glow,
        }),
      },
    }
  },
)
</script>

<template>
  <div class="app-layout">
    <div class="ambient-particles" aria-hidden="true">
      <span
        v-for="particle in particles"
        :key="particle.id"
        class="ambient-particle"
        :class="{
          'ambient-particle--bright': particle.bright,
          'ambient-particle--crossing': particle.crossing,
        }"
        :style="particle.style"
      />
    </div>
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
