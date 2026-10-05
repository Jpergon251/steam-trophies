import { createRouter, createWebHistory } from 'vue-router'
import LandingPage from '../views/LandingPage.vue'
import ProfilePage from '../views/ProfilePage.vue'
import GamePage from '../views/GamePage.vue'
const routes = [
  {
    path: '/',
    name: 'home',
    component: LandingPage,
  },
  {
    path: '/profile/:steamId/game/:appid',
    name: 'game',
    component: GamePage,
    props: true,
    beforeEnter: (to) => /^\d{17}$/.test(String(to.params.steamId)) && /^\d+$/.test(String(to.params.appid)) || { name: 'home' },
  },
  {
    path: '/profile/:steamId',
    name: 'profile',
    component: ProfilePage,
    props: true,
    beforeEnter: (to) => /^\d{17}$/.test(String(to.params.steamId)) || { name: 'home' },
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: { name: 'home' },
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

export default router
