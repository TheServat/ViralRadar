/**
 * The API client.
 *
 * Same origin, always: the dashboard is served by the API process itself, so
 * there is no base URL to configure and no CORS to arrange.
 */
import type {
  Cluster,
  ClusterDetail,
  ContentDetail,
  CreatorReport,
  DashboardData,
  Facets,
  HealthData,
  Intervention,
  Page,
  RadarEvent,
  ReportsData,
  SettingsData,
  SourceInfo,
  TrendItem,
} from './types';

const BASE = '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

/** Drops empty values so an unset filter never appears in the URL. */
export function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s === '' ? '' : `?${s}`;
}

export const api = {
  dashboard: () => request<DashboardData>('/dashboard'),
  trends: (q: string) => request<Page<TrendItem>>(`/trends${q}`),
  viral: (q: string) => request<Page<TrendItem>>(`/trends/viral${q}`),
  emerging: (q: string) => request<Page<TrendItem>>(`/trends/emerging${q}`),
  rising: (q: string) => request<Page<TrendItem>>(`/trends/rising${q}`),
  clusters: (q: string) => request<{ items: Cluster[] }>(`/clusters${q}`),
  cluster: (id: string) => request<ClusterDetail>(`/clusters/${encodeURIComponent(id)}`),
  content: (id: string) => request<ContentDetail>(`/content/${encodeURIComponent(id)}`),
  breakouts: (q: string) => request<{ items: TrendItem[] }>(`/creators/breakouts${q}`),
  creators: (q: string) => request<{ items: CreatorReport[] }>(`/creators${q}`),
  reports: (q: string) => request<ReportsData>(`/reports${q}`),
  facets: () => request<Facets>('/facets'),
  sources: () => request<{ items: SourceInfo[] }>('/sources'),
  runSource: (id: string) =>
    request<{ source: string; ok: boolean; items: number; error: string | null }>(
      `/sources/${encodeURIComponent(id)}/run`,
      { method: 'POST' },
    ),
  health: () => request<HealthData>('/system/health'),
  interventions: () => request<{ items: Intervention[] }>('/system/interventions'),
  resolveIntervention: (id: string) =>
    request<{ resolved: boolean }>(`/system/interventions/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
    }),
  events: (q: string) => request<{ items: RadarEvent[] }>(`/events${q}`),
  collect: () => request<{ queued: boolean }>('/system/collect', { method: 'POST' }),
  analyze: () => request<unknown>('/system/analyze', { method: 'POST' }),
  settings: () => request<SettingsData>('/system/settings'),
  saveSettings: (updates: Record<string, string>) =>
    request<{ applied: string[]; restartRequired: boolean }>('/system/settings', {
      method: 'POST',
      body: JSON.stringify(updates),
    }),
};
