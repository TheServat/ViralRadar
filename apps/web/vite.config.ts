import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';

export default defineConfig({
  // Built into web/dist, which is what the Node server serves. There is no
  // second port and no separate web server: one process, one origin.
  plugins: [vue(), vuetify({ autoImport: true })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Vuetify dominates the bundle; splitting it keeps the app chunk small
        // enough that a change to a page does not invalidate everything.
        manualChunks: {
          vuetify: ['vuetify'],
          vendor: ['vue', 'vue-router', 'vue-i18n'],
        },
      },
    },
  },
  server: {
    // Only used by `npm run web:dev`; production is served by the API itself.
    proxy: { '/api': 'http://127.0.0.1:7788' },
  },
});
