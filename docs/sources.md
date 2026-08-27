# Sources and the plugin contract

## The contract

```ts
interface SourcePlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: SourceCapabilities;

  /** Cheap, no network. Checked before every run. */
  validate(): ValidationResult;

  /** Find candidates. Never takes a topic — that is the whole point. */
  discover(ctx: PluginContext): Promise<readonly RawContent[]>;

  /** Re-read metrics for items already known. Optional. */
  refresh?(ctx: PluginContext, items: readonly RefreshRequest[]): Promise<readonly RefreshResult[]>;

  /** Optional live check that actually touches the network. */
  healthCheck?(ctx: PluginContext): Promise<ValidationResult>;
}
```

`discover` deliberately takes no query. A source that could only answer "give me
posts about X" would break the product promise, which is that the radar works
with everything set to *all*.

## Capabilities

The pipeline reads this instead of assuming every platform has views, likes and
shares — most do not.

```ts
interface SourceCapabilities {
  contentTypes: readonly ContentType[];
  metrics: readonly MetricName[];      // what it can EVER populate
  primaryMetric: MetricName;           // what "attention" means here
  engagementReference: number;         // what counts as excellent here
  hasAuthor: boolean;
  hasHashtags: boolean;
  hasCountry: boolean;
  supportsRefresh: boolean;
  supportsTrending: boolean;
  supportsSearch: boolean;
  supportsHistoricalMetrics: boolean;
  baseReliability: number;             // 0..1, feeds trend confidence
}
```

A test asserts that a plugin claiming `supportsRefresh` actually implements
`refresh`.

## The plugin sandbox

Plugins receive a `PluginContext` — a logger, a clock, the configured regions
and languages, a namespaced key-value store, and a way to raise a manual
intervention. They do not receive a database handle, the configuration object,
or any route to another plugin's state.

The store exists because some adapters must remember things between runs: a
rotation cursor, an API quota already spent today. Handing them a scoped store
keeps that possible without handing them the database, and one plugin cannot
read or clobber another's keys.

They also do not call `fetch`. All outbound traffic goes through
`net/fetcher.ts`, which is what makes per-host rate limiting, retry policy,
circuit breaking, timeouts and SSRF checks enforceable in one place instead of
hoping six adapters each remembered.

## What each adapter needs

### Google Trends — no configuration

The daily trending-searches RSS feed, per country from `REGIONS`. The one source
that answers *what people are searching for* rather than what they posted, and
the one that guarantees the dashboard is never empty.

Its traffic figure is an approximate band (`"20K+"`), not a counter, so it is
stored as `nativeScore` with reliability 0.75 rather than pretending to
precision it does not have.

### Hacker News — no configuration

The official Firebase API. Both `topstories` and `newstories` are watched: a
story that is not on the front page yet but climbing fast is exactly what
`EMERGING` exists for. Reliability 0.95.

### RSS / Atom — no configuration

Any feed URL in `RSS_FEEDS`, including YouTube channel feeds. Feeds expose **no
popularity metric at all**, so items from here rarely score highly on their own,
and they are not supposed to. Their job is corroboration: a story appearing on
Reddit, on YouTube and in three news feeds within the same hour is a real event
rather than one platform's algorithm having a moment.

Their metrics are stored as `NULL`, never `0`. Inventing a zero would be a lie
the scoring engine could not distinguish from a real zero.

### YouTube — free API key

The most valuable source, because it is the only one that hands over a real view
counter. Everything else measures reactions; this measures watching.

```
Google Cloud Console → new project
  → enable "YouTube Data API v3"
  → Credentials → Create API key
  → YOUTUBE_API_KEY=... in .env
```

Subscriber counts are fetched in batches of 50, which is what turns "800K views"
into "800K views from a 2K-subscriber channel" — the difference between a big
number and a story.

Without a key the source reports `CONFIGURATION_REQUIRED` and is skipped.

**Three discovery strategies, in order of value:**

1. **Open search** — the default, and the only one that needs nothing named in
   advance. Any channel can surface, including one nobody has heard of, which is
   the case the radar exists to catch. Seed words in `YOUTUBE_SEARCH_TERMS` are
   not topics to look for; they are the widest net the API allows, since
   `search` requires some query string. Each run rotates through them and
   alternates two orderings: `viewCount` over recent uploads (already pulling
   views) and `date` (caught before anything has happened yet).

2. **The trending chart** — one call per region, but only for regions YouTube
   actually publishes a chart for. There are 111 of them and **Iran is not among
   them**: `regionCode=IR` is a hard 400, not an empty result. The supported list
   is read once and unsupported regions are skipped with a single line rather
   than an error every cycle. `search` accepts those same region codes, which is
   why strategy 1 covers audiences the chart cannot reach.

3. **Watch channels** — optional. `YOUTUBE_WATCH_CHANNELS` follows named
   channels closely via their public RSS feed, then prices the ids through the
   API. Useful for competitors you care about; unnecessary for discovery.

**Quota.** `search` costs 100 units of the 10,000 free daily allowance;
everything else costs 1. That makes search the one call able to exhaust the day
on its own, so the adapter keeps a ledger in its own plugin state, resets it per
UTC date, and pauses open discovery at `YOUTUBE_QUOTA_BUDGET` rather than
running the account dry. One search per 20-minute run is about 7,200 units a
day, which leaves room for chart reads and metric refreshes.

### Reddit — free "script" app

Two strategies, tried in the order the platform prefers:

1. Official OAuth (application-only token from a free script app).
2. The public `.json` endpoints, anonymously.

Reddit now refuses anonymous JSON from many networks, so strategy 2 returns 403
more often than not. That is not something to work around — the adapter reports
`AUTH_REQUIRED` and raises a manual-intervention card pointing at the two-minute
fix, and the rest of the system carries on without it.

```
reddit.com/prefs/apps → create another app → type: script
  → REDDIT_CLIENT_ID   (the string under the app name)
  → REDDIT_CLIENT_SECRET
```

### Telegram — a channel list

Telegram publishes a plain HTML preview of every **public** channel at
`t.me/s/<name>` — the same page anyone gets by opening the link without an
account. It carries a per-post view counter, which makes it one of the few
sources besides YouTube with real reach attached to each item.

Scope, deliberately: public channels only, listed explicitly in
`TELEGRAM_CHANNELS`; no login, no session, no MTProto, no private content; one
request per channel per cycle, rate limited well below one per second.

If a channel is private or Telegram serves a challenge page, the adapter raises
a manual intervention rather than trying anything clever.

## Platforms that cannot run

TikTok, X and Instagram are **registered plugins**, not placeholders. They
appear in the dashboard with the exact reason and the exact next step, and they
return no data until that step is taken.

| Platform | Why | What would change it |
| --- | --- | --- |
| **TikTok** | no public trending endpoint; the Research API is gated behind an application, and scraping the site would breach its terms | approved Research API access → implement `discover` in `src/sources/tiktok.ts` |
| **X** | free read access removed; recent search now requires a paid tier and the site blocks unauthenticated reading | a paid API tier → implement `discover` with the bearer token |
| **Instagram** | no public discovery API; the Graph API only reads accounts you own, after a business review | a connected business account gives your own reach data; broad discovery is not available on any lawful path |

Each is also the seam where a working adapter drops in later. Implement
`discover` against whatever access is actually obtained and the rest of the
system — scoring, clustering, the API, the dashboard — needs no change.

## Adding a source

```ts
// src/sources/bluesky.ts
export function createBlueskySource(): SourcePlugin {
  return {
    id: 'bluesky',
    name: 'Bluesky',
    version: '1.0.0',
    capabilities: { /* what it can actually give */ },
    validate: () => VALID,
    async discover(ctx) {
      const data = await getJson<Feed>('https://…', { context: 'bluesky', rps: 1 });
      return data.posts.map(toRawContent);
    },
  };
}
```

Then one line in `createAll()` in [`registry.ts`](../src/sources/registry.ts).
That is the entire integration.
