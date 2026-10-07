import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useSteamProfilesStore } from '../src/stores/steamProfiles.js'

test('leaving a profile aborts its sync and returning starts a fresh sync', async () => {
  setActivePinia(createPinia())
  const store = useSteamProfilesStore()
  const steamId = '76561198000000011'
  const originalFetch = globalThis.fetch
  const firstRequests = []
  let requestCount = 0

  globalThis.fetch = (url, options = {}) => {
    requestCount += 1
    if (requestCount <= 2) {
      firstRequests.push(options.signal)
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
      })
    }

    const data = String(url).endsWith('/games')
      ? { response: { games: [] } }
      : { response: { players: [{ steamid: steamId, personaname: 'Test profile' }] } }
    return Promise.resolve(new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  }

  try {
    const abandonedSync = store.syncProfile(steamId)
    assert.equal(firstRequests.length, 2)

    store.cancelProfileSync(steamId)
    assert.ok(firstRequests.every((signal) => signal.aborted))
    assert.equal(store.syncs[steamId].phase, 'paused')

    const resumedSync = store.syncProfile(steamId)
    await Promise.all([abandonedSync, resumedSync])

    assert.equal(store.syncs[steamId].phase, 'complete')
    assert.equal(store.syncs[steamId].active, false)
    assert.equal(store.profileFor(steamId).personaname, 'Test profile')
    assert.equal(requestCount, 4)
  } finally {
    globalThis.fetch = originalFetch
  }
})
