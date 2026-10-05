import { ref } from 'vue'
import en from './locales/en.js'
import es from './locales/es.js'

export const LOCALE_STORAGE_KEY = 'steam-trophies:locale'
export const SUPPORTED_LOCALES = ['en', 'es']

const messages = {
  en,
  es,
}

export function resolveInitialLocale() {
  // 1. Saved preference in localStorage
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY)
      if (saved && SUPPORTED_LOCALES.includes(saved)) {
        return saved
      }
    }
  } catch (_) {}

  // 2. Browser language
  try {
    if (typeof navigator !== 'undefined' && navigator.language) {
      const browserLang = navigator.language.toLowerCase()
      if (browserLang.startsWith('es')) return 'es'
      if (browserLang.startsWith('en')) return 'en'
    }
  } catch (_) {}

  // 3. Fallback
  return 'en'
}

export const locale = ref(resolveInitialLocale())

export function setLocale(newLocale) {
  if (!SUPPORTED_LOCALES.includes(newLocale)) return
  locale.value = newLocale

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, newLocale)
    }
  } catch (error) {
    console.warn('Could not save locale to localStorage:', error)
  }
}

function resolvePath(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined
  const parts = path.split('.')
  let current = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

function interpolate(template, params) {
  if (typeof template !== 'string') return String(template ?? '')
  if (!params || typeof params !== 'object') return template

  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return params[key] !== undefined ? String(params[key]) : match
  })
}

export function t(key, params) {
  // Read current locale reactively
  const activeLocale = locale.value
  const activeDict = messages[activeLocale] || messages.en
  let resolved = resolvePath(activeDict, key)

  // Fallback to English if missing in active dictionary
  if (resolved === undefined && activeLocale !== 'en') {
    resolved = resolvePath(messages.en, key)
  }

  // If key not found anywhere, return the key itself
  if (resolved === undefined) {
    return key
  }

  // Function format
  if (typeof resolved === 'function') {
    return resolved(params)
  }

  // Pluralization format: "one | other"
  if (typeof resolved === 'string' && resolved.includes('|') && params && typeof params.count === 'number') {
    const branches = resolved.split('|').map((b) => b.trim())
    const selected = params.count === 1 ? branches[0] : (branches[1] || branches[0])
    return interpolate(selected, params)
  }

  return interpolate(resolved, params)
}

export function te(key) {
  const activeLocale = locale.value
  const activeDict = messages[activeLocale] || messages.en
  return resolvePath(activeDict, key) !== undefined || resolvePath(messages.en, key) !== undefined
}

export function useI18n() {
  return {
    t,
    te,
    locale,
    setLocale,
    availableLocales: SUPPORTED_LOCALES,
  }
}

const i18nPlugin = {
  install(app) {
    app.config.globalProperties.$t = t
    app.config.globalProperties.$i18n = {
      locale,
      setLocale,
      availableLocales: SUPPORTED_LOCALES,
    }
    app.provide('i18n', {
      t,
      te,
      locale,
      setLocale,
      availableLocales: SUPPORTED_LOCALES,
    })
  },
}

export default i18nPlugin

