/**
 * The API client.
 *
 * Same origin, always: the dashboard is served by the API process itself, so
 * there is no base URL to configure and no CORS to arrange.
 */
import { ref } from 'vue';
import type {
  Cluster,
  ClusterDetail,
  ContentDetail,
  CreatorReport,
  DashboardData,
  EmbeddingStatus,
  ExampleSet,
  Facets,
  GapAnalysis,
  NicheAnalysis,
  InterestsStatus,
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
  TagAnalysis,
  ThumbnailAnalysis,
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

/**
 * The API token, when the server has been given one.
 *
 * Only needed when `API_TOKEN` is set, which the server insists on before it
 * will bind anything but loopback. Without this the dashboard could not
 * authenticate to its own server: every panel rendered the server's own
 * "invalid or missing API token", with no way to supply one, on the deployment
 * the token exists to protect.
 *
 * In memory like the settings password and for the same reason — a reload asks
 * again rather than leaving a credential where anyone at this browser can read
 * it.
 */
let apiToken: string | null = null;

export function setApiToken(token: string | null): void {
  apiToken = token;
}

export function hasApiToken(): boolean {
  return apiToken !== null;
}

/**
 * The token as a query parameter, for the two places a header cannot go.
 *
 * `EventSource` has no way to set one, and the export is an anchor the browser
 * follows. Empty when no token is configured, so ordinary local use is
 * unchanged.
 */
/**
 * Set when the server refuses a request for want of a token.
 *
 * The dashboard is served by the same process that refuses it, so a 401 means
 * `API_TOKEN` is set and this browser has not been given it — which is a thing
 * the person at the keyboard can fix, if they are asked. Before this, they
 * were shown the server's error in every panel and had nowhere to type it.
 */
export const needsApiToken = ref(false);

export function tokenQuery(existing: string): string {
  if (apiToken === null) return existing;
  const joiner = existing === '' ? '?' : '&';
  return `${existing}${joiner}token=${encodeURIComponent(apiToken)}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
  if (settingsPassword !== null) headers['x-settings-password'] = settingsPassword;
  if (apiToken !== null) headers['x-radar-token'] = apiToken;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    // 401 on the settings routes is the password gate, which has its own
    // prompt; anywhere else it is the API token.
    if (res.status === 401 && !path.startsWith('/settings')) needsApiToken.value = true;
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
  exportUrl: (q: string) => `${BASE}/export${tokenQuery(q)}`,
  timing: (q: string) => request<TimingAnalysis>(`/reports/timing${q}`),
  thumbnails: (q: string) => request<ThumbnailAnalysis>(`/reports/thumbnails${q}`),
  examples: (q: string) => request<ExampleSet>(`/reports/examples${q}`),
  relatedTags: (q: string) => request<TagAnalysis>(`/tags/related${q}`),
  gaps: (q: string) => request<GapAnalysis>(`/gaps${q}`),
  niches: (q: string) => request<NicheAnalysis>(`/niches${q}`),
  facets: () => request<Facets>('/facets'),
  sources: () => request<{ items: SourceInfo[] }>('/sources'),
  runSource: (id: string) =>
    request<{ source: string; ok: boolean; items: number; error: string | null }>(
      `/sources/${encodeURIComponent(id)}/run`,
      { method: 'POST' },
    ),
  health: () => request<HealthData>('/system/health'),
  embedding: () => request<EmbeddingStatus>('/system/embedding'),
  interests: () => request<InterestsStatus>('/system/interests'),
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
    request<{
      applied: string[];
      /** Whether the running radar took the change without being restarted. */
      live: boolean;
      /** Why it did not, when it did not. */
      problems: string[];
      /** The few settings that genuinely cannot take effect until a restart. */
      restartRequired: { key: string; why: string }[];
    }>('/system/settings', {
      method: 'POST',
      body: JSON.stringify(updates),
    }),
};
