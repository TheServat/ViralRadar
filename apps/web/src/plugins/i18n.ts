import { createI18n } from 'vue-i18n';
import en from '@/locales/en';
import fa from '@/locales/fa';
import ar from '@/locales/ar';

export type AppLocale = 'en' | 'fa' | 'ar';

/** Everything the interface can speak, in the order the switcher lists them. */
export const LOCALES: readonly { code: AppLocale; label: string; rtl: boolean }[] = [
  { code: 'fa', label: 'فارسی', rtl: true },
  { code: 'en', label: 'English', rtl: false },
  { code: 'ar', label: 'العربية', rtl: true },
];

export function isRtl(locale: string): boolean {
  return LOCALES.find((l) => l.code === locale)?.rtl ?? false;
}

/** Remembered across sessions, otherwise taken from the browser. */
export function initialLocale(): AppLocale {
  const stored = localStorage.getItem('radar.locale');
  if (stored === 'en' || stored === 'fa' || stored === 'ar') return stored;
  const preferred = navigator.language.slice(0, 2);
  return preferred === 'fa' || preferred === 'ar' ? preferred : 'en';
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: 'en',
  messages: { en, fa, ar },
  missingWarn: false,
  fallbackWarn: false,
});
