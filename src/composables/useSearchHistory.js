import { ref } from 'vue'

export const SEARCH_HISTORY_STORAGE_KEY = 'steam-trophies:search-history'
export const MAX_SEARCH_HISTORY_ITEMS = 10

// Module-level reactive state so all consumers share instant reactivity
const history = ref([])
let isInitialized = false

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const steamId = String(raw.steamId || raw.steamid || '').trim()
  if (!steamId) return null

  return {
    steamId,
    personaName: String(raw.personaName || raw.personaname || 'Steam Player').trim(),
    avatar: String(raw.avatar || raw.avatarmedium || raw.avatarfull || '').trim(),
    profileUrl: String(raw.profileUrl || raw.profileurl || '').trim(),
    lastVisitedAt: Number(raw.lastVisitedAt) || Date.now(),
  }
}

function persistHistory(items) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(items))
    }
  } catch (error) {
    console.warn('Could not persist search history to localStorage:', error)
  }
}

export function loadSearchHistory() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      history.value = []
      return []
    }

    const raw = window.localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY)
    if (!raw) {
      history.value = []
      return []
    }

    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      history.value = []
      return []
    }

    const sanitized = parsed
      .map(sanitizeEntry)
      .filter(Boolean)
      .slice(0, MAX_SEARCH_HISTORY_ITEMS)

    history.value = sanitized
    return sanitized
  } catch (error) {
    console.warn('Failed to parse search history from localStorage. Resetting to empty.', error)
    history.value = []
    return []
  }
}

export function addSearchHistoryProfile(profile) {
  if (!profile || typeof profile !== 'object') return null

  const entry = sanitizeEntry(profile)
  if (!entry) return null

  // Ensure fresh timestamp
  entry.lastVisitedAt = Date.now()

  // 1. Remove existing entry with identical steamId to prevent duplicates
  const filtered = history.value.filter((item) => item.steamId !== entry.steamId)

  // 2. Insert at the beginning (most recent first)
  filtered.unshift(entry)

  // 3. Keep at most MAX_SEARCH_HISTORY_ITEMS (10)
  const bounded = filtered.slice(0, MAX_SEARCH_HISTORY_ITEMS)

  // 4. Update reactive state and persist
  history.value = bounded
  persistHistory(bounded)

  return entry
}

export function removeSearchHistoryProfile(steamId) {
  const id = String(steamId || '').trim()
  if (!id) return

  const filtered = history.value.filter((item) => item.steamId !== id)
  history.value = filtered

  if (filtered.length === 0) {
    clearSearchHistory()
  } else {
    persistHistory(filtered)
  }
}

export function clearSearchHistory() {
  history.value = []
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(SEARCH_HISTORY_STORAGE_KEY)
    }
  } catch (error) {
    console.warn('Could not clear search history in localStorage:', error)
  }
}

export function useSearchHistory() {
  if (!isInitialized) {
    loadSearchHistory()
    isInitialized = true
  }

  return {
    history,
    loadHistory: loadSearchHistory,
    addProfile: addSearchHistoryProfile,
    removeProfile: removeSearchHistoryProfile,
    clearHistory: clearSearchHistory,
  }
}

