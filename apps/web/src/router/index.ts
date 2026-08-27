import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

/**
 * Pages are lazily imported, so opening the dashboard does not download the
 * reports and settings screens with it.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'dashboard', component: () => import('@/pages/DashboardPage.vue') },
  { path: '/brief', name: 'brief', component: () => import('@/pages/BriefPage.vue') },
  { path: '/trends', name: 'trends', component: () => import('@/pages/TrendsPage.vue') },
  { path: '/topics', name: 'topics', component: () => import('@/pages/ClustersPage.vue') },
  { path: '/creators', name: 'creators', component: () => import('@/pages/CreatorsPage.vue') },
  { path: '/reports', name: 'reports', component: () => import('@/pages/ReportsPage.vue') },
  { path: '/sources', name: 'sources', component: () => import('@/pages/SourcesPage.vue') },
  { path: '/system', name: 'system', component: () => import('@/pages/SystemPage.vue') },
  { path: '/settings', name: 'settings', component: () => import('@/pages/SettingsPage.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
