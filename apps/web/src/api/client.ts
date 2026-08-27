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
  EmbeddingStatus,
  Facets,
  MissedItem,
  FormatAnalysis,
  HealthData,
  Intervention,
  NotifyStatus,
  Page,
  RadarEvent,
  ReportsData,
  SettingsData,
  SourceInfo,
  TimingAnalysis,
  TrendItem,
} from './types';

const BASE = '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  /** Seconds to wait, when the server answered with a lockout. */
  readonly retryAfterSec: number;
  constructor(message: string, status: number, retryAfterSec = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * The settings password, held in memory only.
 *
 * Deliberately not in localStorage: the point of the gate is that someone who
 * walks up to this browser cannot read the credentials, and a stored password
 * would hand them exactly that. A reload asks again, which is the cost.
 */
let settingsPassword: string | null = null;

export function setSettingsPassword(password: string | null): void {
  settingsPassword = password;
}

export function hasSettingsPassword(): boolean {
  return settingsPassword !== null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
  if (settingsPassword !== null) headers['x-settings-password'] = settingsPassword;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; retryAfterSec?: number };
    throw new ApiError(
      body.error ?? `${res.status} ${res.statusText}`,
      res.status,
      body.retryAfterSec ?? 0,
    );
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
  formats: (q: string) => request<FormatAnalysis>(`/reports/formats${q}`),
  missed: (q: string) => request<{ windowHours: number; items: MissedItem[] }>(`/missed${q}`),
  archive: (id: string, reason: string) =>
    request<{ archived: boolean }>(`/content/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  unarchive: (id: string) =>
    request<{ archived: boolean }>(`/content/${encodeURIComponent(id)}/archive`, {
      method: 'DELETE',
    }),
  /**
   * The export is a file, not JSON, so it is a plain link rather than a fetch:
   * the browser's own download handling is better than anything reconstructed
   * from a blob, and it keeps the Content-Disposition filename.
   */
  exportUrl: (q: string) => `${BASE}/export${q}`,
  timing: (q: string) => request<TimingAnalysis>(`/reports/timing${q}`),
  facets: () => request<Facets>('/facets'),
  sources: () => request<{ items: SourceInfo[] }>('/sources'),
  runSource: (id: string) =>
    request<{ source: string; ok: boolean; items: number; error: string | null }>(
      `/sources/${encodeURIComponent(id)}/run`,
      { method: 'POST' },
    ),
  health: () => request<HealthData>('/system/health'),
  embedding: () => request<EmbeddingStatus>('/system/embedding'),
  interventions: () => request<{ items: Intervention[] }>('/system/interventions'),
  resolveIntervention: (id: string) =>
    request<{ resolved: boolean }>(`/system/interventions/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
    }),
  events: (q: string) => request<{ items: RadarEvent[] }>(`/events${q}`),
  collect: () => request<{ queued: boolean }>('/system/collect', { method: 'POST' }),
  analyze: () => request<unknown>('/system/analyze', { method: 'POST' }),
  settingsStatus: () => request<{ protected: boolean }>('/system/settings/status'),
  settings: () => request<SettingsData>('/system/settings'),
  notifyStatus: () => request<NotifyStatus>('/system/notify'),
  notifyTest: () =>
    request<{ channels: string[]; errors: string[] }>('/system/notify/test', { method: 'POST' }),
  saveSettings: (updates: Record<string, string>) =>
    request<{ applied: string[]; restartRequired: boolean }>('/system/settings', {
      method: 'POST',
      body: JSON.stringify(updates),
    }),
};
