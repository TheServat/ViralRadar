# Architecture

## Shape

One process serving both the API and the dashboard. One SQLite file. No message
broker, no cache server, no container runtime, no second web server.

The dashboard is built once into `apps/web/dist` and served by the same Node
process, so there is one port and no CORS to arrange.

```
                    ┌──────────────────────────────────────────┐
                    │         apps/api/src/main.ts             │
                    │        CLI · serve · collect · …         │
                    └───────────────┬──────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
┌───────▼────────┐        ┌─────────▼─────────┐       ┌─────────▼────────┐
│  api/          │        │  pipeline/        │       │  sources/        │
│  http + routes │        │  scheduler        │       │  plugin registry │
│  SSE stream    │        │  collect          │       │  13 adapters     │
│  built web     │        │  analyze          │       │  3 honest stubs  │
└───────┬────────┘        └─────────┬─────────┘       └─────────┬────────┘
        │                           │                           │
        └───────────┬───────────────┴───────────┬───────────────┘
                    │                           │
            ┌───────▼────────┐        ┌─────────▼─────────┐
            │  core/         │        │  db/ + net/       │
            │  types  stats  │        │  repo (all SQL)   │
            │  text   score  │        │  migrations       │
            │  cluster  xml  │        │  fetcher  ssrf    │
            └────────────────┘        └───────────────────┘
```

## The dependency rule

`apps/api/src/core/` is the domain. It is pure TypeScript: no framework, no SQL, no
HTTP, no clock of its own — `now` is always passed in. Everything else may
import it; it imports nothing but itself.

That constraint is what makes the trend engine testable at all. `scoreContent`
takes a metric series and returns a score; it cannot know or care whether the
series came from YouTube, from a fixture, or from a test that describes four
hours of growth in four lines.

The direction of dependencies, strictly:

```text
main → api → pipeline → sources → net
                ↓          ↓        ↓
                └───────► core ◄────┘
                     ↑
                    db
```

`apps/web` depends on nothing in `apps/api` at build time: it talks to the API
over HTTP like any other client, which is why it can be developed against a
running instance with `npm run web:dev`.

`core` never points outward. `sources` never touches `db`. `db` never touches
`sources`. The one place they meet is `pipeline`, which is where orchestration
belongs.

## Modules

| Module | Responsibility | Must not |
| --- | --- | --- |
| `apps/web/` | the Vue dashboard, built into `apps/web/dist` | reach the database directly |
| `core/types.ts` | the domain vocabulary | import anything |
| `core/stats.ts` | robust statistics | know about content |
| `core/text.ts` | tokens, stemming, SimHash, language ID | make network calls |
| `core/score.ts` | the trend engine | read a clock or a database |
| `core/cluster.ts` | topic grouping | require embeddings |
| `core/xml.ts` | RSS/Atom reading | know about any specific feed |
| `db/repo.ts` | every SQL statement in the project | contain business rules |
| `net/fetcher.ts` | the only outbound path | be bypassed by a plugin |
| `net/ssrf.ts` | URL and address validation | be optional |
| `sources/*` | one adapter per platform | import `db` or another adapter |
| `pipeline/collect.ts` | discover → normalise → store | compute scores |
| `pipeline/analyze.ts` | baselines → score → cluster | make network calls |
| `pipeline/scheduler.ts` | when things run | know how they work |
| `api/*` | HTTP, filters, DTOs | contain detection logic |
| `ai/*` | optional cluster naming | be imported by detection |
| `settings.ts` | the whitelist of what a browser may write to `.env` | grow a key without a type and a range |

## Data flow

```
     ┌── discovery (every 20 min) ────────────────────────────┐
     │  plugin.discover() → RawContent[]                      │
     │       ↓ enrich: language, keywords, hashtags, SimHash   │
     │       ↓ upsert content (dedup on source + external_id)  │
     │       ↓ append one row to content_metrics               │
     └────────────────────────────────────────────────────────┘
                              │
     ┌── refresh (HOT: 5 min · NORMAL: 60 min) ───────────────┐
     │  plugin.refresh(known ids) → another content_metrics row│
     │  ...which is what makes velocity possible at all        │
     └────────────────────────────────────────────────────────┘
                              │
     ┌── analysis (every 10 min, no network) ─────────────────┐
     │  1. rebuild per-source baselines (pooled + per hour)    │
     │  2. score every item in the window                      │
     │  3. detect creator breakouts against each own history   │
     │  4. cluster by tf-idf cosine + SimHash (recent 4,000)   │
     │  5. re-score items that just gained corroboration       │
     │  6. roll up hashtag counts per hour                     │
     │  7. rebuild baselines again, for the next pass          │
     └────────────────────────────────────────────────────────┘
```

Steps 2–6 run inside one transaction. The whole pass takes tens of milliseconds
on a few hundred items and a couple of seconds on tens of thousands.

## Why a scheduler and not a queue

Collection is almost entirely waiting on the network. Jobs are queued by timers
and executed one at a time, which removes concurrent-write contention entirely
and costs nothing at this scale. A failing job is logged and the scheduler
continues; it cannot take the process down.

Events still exist and are still durable — they are rows in `sys_events`. The
SSE stream is a tail of that table rather than a second delivery mechanism that
could disagree with it.

## Error handling

Every failure is a `RadarError` with a `kind`. The kind decides the response:

| Kind | Retried | Becomes |
| --- | --- | --- |
| `NETWORK`, `SOURCE_UNAVAILABLE` | yes, with backoff and jitter | source `DEGRADED` |
| `RATE_LIMIT` | never | cooldown honouring `Retry-After` |
| `AUTH_REQUIRED`, `CAPTCHA_REQUIRED` | never | a **manual intervention** card |
| `CONFIGURATION_REQUIRED` | never | a setup instruction in the UI |
| `PARSING`, `VALIDATION` | never | logged, item skipped |

Retrying a CAPTCHA is both useless and abusive, so the type system makes it
impossible rather than leaving it to a reviewer to notice.

## Adding a source

1. Write `apps/api/src/sources/<name>.ts` exporting a `SourcePlugin`.
2. Add one line to `createAll()` in `apps/api/src/sources/registry.ts`.
3. If it needs a credential, add one entry to `apps/api/src/settings.ts` so it
   appears on the Settings page with a link to obtain it.

Nothing else changes. The scheduler, scoring, clustering, filters, API and
dashboard all read the plugin's declared `capabilities` — including which metric
it leads with and what counts as a good engagement rate there.
