<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useTheme, useLocale } from 'vuetify';
import {
  busy,
  collectNow,
  health,
  interventions,
  notify,
  refreshFacets,
  refreshHealth,
  refreshInterventions,
  stale,
  startStream,
  stopStream,
  toast,
} from '@/composables/useRadar';
import { useFormat } from '@/composables/useFormat';
import { LOCALES, isRtl, type AppLocale } from '@/plugins/i18n';
import ContentDialog from '@/components/ContentDialog.vue';
import ClusterDialog from '@/components/ClusterDialog.vue';

const { t, locale } = useI18n();
const theme = useTheme();
const vuetifyLocale = useLocale();
const route = useRoute();
const { ago, num } = useFormat();
const drawer = ref(false);

const NAV = [
  { to: '/', key: 'dashboard', icon: 'mdi-view-dashboard-outline' },
  { to: '/brief', key: 'brief', icon: 'mdi-lightbulb-on-outline' },
  { to: '/formats', key: 'formats', icon: 'mdi-format-letter-case' },
  { to: '/trends', key: 'trends', icon: 'mdi-fire' },
  { to: '/topics', key: 'clusters', icon: 'mdi-shape-outline' },
  { to: '/creators', key: 'creators', icon: 'mdi-account-star-outline' },
  { to: '/reports', key: 'reports', icon: 'mdi-chart-box-outline' },
  { to: '/sources', key: 'sources', icon: 'mdi-power-plug-outline' },
  { to: '/system', key: 'system', icon: 'mdi-heart-pulse' },
  { to: '/settings', key: 'settings', icon: 'mdi-cog-outline' },
];

/** Direction follows the interface language; Vuetify handles the rest. */
watch(
  locale,
  (value) => {
    vuetifyLocale.current.value = value;
    document.documentElement.lang = value;
    document.documentElement.dir = isRtl(value) ? 'rtl' : 'ltr';
    localStorage.setItem('radar.locale', value);
  },
  { immediate: true },
);

function toggleTheme(): void {
  const next = theme.global.current.value.dark ? 'light' : 'dark';
  theme.change(next);
  localStorage.setItem('radar.theme', next);
}

function setLocale(code: AppLocale): void {
  locale.value = code;
}

const footerLine = computed(() => {
  const h = health.value;
  if (!h) return '';
  return `${num(h.db.content)} · ${num(h.db.metrics)} · ${h.db.clusters} · ${ago(h.lastDiscovery)}`;
});

let timer: number | undefined;

onMounted(() => {
  void refreshHealth();
  void refreshFacets();
  void refreshInterventions();
  startStream((type) => {
    if (type === 'trend.detected') notify(t('dashboard.viral'));
  });
  timer = window.setInterval(() => {
    void refreshHealth();
  }, 60_000);
});

onUnmounted(() => {
  stopStream();
  if (timer !== undefined) window.clearInterval(timer);
});

async function runCollection(): Promise<void> {
  await collectNow();
  notify(t('app.collectNow'));
}
</script>

<template>
  <v-app>
    <v-app-bar flat border density="comfortable" class="app-bar">
      <v-app-bar-nav-icon class="d-lg-none" @click="drawer = !drawer" />

      <div class="brand ms-2 me-4">
        <v-icon icon="mdi-radar" color="primary" size="22" />
        <div class="d-none d-sm-block">
          <div class="brand-title">{{ $t('app.title') }}</div>
          <div class="brand-tag">{{ $t('app.tagline') }}</div>
        </div>
      </div>

      <div class="d-none d-lg-flex ga-1 flex-1-1">
        <v-btn
          v-for="nav in NAV"
          :key="nav.to"
          :to="nav.to"
          :active="route.path === nav.to"
          :prepend-icon="nav.icon"
          variant="text"
          size="small"
          class="nav-btn"
        >
          {{ $t(`nav.${nav.key}`) }}
        </v-btn>
      </div>
      <v-spacer class="d-lg-none" />

      <v-tooltip :text="stale ? $t('system.lastCollection') : $t('system.ok')">
        <template #activator="{ props }">
          <span v-bind="props" class="pulse" :class="{ stale }" />
        </template>
      </v-tooltip>

      <v-menu>
        <template #activator="{ props: menu }">
          <v-btn v-bind="menu" size="small" variant="text" prepend-icon="mdi-web">
            <span class="locale-mark">{{ LOCALES.find((l) => l.code === locale)?.label }}</span>
          </v-btn>
        </template>
        <v-list density="compact">
          <v-list-item
            v-for="option in LOCALES"
            :key="option.code"
            :active="locale === option.code"
            :title="option.label"
            @click="setLocale(option.code)"
          />
        </v-list>
      </v-menu>
      <v-btn
        :icon="theme.global.current.value.dark ? 'mdi-weather-sunny' : 'mdi-weather-night'"
        size="small"
        variant="text"
        @click="toggleTheme"
      />
      <v-btn
        color="primary"
        size="small"
        :loading="busy"
        prepend-icon="mdi-download"
        class="ms-2 me-2"
        @click="runCollection"
      >
        <span class="d-none d-sm-inline">{{ $t('app.collectNow') }}</span>
      </v-btn>
    </v-app-bar>

    <v-navigation-drawer v-model="drawer" temporary class="d-lg-none">
      <v-list nav>
        <v-list-item
          v-for="nav in NAV"
          :key="nav.to"
          :to="nav.to"
          :prepend-icon="nav.icon"
          :title="$t(`nav.${nav.key}`)"
          @click="drawer = false"
        />
      </v-list>
    </v-navigation-drawer>

    <v-main>
      <v-container fluid class="pa-4 pa-md-6">
        <v-alert
          v-for="item in interventions"
          :key="item.id"
          type="warning"
          variant="tonal"
          density="comfortable"
          class="mb-3"
        >
          <div class="d-flex flex-wrap align-center ga-2">
            <b>{{ item.source }}</b>
            <v-chip size="x-small" variant="tonal">{{ item.type }}</v-chip>
            <span class="text-caption flex-1-1">{{ item.message }}</span>
            <v-btn
              size="x-small"
              variant="text"
              :to="'/system'"
              append-icon="mdi-arrow-right"
            >
              {{ $t('nav.system') }}
            </v-btn>
          </div>
        </v-alert>

        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </v-container>
    </v-main>

    <ContentDialog />
    <ClusterDialog />

    <v-snackbar
      :model-value="toast !== null"
      :timeout="3500"
      location="bottom"
      @update:model-value="toast = null"
    >
      {{ toast?.text }}
    </v-snackbar>

    <v-footer app absolute class="footer text-caption">
      <span class="faint">{{ footerLine }}</span>
      <v-spacer />
      <span class="faint d-none d-md-inline">
        {{ $t('app.title') }} · {{ health?.ai ?? '' }}
      </span>
    </v-footer>
  </v-app>
</template>

<style>
html {
  overflow-y: auto !important;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.14s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>

<style scoped>
.app-bar {
  backdrop-filter: blur(10px);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.brand-title {
  font-size: 0.9rem;
  font-weight: 700;
  line-height: 1.1;
}
.brand-tag {
  font-size: 0.62rem;
  color: rgb(var(--v-theme-on-surface-variant));
}
.nav-btn {
  letter-spacing: 0;
}
.locale-mark {
  font-size: 0.7rem;
  font-weight: 700;
}
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgb(var(--v-theme-success));
  margin-inline-end: 8px;
  animation: pulse 2.4s infinite;
}
.pulse.stale {
  background: rgb(var(--v-theme-on-surface-variant));
  animation: none;
}
@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(var(--v-theme-success), 0.55);
  }
  70% {
    box-shadow: 0 0 0 7px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}
.footer {
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
}
.faint {
  opacity: 0.6;
}
</style>
