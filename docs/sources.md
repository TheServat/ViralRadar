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

### Google News — no configuration

An RSS feed per section — world, nation, business, technology, entertainment,
sport, science, health — in whatever language and country you ask for. The
widest topical coverage available without a key, and the only source here that
reaches every subject at once *and* speaks Persian.

Each item is an aggregated story rather than a single article, so the
description already lists the other outlets carrying it. No popularity figures,
so like RSS these score low alone; their value is corroboration.

### Wikipedia — no configuration

The Wikimedia REST API publishes the most-read articles per language per day,
with real view counts. It answers a question no other source does: what people
are *reading*, as opposed to posting or searching for. Follows `LANGUAGES`, so
a Persian audience is measured on fa.wikipedia rather than en.

Two things it needs care with, both handled: namespace pages (`Special:`,
`رده:`, `Category:`) are not articles and are dropped, and the figures are daily
totals published in arrears, so yesterday is the most recent complete day.

The permanent top ten that never changes on any Wikipedia is exactly what the
velocity signal is for — those articles score nothing, because nothing about
them is moving.

### Mastodon — no configuration

Three public trending endpoints, each answering a different question: which
posts are spreading, which subjects are being talked about, and which articles
the network is sharing. Real favourite, boost and reply counts.

Because the network federates, the same post appears on every server that has
seen it, each with a different local id. Identity is therefore the origin
server's own URI, not `host:id` — otherwise one post would be stored once per
server read.

### Bluesky — no configuration

Public AT Protocol feeds, with likes, reposts, replies and quotes. Any public
feed generator's AT-URI can be listed; the defaults are Bluesky's own discovery
feeds.

### GitHub — no configuration

There is no official trending endpoint, so this asks the question trending
actually answers: which repositories created recently have gathered the most
stars. Stars are a real counter that moves, which makes velocity meaningful
here in a way a scraped trending page would not be. A token is optional and
only raises the rate limit.

### Charts: Steam, Apple, Spotify — no configuration

Grouped because they share a shape no other source has. A chart gives a
*position*, not a count — nobody publishes how many people played a game or
streamed a song — so rank is inverted into a score where first place is worth
the most. Movement up the chart then reads as growth, which is the signal that
matters: entering the top ten this week is news, sitting at number four for a
year is not.

Steam is the exception and gives a real number: concurrent players. Its ranks
carry only app ids, so names are resolved once and remembered in plugin state.

Apple has no storefront for every country — Iran among them — so an unsupported
region is skipped with one line rather than retried every cycle.

### Imgur — free Client ID

The closest thing to a pure virality source here. Imgur's gallery is where an
image either takes off within hours or disappears, and unlike most platforms it
publishes a real view counter per post alongside votes and comments — so
velocity measures actual watching, not reactions.

```
api.imgur.com/oauth2/addclient
  → "anonymous usage without user authorisation"
  → IMGUR_CLIENT_ID
```

Two sections are read: `viral` is what the gallery promotes, `rising` is what is
climbing but has not arrived yet — the second is where a post can still be
caught early.

### Twitch — free application

The only source that measures attention *as it happens*. `viewer_count` is
people watching right now, not a total accumulated since publication, which
makes velocity mean something different and useful: a stream going from two
hundred to nine thousand viewers in an hour is a live event, and nothing else
in this system can see that.

```
dev.twitch.tv/console/apps/create
  → category "Application Integration", redirect http://localhost
  → TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET
```

The token is the app-only client-credentials kind; no user ever logs in.

Items are keyed on the **channel**, not the stream: one channel's audience over
time is the series worth watching, and a new stream id every session would reset
it to nothing each time they go live. A channel that has gone offline reports
zero watching, which is a real measurement — it is what makes the decline
visible.

### TMDB — free API key

Film and television. TMDB publishes a `popularity` figure recomputed daily from
views, votes and watchlist activity. It is a relative number rather than a count
of anything, but it *moves*, which is what this system needs — a title climbing
from 40 to 300 in three days is the signal, not the absolute value.

### Product Hunt — developer token

A launch either gathers votes in its first day or it does not, and the count is
public and moves by the hour. Useful if you cover tools, products or startups.
The API is GraphQL and answers 200 with an errors array, so failures are read
out of the body rather than the status code.

### Giphy — free API key

Trending GIFs and stickers: where a reaction format often spreads before it
reaches the platforms that count views. One honest limitation — the trending
endpoint publishes an ordering and no numbers at all, so rank becomes the score
the way it does for the music and game charts. Its reliability is set to 0.6 to
say so.

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

## Credentials, and what each one buys

None of these require payment details, and none take more than a few minutes.
The Settings page lists them with a link to the right page.

| Key | Unlocks | Why it is worth the two minutes |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | YouTube | real view counts — the single most valuable number in the system |
| `IMGUR_CLIENT_ID` | Imgur | per-post views on the fastest-moving gallery on the web |
| `TWITCH_CLIENT_ID` + secret | Twitch | live concurrent viewers, which no other source measures |
| `REDDIT_CLIENT_ID` + secret | Reddit | reliable access; anonymous JSON is refused on most networks |
| `TMDB_API_KEY` | TMDB | film and television, with a figure that moves daily |
| `PRODUCTHUNT_TOKEN` | Product Hunt | launches and their vote counts |
| `GIPHY_API_KEY` | Giphy | trending reaction formats, by rank |

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
