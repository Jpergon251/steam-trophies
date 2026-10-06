const STEAM_BACKEND_URL = (
  import.meta.env.VITE_STEAM_BACKEND_URL || 'http://127.0.0.1:8000'
).replace(/\/$/, '')

async function requestSteamProfile(path, query, parameter = 'q', options = {}) {
  const url = new URL(`${STEAM_BACKEND_URL}${path}`)
  url.searchParams.set(parameter, query)

  let response
  try {
    response = await fetch(url, options)
  } catch (cause) {
    const error = new Error('Unable to reach the Steam profile service.')
    error.cause = cause
    throw error
  }

  if (!response.ok) {
    let message = 'Could not retrieve Steam profile.'

    try {
      const data = await response.json()
      if (typeof data.detail === 'string') message = data.detail
    } catch {
      // Keep a useful fallback when the backend response is not JSON.
    }

    const error = new Error(message)
    error.status = response.status
    throw error
  }

  const data = await response.json()
  const player = data?.response?.players?.[0]

  if (!player?.steamid) {
    const error = new Error('The Steam service returned no profile.')
    error.status = 404
    throw error
  }

  return player
}
function extractSteamIdentifier(input) {
  // If the input looks like a full Steam community URL, extract the identifier.
  // Supports both numeric profile URLs and custom vanity URLs.
  try {
    const url = new URL(input);
    const pathname = url.pathname;
    const match = pathname.match(/\/profiles\/(\d+)/) || pathname.match(/\/id\/([^/]+)/);
    if (match) return match[1];
  } catch {
    // Not a valid URL, treat as raw identifier.
  }
  return input.trim();
}

export function searchSteamProfile(query) {
  const sanitized = extractSteamIdentifier(query);
  return requestSteamProfile('/api/steam/search', sanitized);
}

export function getSteamProfile(steamId, options) {
  return requestSteamProfile('/api/steam/profile', steamId, 'steam_id', options)
}

async function requestSteamJson(path, options = {}) {
  let response
  try {
    response = await fetch(`${STEAM_BACKEND_URL}${path}`, options)
  } catch (cause) {
    const error = new Error('Unable to reach the Steam service.')
    error.cause = cause
    throw error
  }
  if (!response.ok) {
    const error = new Error('Steam data is not available right now.')
    error.status = response.status
    throw error
  }
  return response.json()
}

export function getSteamGames(steamId, options) {
  return requestSteamJson(`/api/steam/profile/${encodeURIComponent(steamId)}/games`, options)
}

export function getSteamAchievements(steamId, appId, options = {}) {
  const { forceRefresh = false, ...requestOptions } = options
  const query = forceRefresh ? '?force_refresh=true' : ''
  return requestSteamJson(
    `/api/steam/profile/${encodeURIComponent(steamId)}/games/${appId}/achievements${query}`,
    requestOptions,
  )
}