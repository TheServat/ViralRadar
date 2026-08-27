import { createApp } from 'vue';
import App from '@/App.vue';
import { router } from '@/router';
import { i18n, initialLocale } from '@/plugins/i18n';
import { createAppVuetify } from '@/plugins/vuetify';

const storedTheme = localStorage.getItem('radar.theme');
const theme = storedTheme === 'light' ? 'light' : 'dark';
const locale = initialLocale();

createApp(App)
  .use(router)
  .use(i18n)
  .use(createAppVuetify(theme, locale))
  .mount('#app');
