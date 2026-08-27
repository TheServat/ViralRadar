# Architecture decision records

The original brief specified a particular stack. Several of those choices are
right for a distributed production service and wrong for a program that runs on
one person's laptop. Each substitution is recorded here with what was asked, what
was built, and why.

---

## ADR-001 — Modular monolith, single process

**Status:** accepted

One process containing the API, the scheduler, the plugin runtime and the trend
engine. Module boundaries are enforced by the dependency rule, not by network
hops.

Microservices would add serialisation, deployment and debugging cost to solve
coordination problems that do not exist here. The boundaries that matter — the
domain not knowing about SQL, the core not knowing about YouTube — are enforced
by imports and are checked by the compiler.

---

## ADR-002 — Domain-driven boundaries, without ceremony

**Status:** accepted

`src/core/` is the domain: pure functions and types, no framework, no I/O, no
clock. `src/db/repo.ts` is the persistence layer. `src/pipeline/` orchestrates.

Rejected: a separate repository interface in the domain implemented in
infrastructure. For a single-datastore application with one implementation, that
indirection buys a swap that will not happen and costs a layer every reader must
walk through. The boundary that carries the value — the domain not importing SQL
— is kept.

---

## ADR-003 — SQLite instead of PostgreSQL

**Status:** accepted · **supersedes the brief's "PostgreSQL"**

Node 24 ships `node:sqlite`. That means: no database server to install, no
container to run, no connection string to configure, no native module to
compile, and a backup that is one file copy.

Postgres would add an install, a service, and a daily "is it running" question,
in exchange for concurrency and scale this workload does not have. A single-user
radar collecting a few thousand items an hour is not close to SQLite's limits.

WAL mode keeps the API's reads from ever blocking the collector's writes. Window
functions, CTEs, partial indexes, `WITHOUT ROWID` tables and upserts are all
available and used.

**What is kept from the brief:** no ORM. Every statement is hand-written SQL in
one file, and schema changes are numbered SQL migrations.

---

## ADR-004 — Hand-written SQL instead of sqlc and Goose

**Status:** accepted · **supersedes the brief's "sqlc" and "Goose"**

sqlc and Goose are Go tools. sqlc generates Go, not TypeScript, and cannot be
used from a Node application at all; the brief asked for two things that do not
compose.

The *intent* — type-safe access without an ORM, and schema changes as SQL
migrations — is fully honoured:

- All SQL lives in `src/db/repo.ts` and `src/db/migrations/`.
- Every query has an explicit TypeScript row interface at its call site.
- Migrations are numbered `.sql` files applied in order and tracked by
  `PRAGMA user_version`, in a transaction.

The difference from sqlc is that row types are written rather than generated.
For a schema this size that is a smaller cost than a second toolchain.

---

## ADR-005 — In-process scheduler instead of NATS JetStream

**Status:** accepted · **supersedes the brief's "NATS JetStream"**

A message broker solves fan-out between independently deployed consumers.
There is one consumer, in the same process.

What NATS was wanted for is still provided:

| Wanted | Provided by |
| --- | --- |
| async jobs | timer-driven queue, one job at a time |
| durable events | `sys_events` table |
| realtime delivery | SSE endpoint tailing that table |
| idempotent consumers | every write is an upsert |
| failure isolation | a throwing job is logged; the scheduler continues |

Because the event log is the database, the stream can never disagree with stored
state — a class of bug a separate broker actively invites.

---

## ADR-006 — No Redis

**Status:** accepted · **supersedes the brief's "Redis"**

Redis was wanted for caching, distributed locks, rate limiting and hot state.
In one process: caching is a `Map`, locks are unnecessary because there is one
writer, rate limiting is a per-host token bucket in memory, and hot state is a
SQLite table.

Adding Redis would mean another service to run and another failure mode, to
replace three data structures.

---

## ADR-007 — No Playwright, no browser automation

**Status:** accepted · **supersedes the brief's "Playwright infrastructure"**

Every source that is lawfully and freely available is reachable over plain
HTTP: official APIs (YouTube, Reddit, Hacker News), public RSS (Google Trends,
news), and public preview pages (Telegram). None of them need a browser.

The platforms that *would* need one — TikTok, X, Instagram — need it precisely
because they do not want unattended reading. Driving a headless browser at them
would be working around an access decision, which this system does not do.

Playwright would add roughly 400 MB of browsers, a container runtime concern,
and a large attack surface, to enable exactly the scraping that is out of scope.

If a future source genuinely needs rendering, `net/fetcher.ts` is the seam: a
`BrowserFetcher` implementing the same interface slots in without any plugin
changing.

---

## ADR-008 — Real plugin architecture, kept

**Status:** accepted · **as specified**

`SourcePlugin` with declared capabilities, validation, lifecycle and a
constrained context. The core resolves sources only through the registry, and no
detection code imports a concrete adapter. Adding a source is one file plus one
line.

Capabilities are load-bearing, not documentation: the scoring engine reads
`primaryMetric` and `engagementReference` from them, which is what lets one
formula serve platforms that count views, upvotes and search traffic.

---

## ADR-009 — Statistical detection, kept

**Status:** accepted · **as specified**

Velocity, acceleration, robust anomaly detection against per-creator and
per-platform baselines, percentile normalisation, time-of-day buckets, tf-idf
clustering, SimHash near-duplicate detection. No model anywhere in the detection
path.

This is not only about avoiding dependencies. A statistical score is
explainable, reproducible and testable: `tests/score.test.ts` asserts exact
behaviour on fixtures, which is not possible with a model in the loop.

---

## ADR-010 — AI strictly optional, kept

**Status:** accepted · **as specified**

With `AI_PROVIDER` empty — the default — the system reports `AI_DISABLED` and
every feature works. When configured, AI does two cosmetic jobs: naming a
cluster and writing one sentence about why it may be spreading. Both run in a
separate scheduled job, never inside the analysis pass, which stays synchronous
and free of network calls.

The core depends on the `NarrativePlugin` interface, never on a vendor. Adapters
exist for OpenAI-compatible APIs, Anthropic and Ollama.

---

## ADR-011 — Proxy routing without SOCKS

**Status:** accepted · **narrows the brief's "Proxy/Tor"**

`NETWORK_MODE=HTTP_PROXY` with `PROXY_URL` routes all outbound traffic through
Node's built-in proxy support, re-executing once at startup to enable it.

SOCKS5 would require an extra dependency for a case every relevant client
already covers: Xray and V2Ray expose an HTTP inbound alongside SOCKS, and Tor
offers `HTTPTunnelPort`. The CLI says exactly this instead of failing obscurely.

Routing is infrastructure. It is not used to bypass bans, rate limits or
authentication, and address rotation to defeat a rate limit is not implemented.

---

## ADR-012 — Vue 3, TypeScript and Vuetify, served by the API

**Status:** accepted · **supersedes an earlier decision to avoid a build step**

The dashboard was first written as one HTML file, one stylesheet and one ES
module, on the reasoning that a handful of read-only views did not justify a
toolchain. That reasoning stopped holding once the interface had to carry two
languages with opposite text direction, a settings screen that writes
configuration, a reports page, and sortable tables — all of which a framework
does properly and hand-written DOM code does badly.

So: Vue 3 with `<script setup>`, TypeScript throughout, Vuetify for the
component layer, `vue-i18n` for Persian and English, and `vue-router`.

Two constraints kept from the original decision:

- **One process, one port.** The build output in `web/dist` is served by the
  Node API itself, with a fallback to `index.html` so a reload on `/settings`
  does not 404. There is no second server and no CORS to arrange. `npm run
  web:dev` exists for development and proxies to the API.
- **No CDN.** Everything is bundled and served from this origin, so the CSP can
  keep `script-src 'self'` and `connect-src 'self'`.

The cost is a build step: after changing anything under `web/`, run
`npm run build`. That is the price of the interface being worth using, and it is
paid once per change rather than continuously.

**Icons.** Vuetify's default is the Material Design icon *font*: about 4 MB of
font files plus a 670 kB stylesheet defining seven thousand glyphs, of which
this interface uses seventy-one. Those seventy-one are imported from `@mdi/js`
as SVG paths through a custom icon set, which keeps every `icon="mdi-..."`
working and takes the built dashboard from 4.8 MB to 1.1 MB.

---

## ADR-013 — Zero runtime dependencies

**Status:** accepted

The application imports nothing from npm. `node:sqlite`, global `fetch`,
`node:http` and Node's native TypeScript execution cover everything, including
the RSS reader and the language detector.

This is the difference between a program that still starts in a year and one
that needs an afternoon of dependency archaeology first. `npm install` fetches
only TypeScript and `@types/node`, and only for `npm run typecheck`.

---

## ADR-014 — Docker optional, not required

**Status:** accepted · **narrows the brief's "complete Docker setup"**

With no database server, no cache, no broker and no browser, there is nothing
left for compose to orchestrate. `npm start` is the deployment.

A Dockerfile is still provided for anyone who prefers a container, but it is a
convenience rather than the supported path, and it is not how the program is
meant to be run on a personal machine.

---

## ADR-015 — Settings editable from the dashboard

**Status:** accepted

`.env` can be written from the Settings page, and a first-run wizard walks
through the two credentials worth having. Editing a text file by hand is a poor
first five minutes for a tool meant to be installed and used.

Four constraints make that safe rather than reckless:

- **A whitelist, not a file editor.** `src/settings.ts` declares every editable
  key with its type and range. An unknown key is refused outright, so a browser
  cannot reach `DB_PATH`, `HOST`, `PORT` or `API_TOKEN`.
- **Secrets travel one way.** A stored secret is never sent to the browser; the
  field reports whether one is set, and an empty box means "leave it alone".
- **Values cannot escape their line.** A newline in a value would let one
  setting write another, so it is rejected.
- **Saving is honest about restarts.** Configuration is read once at startup and
  frozen. The response says a restart is required rather than pretending the
  change is already live.

The file keeps its comments and ordering, because it is still a document the
user edits by hand.

---

## ADR-016 — Installed by script, not packaged as a binary

**Status:** accepted

`scripts/install.ps1` and `scripts/install.sh` install dependencies, build the
dashboard, create `.env` from the template if absent, and add a desktop
shortcut. Autostart is a flag, not a default: a program that collects data in
the background should be an explicit choice.

**Why not a single executable.** Node 24 does ship Single Executable
Applications, and it was considered. It does not fit here: SEA bundles one
CommonJS file, while this project is ESM TypeScript executed natively; the
built dashboard, the SQL migrations and the icon assets would all have to be
embedded and unpacked at runtime; and `node:sqlite` is a native binding that
complicates the bundle further. The result would be a fragile 100 MB binary
that is harder to inspect and update than a folder with a shortcut.

The honest requirement is Node.js 24, which the installer checks for and names
explicitly if it is missing.
