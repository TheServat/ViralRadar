# Running it

## Install

```bash
node --version    # must be 24 or newer
npm install       # dev tooling only; the backend has zero runtime dependencies
cp .env.example .env
npm run build     # builds the dashboard once
npm start
```

Open <http://127.0.0.1:7788>.

To keep it running in the background on Windows, the simplest reliable option is
Task Scheduler with "run whether user is logged on or not", action
`node D:\me\viral-radar\apps\api\src\main.ts serve`. On macOS or Linux use a `launchd`
plist or a systemd user unit. Nothing about the program requires a supervisor
beyond restart-on-failure.

## The first hour

| When | What you should see |
| --- | --- |
| immediately | Google Trends, Hacker News and RSS items appear, all `NEW` |
| after ~20 min | second collection cycle; velocity appears, states become `RISING` |
| after ~40 min | acceleration becomes meaningful; `EMERGING` and `HOT` populate |
| after a few hours | per-source baselines have enough samples for percentile ranking |
| after a day | per-hour baselines start being used; creator baselines are real |
| after a week | chart sources have moved at least once; weekly music charts become readable |

**Growth cannot be measured from one observation.** The first pass is a
snapshot, not a trend. This is not a bug to fix by waiting less.

## Daily use

Start on **Today's brief**. It is the cross-platform view with filters for
language, country and platform threshold, and the count beside each threshold
tells you how many topics exist at that bar — so an empty result explains
itself instead of looking broken.

The three views that matter for making content:

1. **Cross-platform topics** — if the same story is climbing on several
   platforms at once, it is a real event and worth making something about today.
2. **Breaking out** — accounts performing far above their own normal. This is
   where formats worth copying show up, before they are everywhere.
3. **Emerging** — small and accelerating hard. Highest risk, earliest signal.

`🔍 Google Trends` items are search topics, not posts. They tell you what people
are *looking for* right now, which is often a better content brief than what
they are watching.

## Tuning

```bash
# Watch more places
REGIONS=US,GB,DE,IR
RSS_FEEDS=...,https://www.reddit.com/r/videos/.rss

# React faster (costs more requests)
DISCOVERY_INTERVAL_MIN=10
HOT_REFRESH_MIN=3
ANALYZE_INTERVAL_MIN=5

# Care more about early signals than about size
W_ACCELERATION=0.40
W_VELOCITY=0.25
W_FRESHNESS=0.10

# Only keep what is genuinely recent
MAX_AGE_HOURS=24
FRESHNESS_HALFLIFE_HOURS=4
```

After changing weights, bump `scoring.version` in `apps/api/src/config.ts` if you want
old scores to remain distinguishable from new ones.

## Diagnostics

```bash
node apps/api/src/main.ts doctor
```

```
  node            v24.19.0
  database        D:\me\viral-radar\data\radar.db
  schema          ok (content=220, metrics=389, clusters=24)
  regions         US
  network         DIRECT
  ai              AI_DISABLED (core detection does not need it)

  sources
    googletrends   ready
    hackernews     ready
    youtube        CONFIGURATION_REQUIRED
        Set YOUTUBE_API_KEY in .env. …

  connectivity
    google trends  200 in 412ms
    hacker news    200 in 233ms
```

## Troubleshooting

**I changed the dashboard and nothing looks different.**
The interface is built, not served from source. Run `npm run build`.

**Everything is `NEW` and scores hover around 40.**
Only one observation exists per item. Wait for a second cycle, or force it:
`node apps/api/src/main.ts collect && node apps/api/src/main.ts refresh HOT && node apps/api/src/main.ts analyze`.

**`reddit FAILED — www.reddit.com returned 403`.**
Reddit blocks anonymous JSON from most networks. Create a free script app at
<https://www.reddit.com/prefs/apps> and set `REDDIT_CLIENT_ID` and
`REDDIT_CLIENT_SECRET`. The dashboard shows this as a manual-intervention card
with the same instruction.

**A source says `CONFIGURATION_REQUIRED`.**
It needs a free key. Open Settings in the dashboard: each one is listed with a
link to the page that issues it, and none require payment details. Nothing
breaks while a key is missing — that source simply returns nothing.

**`YouTube daily API quota exhausted`.**
10,000 units per day, resetting at midnight Pacific. Raise
`DISCOVERY_INTERVAL_MIN` or reduce `REGIONS`. Each region costs 1 unit per
discovery plus 1 per 50 channels looked up.

**No cross-platform clusters.**
Clustering needs volume — a few dozen items per source at least. It also needs
more than one source actually working; check `node apps/api/src/main.ts sources`.

**A source shows `DEGRADED` and then stops trying.**
Five consecutive failures open a per-host circuit breaker with exponential
backoff up to 30 minutes. `/api/v1/system/health` shows the remaining time under
`network`. This is deliberate: repeatedly knocking on a door that is not opening
is both useless and rude.

**The dashboard is empty but collection succeeded.**
Run `node apps/api/src/main.ts analyze`. Collection stores; analysis scores. In `serve`
mode both run on their own schedules.

**Timestamps look wrong.**
Everything is stored in UTC epoch seconds and rendered in the browser's locale.
Per-hour baselines bucket by UTC hour, which is correct for a global platform
even when it does not match your local evening.

## API

```
GET  /api/v1/dashboard                      everything the home page needs
GET  /api/v1/trends?…                       ranked, filtered, paginated
GET  /api/v1/trends/viral | emerging | rising | cross-platform
GET  /api/v1/clusters             /api/v1/clusters/:id
GET  /api/v1/content/:id                    detail + the full metric series
GET  /api/v1/creators/breakouts?hours=48
GET  /api/v1/hashtags
GET  /api/v1/creators?sort=best|breakouts|items
GET  /api/v1/reports?hours=72               everything the reports page charts
GET  /api/v1/facets                         languages, countries and sources present
GET  /api/v1/sources                        capabilities + health
POST /api/v1/sources/:id/run
GET  /api/v1/system/health | interventions | events
GET  /api/v1/system/settings                editable keys; secrets never returned
POST /api/v1/system/settings                writes .env, whitelisted keys only
POST /api/v1/system/collect | analyze
POST /api/v1/system/interventions/:id/resolve
GET  /api/v1/stream                         SSE
```

`/clusters` accepts the same `lang`, `country` and `source` filters as
`/trends`, plus `minSources` — a topic matches when a post *inside it* matches,
so "Persian topics" means topics containing Persian posts.

Filter parameters, all optional: `source`, `lang`, `country`, `type`, `state`,
`minScore`, `maxAgeHours`, `creator`, `hashtag`, `q`, `limit`, `offset`, `sort`
(`score` | `acceleration` | `velocity` | `recent` | `creator_anomaly`).

Set `API_TOKEN` to require `X-Radar-Token`, `Authorization: Bearer`, or `?token=`.

## Backup

```bash
sqlite3 data/radar.db ".backup data/backup.db"   # or just copy the file when stopped
```

One file. Copy it, and you have everything.
