/**
 * The API surface, typed.
 *
 * These mirror the DTOs in `src/api/routes.ts`. They are written by hand rather
 * than generated: the shapes are small, stable, and reading them here is how a
 * page author learns what is actually available.
 */

export type TrendState =
  | 'NEW'
  | 'EMERGING'
  | 'RISING'
  | 'HOT'
  | 'VIRAL'
  | 'PEAK'
  | 'DECLINING'
  | 'DEAD';

export interface TrendItem {
  id: string;
  source: string;
  url: string;
  title: string;
  contentType: string;
  thumbnail: string | null;
  creator: { id: string | null; name: string | null; url: string | null; followers: number | null; baseline: number | null };
  language: { code: string | null; confidence: number | null };
  country: { code: string | null; confidence: number | null; source: string | null };
  publishedAt: number | null;
  firstSeenAt: number;
  ageHours: number | null;
  state: TrendState;
  score: number;
  confidence: number;
  metrics: {
    primary: { name: string; value: number | null };
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    nativeScore: number | null;
  };
  signals: {
    velocity: number | null;
    acceleration: number | null;
    engagementRate: number | null;
    creatorAnomaly: number | null;
    sourcePercentile: number | null;
    freshness: number | null;
    crossSource: number | null;
  };
  observations: number;
  hashtags: string[];
}

export interface Cluster {
  id: string;
  label: string;
  keywords: string[];
  state: TrendState;
  score: number;
  confidence: number;
  itemCount: number;
  platformCount: number;
  sources: string[];
  languages: { code: string; pct: number }[];
  countries: { code: string; pct: number }[];
  firstSeenAt: number;
  lastSeenAt: number;
  velocity: number | null;
  acceleration: number | null;
  totalViews: number | null;
  totalEngagement: number | null;
  explanation: string | null;
}

export interface ClusterDetail extends Cluster {
  items: TrendItem[];
  history: { ts: number; score: number; item_count: number }[];
}

export interface HashtagTrend {
  keyword: string;
  mentions: number;
  previous: number;
  unique_creators: number;
  source_count: number;
  total_metric: number;
  growth: number;
}

export interface DashboardData {
  generatedAt: number;
  viral: TrendItem[];
  breakingOut: TrendItem[];
  rising: TrendItem[];
  emerging: TrendItem[];
  crossPlatform: Cluster[];
  hashtags: HashtagTrend[];
  stats: DbStats;
}

export interface DbStats {
  content: number;
  metrics: number;
  clusters: number;
  creators: number;
  breakouts: number;
  openInterventions: number;
}

export interface ContentDetail {
  id: string;
  source: string;
  url: string;
  title: string;
  body: string | null;
  contentType: string;
  thumbnail: string | null;
  language: { code: string | null; confidence: number | null };
  country: { code: string | null; confidence: number | null; source: string | null };
  publishedAt: number | null;
  publishedAtSource: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  keywords: string[];
  hashtags: string[];
  state: TrendState;
  score: number | null;
  confidence: number | null;
  signals: {
    velocity: number | null;
    acceleration: number | null;
    engagementRate: number | null;
    creatorAnomaly: number | null;
    sourcePercentile: number | null;
    freshness: number | null;
    crossSource: number | null;
    primaryMetric: string;
    primaryValue: number | null;
    observations: number;
    peakScore: number | null;
    peakAt: number | null;
    scoringVersion: number;
  } | null;
  creator: {
    id: string;
    source: string;
    externalId: string;
    name: string | null;
    followers: number | null;
    medianMetric: number | null;
    p90Metric: number | null;
    p99Metric: number | null;
    sampleCount: number;
  } | null;
  cluster: Cluster | null;
  history: {
    ts: number;
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    nativeScore: number | null;
  }[];
}

export interface SourceCapabilities {
  contentTypes: string[];
  metrics: string[];
  primaryMetric: string;
  engagementReference: number;
  hasAuthor: boolean;
  hasHashtags: boolean;
  hasCountry: boolean;
  supportsRefresh: boolean;
  supportsTrending: boolean;
  supportsSearch: boolean;
  supportsHistoricalMetrics: boolean;
  baseReliability: number;
}

export interface SourceInfo {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  configured: boolean;
  status: string;
  message: string;
  helpUrl: string | null;
  capabilities: SourceCapabilities;
  health: {
    source: string;
    status: string;
    lastRunAt: number | null;
    lastOkAt: number | null;
    lastError: string | null;
    lastErrorKind: string | null;
    consecutiveFailures: number;
    itemsLastRun: number;
    totalItems: number;
    reliability: number;
  } | null;
}

export interface HealthData {
  status: string;
  firstRun: boolean;
  now: number;
  uptimeSec: number;
  scoringVersion: number;
  regions: string[];
  db: DbStats;
  sources: SourceInfo['health'][];
  jobs: {
    name: string;
    everyMs: number;
    lastRunAt: number | null;
    lastDurationMs: number | null;
    lastError: string | null;
    runs: number;
    queued: boolean;
  }[];
  network: { host: string; failures: number; openFor: number; cooldownFor: number }[];
  lastDiscovery: number | null;
  lastAnalysis: number | null;
  ai: string;
}

export interface Intervention {
  id: string;
  source: string;
  type: string;
  message: string;
  url: string | null;
  status: string;
  createdAt: number;
  resolvedAt: number | null;
}

export interface RadarEvent {
  ts: number;
  type: string;
  source: string | null;
  ref_id: string | null;
  payload: unknown;
}

export interface Bucketed {
  key: string;
  n: number;
}

export interface ReportsData {
  windowHours: number;
  bySource: Bucketed[];
  byLanguage: Bucketed[];
  byCountry: Bucketed[];
  byType: Bucketed[];
  byState: Bucketed[];
  timeline: { hour: number; source: string; n: number }[];
  sourceQuality: {
    source: string;
    items: number;
    scored: number;
    avg_score: number | null;
    max_score: number | null;
    with_velocity: number;
    median_observations: number | null;
  }[];
  hashtags: HashtagTrend[];
  activity: { dow: number; hour: number; n: number }[];
  scoreHistogram: { bucket: number; n: number }[];
  scatter: {
    id: string;
    source: string;
    state: TrendState;
    title: string;
    score: number;
    velocity: number | null;
    value: number | null;
    followers: number | null;
    anomaly: number | null;
    engagement: number | null;
    age_hours: number | null;
  }[];
  clusterTraces: {
    id: string;
    label: string;
    source_count: number;
    points: { ts: number; score: number; item_count: number }[];
  }[];
  topDomains: Bucketed[];
  stats: DbStats;
}

export interface CreatorReport {
  id: string;
  source: string;
  external_id: string;
  name: string | null;
  url: string | null;
  followers: number | null;
  median_metric: number | null;
  sample_count: number;
  items: number;
  best_score: number | null;
  avg_score: number | null;
  breakouts: number;
}

export interface Facets {
  languages: Bucketed[];
  countries: Bucketed[];
  sources: Bucketed[];
}

export interface SettingValue {
  key: string;
  kind: 'text' | 'number' | 'boolean' | 'secret' | 'list' | 'select';
  group: string;
  label: string;
  help: string;
  placeholder: string | null;
  options: string[] | null;
  min: number | null;
  max: number | null;
  helpUrl: string | null;
  onboarding: boolean;
  defaultValue: string;
  value: string | null;
  isSet: boolean;
}

export interface SettingsData {
  envFileExists: boolean;
  fields: SettingValue[];
}

export interface FormatBucket {
  key: string;
  n: number;
  /** Mean rank inside its own platform, 0..100. */
  percentile: number;
  /** Percentile points above or below the baseline. */
  lift: number;
  /** Half-width of the 95% interval, in the same points. */
  margin: number;
  /** The interval clears the baseline: a real difference, not noise. */
  significant: boolean;
  /** Below the minimum sample; shown, but never called a result. */
  thin: boolean;
  medianScore: number;
}

export interface FormatGroup {
  key: string;
  buckets: FormatBucket[];
}

export interface FormatAnalysis {
  windowHours: number;
  minConfidence: number;
  n: number;
  /** Mean percentile of the filtered set. Every lift is measured from here. */
  baseline: number;
  groups: FormatGroup[];
  findings: FormatBucket[];
  minSample: number;
}

export interface TimingGroup {
  key: string;
  buckets: FormatBucket[];
}

export interface TimingAnalysis {
  windowHours: number;
  minConfidence: number;
  settleHours: number;
  n: number;
  baseline: number;
  groups: TimingGroup[];
  findings: FormatBucket[];
  minSample: number;
  /** How many points of the raw spread were age rather than timing. */
  ageSpread: number;
  timezone: string;
}

export interface EmbeddingLanguage {
  lang: string;
  related: number;
  unrelated: number;
  /** related − unrelated. This is what decides whether the model is usable. */
  separation: number;
  usable: boolean;
}

export interface EmbeddingStatus {
  enabled: boolean;
  model: string;
  /** The model proved it can tell related text from unrelated, per language. */
  verified: boolean;
  dims: number;
  error?: string | null;
  minSeparation?: number;
  languages: EmbeddingLanguage[];
  untested?: string[];
  mergeThreshold?: number;
  coverage: { embedded: number; total: number } | null;
}

export interface MissedItem extends TrendItem {
  /** The highest score it reached, which is why it is worth looking back at. */
  peakScore: number | null;
  peakedAt: number | null;
}

export interface NotifyStatus {
  enabled: boolean;
  /** Channels that are switched on *and* have the credentials they need. */
  channels: string[];
  /** Switched on but still missing a token or a URL. */
  incomplete: string[];
  kinds: string[];
  minScore: number;
  minConfidence: number;
  quietHours: [number, number];
  intervalMin: number;
}

export interface Page<T> {
  items: T[];
  nextOffset: number | null;
}
