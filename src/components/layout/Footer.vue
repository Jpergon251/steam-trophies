<template>
  <footer class="app-footer" role="contentinfo">
    <div class="app-footer__ambient" aria-hidden="true" />
    <div class="app-footer__inner">
      <div class="app-footer__brand">
        <div class="app-footer__title-row">
          <span class="app-footer__mark" aria-hidden="true">
            <Trophy :size="15" :stroke-width="1.6" />
          </span>
          <span class="app-footer__title">{{ $t('footer.title') }}</span>
        </div>
        <p class="app-footer__tagline">{{ $t('footer.tagline') }}</p>
        <p class="app-footer__tech">{{ $t('footer.builtWith') }}</p>
      </div>

      <div class="app-footer__meta">
        <div class="app-footer__links">
          <a
            class="app-footer__link"
            href="https://github.com/Jpergon251/steam-trophies"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub repository"
          >
            <svg
              class="app-footer__icon"
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
              />
            </svg>
            <span>{{ $t('footer.github') }}</span>
          </a>

          <span class="app-footer__separator" aria-hidden="true">·</span>

          <a
            class="app-footer__link"
            href="https://github.com/Jpergon251/steam-trophies/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ $t('footer.license') }}
          </a>
        </div>

        <p class="app-footer__author">{{ $t('footer.author') }}</p>
        <p class="app-footer__disclaimer">{{ $t('footer.disclaimer') }}</p>
      </div>
    </div>
  </footer>
</template>

<script setup>
import { Trophy } from '@lucide/vue'
</script>

<style scoped>
.app-footer {
  position: relative;
  z-index: 10;
  width: 100%;
  margin-top: auto;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: #050505;
  color: #a1a1a1;
  font-family: inherit;
}

.app-footer__inner {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 2rem;
  max-width: 1440px;
  margin: 0 auto;
  padding: 2.25rem clamp(1rem, 4vw, 4rem) 2.5rem;
}

.app-footer__brand {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 420px;
}

.app-footer__title-row {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.app-footer__mark {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  color: #f5f5f5;
}

.app-footer__title {
  color: #f5f5f5;
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.app-footer__tagline {
  margin: 0;
  color: #a1a1a1;
  font-size: 0.8125rem;
  line-height: 1.5;
}

.app-footer__tech {
  margin: 0;
  color: #6b6b6b;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  letter-spacing: 0.02em;
}

.app-footer__meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.5rem;
  max-width: 480px;
  text-align: right;
}

.app-footer__links {
  display: inline-flex;
  align-items: center;
  gap: 0.65rem;
}

.app-footer__link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: #f5f5f5;
  font-size: 0.8125rem;
  font-weight: 500;
  text-decoration: none;
  transition: color 180ms ease, opacity 180ms ease;
}

.app-footer__link:hover {
  color: #ffffff;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.app-footer__separator {
  color: #454545;
}

.app-footer__author {
  margin: 0;
  color: #a1a1a1;
  font-size: 0.78rem;
  line-height: 1.4;
}

.app-footer__disclaimer {
  margin: 0.25rem 0 0;
  color: #555555;
  font-size: 0.6875rem;
  line-height: 1.45;
}

@media (max-width: 768px) {
  .app-footer__inner {
    flex-direction: column;
    align-items: flex-start;
    gap: 1.5rem;
    padding-top: 1.75rem;
    padding-bottom: 2rem;
  }

  .app-footer__meta {
    align-items: flex-start;
    text-align: left;
  }
}
</style>