/**
 * The theme.
 *
 * Carried over from the first dashboard rather than restarted: the dark
 * ink-and-signal palette, the lifecycle colours and the compact density all
 * survive, expressed as Vuetify tokens so every component inherits them
 * instead of each one restating the same hex codes.
 */
import { createVuetify, type ThemeDefinition } from 'vuetify';
import 'vuetify/styles';
import { aliases, svgIcons } from './icons';

/** Lifecycle colours. Shared by chips, charts and the score ring. */
export const STATE_COLORS = {
  VIRAL: '#ff4d5e',
  HOT: '#ff8a3d',
  EMERGING: '#ffd23d',
  RISING: '#46d39a',
  PEAK: '#9b8cff',
  NEW: '#7aa2ff',
  DECLINING: '#7b8496',
  DEAD: '#4a5163',
} as const;

export type TrendState = keyof typeof STATE_COLORS;

const dark: ThemeDefinition = {
  dark: true,
  colors: {
    background: '#0b0d12',
    surface: '#12151d',
    'surface-bright': '#161a24',
    'surface-light': '#1c2130',
    'surface-variant': '#242a38',
    'on-surface-variant': '#98a0b3',
    primary: '#5b8cff',
    secondary: '#9b8cff',
    accent: '#46d39a',
    error: '#ff4d5e',
    warning: '#ff8a3d',
    info: '#5b8cff',
    success: '#46d39a',
    ...STATE_COLORS,
  },
  variables: {
    'border-color': '#242a38',
    'border-opacity': 1,
    'theme-on-surface-faint': '#626b80',
  },
};

const light: ThemeDefinition = {
  dark: false,
  colors: {
    background: '#f5f6f9',
    surface: '#ffffff',
    'surface-bright': '#ffffff',
    'surface-light': '#eef1f7',
    'surface-variant': '#dfe3ec',
    'on-surface-variant': '#59617a',
    primary: '#3567e0',
    secondary: '#6f5cf0',
    accent: '#12a06a',
    error: '#d92a3c',
    warning: '#c96412',
    info: '#3567e0',
    success: '#12a06a',
    ...STATE_COLORS,
  },
  variables: {
    'border-color': '#dfe3ec',
    'border-opacity': 1,
    'theme-on-surface-faint': '#8a92a6',
  },
};

export function createAppVuetify(theme: 'dark' | 'light', locale: 'fa' | 'en' | 'ar') {
  return createVuetify({
    theme: { defaultTheme: theme, themes: { dark, light } },
    icons: { defaultSet: 'mdi', aliases, sets: { mdi: svgIcons } },
    // One switch for direction: components read it from the locale, so no
    // component has to know whether the interface is right-to-left.
    locale: { locale, fallback: 'en', rtl: { fa: true, ar: true, en: false } },
    // Persian and English share one direction switch; Vuetify reads it from
    // the locale, so nothing in a component has to know about direction.
    defaults: {
      global: { ripple: false },
      VCard: { rounded: 'lg', flat: true, border: true },
      VBtn: { variant: 'tonal', density: 'comfortable', class: 'text-none' },
      VTextField: { variant: 'outlined', density: 'compact', hideDetails: 'auto' },
      VSelect: { variant: 'outlined', density: 'compact', hideDetails: 'auto' },
      VAutocomplete: { variant: 'outlined', density: 'compact', hideDetails: 'auto' },
      VChip: { size: 'small', label: true },
      VTable: { density: 'comfortable' },
      VList: { density: 'compact' },
      VTooltip: { location: 'top' },
    },
  }) as ReturnType<typeof createVuetify> & { locale: { isRtl: { value: boolean } } };
}

export const RTL = { fa: true, ar: true, en: false } as const;
