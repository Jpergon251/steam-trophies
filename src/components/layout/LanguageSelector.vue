<template>
  <div ref="containerRef" class="lang-selector">
    <button
      type="button"
      class="lang-selector__trigger"
      :aria-expanded="isOpen"
      aria-haspopup="listbox"
      :aria-label="$t('header.language')"
      @click="toggleDropdown"
    >
      <span class="lang-selector__flag" aria-hidden="true">{{ currentOption.flag }}</span>
      <span class="lang-selector__code">{{ currentOption.code }}</span>
      <ChevronDown
        class="lang-selector__chevron"
        :class="{ 'is-open': isOpen }"
        :size="13"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>

    <Transition name="lang-dropdown-fade">
      <ul
        v-if="isOpen"
        class="lang-selector__menu"
        role="listbox"
        :aria-label="$t('header.language')"
      >
        <li
          v-for="opt in options"
          :key="opt.key"
          class="lang-selector__item"
          :class="{ 'is-active': locale === opt.key }"
          role="option"
          :aria-selected="locale === opt.key"
          @click="selectLanguage(opt.key)"
        >
          <span class="lang-selector__item-flag" aria-hidden="true">{{ opt.flag }}</span>
          <span class="lang-selector__item-label">{{ opt.label }}</span>
          <span v-if="locale === opt.key" class="lang-selector__item-active-dot" aria-hidden="true" />
        </li>
      </ul>
    </Transition>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronDown } from '@lucide/vue'
import { useI18n } from '../../i18n'

const { locale, setLocale, t } = useI18n()

const isOpen = ref(false)
const containerRef = ref(null)

const options = computed(() => [
  { key: 'es', code: 'ES', label: t('header.languages.es'), flag: '🇪🇸' },
  { key: 'en', code: 'EN', label: t('header.languages.en'), flag: '🇬🇧' },
])

const currentOption = computed(() => {
  return options.value.find((o) => o.key === locale.value) || options.value[1]
})

function toggleDropdown() {
  isOpen.value = !isOpen.value
}

function selectLanguage(key) {
  setLocale(key)
  isOpen.value = false
}

function handleClickOutside(event) {
  if (containerRef.value && !containerRef.value.contains(event.target)) {
    isOpen.value = false
  }
}

function handleKeydown(event) {
  if (event.key === 'Escape' && isOpen.value) {
    isOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.lang-selector {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.lang-selector__trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.55rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: #a1a1a1;
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 180ms ease;
  user-select: none;
}

.lang-selector__trigger:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.16);
  color: #f5f5f5;
}

.lang-selector__flag {
  font-size: 0.9rem;
  line-height: 1;
}

.lang-selector__code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  letter-spacing: 0.04em;
}

.lang-selector__chevron {
  color: #6b6b6b;
  transition: transform 180ms ease, color 180ms ease;
}

.lang-selector__chevron.is-open {
  transform: rotate(180deg);
  color: #f5f5f5;
}

.lang-selector__menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 200;
  min-width: 130px;
  margin: 0;
  padding: 0.3rem;
  list-style: none;
  background: rgba(18, 18, 18, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(20px);
}

.lang-selector__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  border-radius: 5px;
  color: #a1a1a1;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 120ms ease;
}

.lang-selector__item:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #f5f5f5;
}

.lang-selector__item.is-active {
  color: #f5f5f5;
  font-weight: 500;
}

.lang-selector__item-flag {
  font-size: 0.95rem;
}

.lang-selector__item-label {
  flex: 1;
}

.lang-selector__item-active-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.8);
}

.lang-dropdown-fade-enter-active,
.lang-dropdown-fade-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.lang-dropdown-fade-enter-from,
.lang-dropdown-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>

