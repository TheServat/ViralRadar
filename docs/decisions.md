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

---

## ADR-017 — Sixteen sources, chosen by what they can measure

**Status:** accepted

A source earns its place by answering a question the others cannot, not by
adding to a count. Grouped by what they actually measure:

| What it measures | Sources |
| --- | --- |
| **watching** | YouTube, Telegram, Imgur, Wikipedia |
| **watching, live** | Twitch |
| **reacting** | Mastodon, Bluesky, Reddit, Hacker News, Product Hunt, GitHub |
| **searching** | Google Trends |
| **ranking** | Steam, Apple, Spotify, Giphy, TMDB |
| **reporting** | Google News, RSS |

Two consequences worth stating.

**Rank is not a count, and is not treated as one.** Charts publish a position
because nobody publishes how many people streamed a song. Rank is inverted into
a score so that *movement* produces the usual velocity and acceleration, and
the reliability of those sources is set lower to say that the number underneath
is coarser than a real counter.

**Sources with no metrics still earn their place.** Google News and RSS expose
nothing at all, and the evidence gate in the scoring engine deliberately holds
them down. They are there for corroboration: a story appearing on Reddit, on
YouTube and in three news feeds within the same hour is a real event rather
than one platform's algorithm having a moment. For a language whose sources
rarely share vocabulary, they are also what makes a cross-platform topic
possible at all — adding them took Persian cross-platform topics from five to
thirty-five.

**Credentials are never a hard requirement.** Ten sources need nothing. The
seven that need a key each report `CONFIGURATION_REQUIRED`, appear on the
Settings page with a link to the exact page that issues it, and return no data
until they have one. None of them are faked to make a demo look complete.

---

## ADR-018 — Federated identity is the origin, not the server read

**Status:** accepted

Mastodon posts arrive from several servers at once, each with its own local id
for the same post. Keying on `host:id` stored the same post once per server, and
the duplicates were visible in the ranked list before this was caught.

Identity is now the origin server's own URI, which is identical everywhere. The
local id is kept in `raw` so a refresh knows where to ask.

The general rule this encodes: **an item's identity belongs to whoever published
it, not to whoever handed it to us.** Any future federated source has the same
problem and the same answer.

---

## ADR-019 — Notifications are a digest, and quiet hours hold rather than drop

**Status:** accepted

The radar's whole value is noticing something early, which is worth nothing if
it only happens while someone has the dashboard open. So the event log, which
already exists and is durable, gets a push on top of it.

Three decisions inside that:

**Batched, not one message per item.** When twenty things move at once, twenty
separate pings are noise, and noise gets muted. Muted is the same as not having
the feature. One digest per check, strongest first, capped by
`NOTIFY_MAX_PER_RUN`.

**Quiet hours hold, they do not drop.** Waking up to what happened overnight is
useful; being woken by it is not. During a quiet window the cursor deliberately
does not advance, so everything arrives when the window ends.

**The cursor only advances when a channel succeeded.** A high-water mark in
`sys_kv` is what makes a restart safe, but advancing it after a failed send
would silently swallow the very events the user asked to be told about.

Four filters stand between an event and a push — kind, quality (score *and*
confidence), language, and the once-only cursor. Confidence is the one that
matters most: without it the first measurement of anything looks like infinite
growth, and the feature would spend its first week crying wolf.

---

## ADR-020 — A lock on the Settings page, and honesty about what it is worth

**Status:** accepted

`API_TOKEN` already protects the whole API, but it is all-or-nothing and turns
the dashboard into something you have to authenticate to read. The actual worry
is narrower: the dashboard is open on a machine other people can reach, and
Settings is the one page that lists which credentials exist.

`SETTINGS_PASSWORD` gates that page alone, and only that page. It is empty by
default, so nothing changes for the single-user case it was built for.

The interesting part is what it is *not*. It does not protect `.env` — that file
is plain text next to the program, and anyone who can read the disk has every
key in it. This is written into the source, the docs, and the help text on the
field itself, because a security feature that people misjudge the scope of is
worse than one they do not have: it earns trust it cannot honour.

Two consequences follow from taking it seriously rather than decoratively:
attempt limiting, because a short password on a local service is still worth
guessing at machine speed; and the password living in memory in the browser
rather than in `localStorage`, since storing it would hand it straight to the
person the gate exists to stop.

---

## ADR-021 — The format analysis reports its own uncertainty, or it is worthless

**Status:** accepted

"What shape of content wins" is the most directly actionable thing this system
can compute, and for the same reason the easiest to get quietly wrong. A page
of confident bars built on eleven items would be worse than no page: it would
be acted on.

So the uncertainty is part of the output rather than a caveat under it. Every
bucket carries a 95% interval, drawn as a whisker on the same axis as the bar,
and nothing is called a finding unless its interval clears the baseline and it
has at least twenty-five items. Thin buckets are greyed rather than hidden,
because "not enough data yet" is a real answer and hiding it looks like
"nothing there".

Two supporting decisions:

**The baseline is computed, never assumed.** Persian items average the 32nd
percentile of their own sources. A hardcoded 50 would have reported every
Persian format as below average — a bug that produces plausible output and so
might never have been caught.

**Feature detection is not SQL.** SQLite cannot match an emoji: surrogate pairs
defeat `LIKE` and miscount in `LENGTH`. The SQL draft found one emoji title in
939 Persian items where there are 487, and "emoji do not help" is exactly the
kind of confident wrong answer this ADR exists to prevent. Extraction moved to
`core/format.ts`, where it is also testable against Persian and Arabic input.

The page says "these did better", never "this will make yours do better". The
analysis cannot separate title length from content type from platform, and the
wording is the only honest place to carry that.

---

## ADR-022 — Timing is adjusted for age, and the adjustment is shown

**Status:** accepted

"Best time to post" is the most requested feature of this kind and the easiest
to compute wrongly in a way nobody catches.

Rank in this system decays with age — 32 points between the newest and oldest
bands on the database this was built against. Publish hours are not spread
evenly across those bands, because collection started at a particular moment
and has been running ever since. Aggregating raw rank by publish hour therefore
produces a clean, confident chart that is substantially a picture of the
collection schedule.

Every item is now centred within its own age band before anything is aggregated
by hour. An hour cannot win by holding newer items, because being newer is
subtracted first.

The decision that follows from taking that seriously: **the size of the removed
effect is part of the output.** `ageSpread` is returned and printed above the
chart. On real data the correction (32 points) is larger than the largest
finding (11 points), and a reader who does not know that is reading a number
they would interpret differently if they did.

Two exclusions rather than adjustments, because neither can be corrected for:
publish times the system estimated are dropped entirely — using a guess to
study timing is circular — and so is anything published less than a day ago,
which has not had an equal chance to prove itself.

A consequence accepted deliberately: an age-adjusted value can fall outside
0-100, since it is a difference rather than a true percentile. Rather than
clamp it — which would make the displayed rank disagree with the displayed
lift — the timing view drops the rank line and shows lift alone.

---

## ADR-023 — An embedding model must prove itself before it is trusted

**Status:** accepted

Semantic clustering closes a real gap: the same story in Persian and in English
shares no vocabulary, so the lexical pass cannot see it however well tuned.

The interesting decision is not to add embeddings. It is what happens when the
model is bad.

While building this, three models advertised as multilingual were measured on
the same probe — two sentences that mean the same thing, and one that does not.
`paraphrase-multilingual` separated them by 0.99 in Persian. But the first
measurement of all three appeared to show Persian failing completely, and that
turned out to be the test harness mangling UTF-8 on the way to the model rather
than the models themselves.

Both halves of that are the lesson. A bad model *and* a bad pipe produce the
same symptom, the symptom is invisible from outside, and the consequence is not
degraded output — it is every Persian topic merged into a single cluster by a
component reporting itself healthy.

So the model is not trusted because of its name, its size, or its
documentation. It is asked to demonstrate, in each language the user actually
publishes in, that related sentences land closer than unrelated ones, with a
minimum gap of 0.15. Failing that it is refused and the reason is logged and
shown on the System page.

Three further constraints, each chosen so the worst case stays small:

**Never required.** Empty `EMBED_MODEL` and the pass does not exist.

**Only merges.** It runs after the lexical pass and can only join clusters,
never split them, so a bad threshold is visible and reversible rather than
silently lossy.

**Never in the analysis path.** Embedding is its own job writing to its own
table. Analysis reads cached vectors synchronously, so a stopped model costs
merges, never a failed run.

The threshold was tuned on a real corpus, not chosen for roundness: 0.86
doubled cross-language topics with no over-merging; 0.78 produced a 264-item
cluster; 0.70 an 839-item one. The number and the measurements behind it are
recorded in `.env.example` next to the setting, because a threshold nobody can
re-derive is a threshold nobody can safely change.

---

## ADR-024 — Creator history is fetched, and kept out of the content table

**Status:** accepted

Breakout detection was effectively dead: 2,189 of 2,770 creators had exactly
one measured item, and a breakout verdict needs five to have a median worth
dividing by. The signal that most justifies the whole system — a small account
mid-explosion — was unavailable for 90% of accounts.

The tempting fix is to lower the threshold. It is also wrong: the median of two
observations is not a baseline, and "10× normal" computed from it would be
noise wearing the clothes of evidence. The threshold is not the problem; the
missing history is.

So the history is fetched. For YouTube through the public channel feed, which
costs no API quota, with the returned ids priced in one batched call — roughly
one unit per fifty videos, which makes backfilling thousands of channels
affordable rather than theoretical.

The decision worth recording is where the results are stored. They go in
`creator_history`, not `content`, and are never scored, refreshed, clustered or
shown. A backfill reaches back through a channel's older uploads; those are by
definition not trending, and putting them in `content` would fill the feed with
old videos as a side effect of improving a baseline. A separate table makes
that impossible rather than merely discouraged.

Two smaller choices follow the same instinct. Creators are selected by the best
score their work reached, so a bounded budget is spent where a breakout would
matter. And they are rested for a week after being looked at *whether or not
anything came back*, so a deleted or silent channel cannot absorb the budget
every run for ever.

---

## ADR-025 — Hiding is a mark, and an export has to survive Excel

**Status:** accepted

Two small features, each with one decision inside it worth writing down.

**Hiding an item does not delete it.** Once you have made a video about
something it should stop competing for your attention, but deleting the row
would cost the metric history the trend engine learns its baselines from — and
would also destroy the answer to "what have I already covered", which is a
question people actually ask. So `content_archive` is a mark. Hidden items keep
being measured, keep feeding baselines and topics, and are simply excluded from
lists unless `archived=only` or `archived=include` asks otherwise.

**The CSV is written for spreadsheets, not for the CSV spec.** Two failures
would otherwise be guaranteed, and both are silent:

A leading `=`, `+`, `-` or `@` makes Excel and Google Sheets treat a cell as a
formula. Titles here are written by strangers, so a video called `=cmd|...` is
a formula injection into the user's spreadsheet. Such values are prefixed with
a single quote, which spreadsheets read as "this is text" and do not display.

Without a UTF-8 BOM, Excel on Windows reads the file in the system codepage,
and every Persian and Arabic title arrives as mojibake — which makes the export
worthless for precisely the person this is built for.

Newlines inside titles are kept and quoted rather than stripped. They are legal
CSV, every real parser handles them, and quietly deleting content to be safe
would be its own small dishonesty.

---

## ADR-026 — No perceptual hashing for media

**Status:** accepted (as a decision not to build)

Duplicate detection across sources was going to include perceptual hashing of
thumbnails, so the same image reposted under different titles would collapse
into one item.

It is not being built, for reasons that should be recorded so the idea is not
re-proposed as an oversight.

Perceptual hashing needs decoded pixels. This project has zero runtime
dependencies by design, so it would mean hand-writing a baseline JPEG decoder —
several hundred lines of exacting, easy-to-get-subtly-wrong code — to feed a
hash whose output is a heuristic anyway.

Against that, the signal it would add is already largely covered. SimHash
catches reposts with near-identical text, and the semantic clustering added in
ADR-023 catches reposts whose text differs entirely, including across
languages. What remains is a genuinely identical image under genuinely
unrelated wording, which is rare.

If media dedup becomes worth it — a source that is mostly images, with weak
titles — the honest version is a small optional decoder or an external tool
behind the same "never required" rule every other integration follows.

---

## ADR-027 — Discovery earns its way off the paid path

**Status:** accepted

An audit of where the YouTube quota went produced one number worth acting on:
**25 quota units per useful video**. 3,749 units bought 2,015 videos, of which
148 ever reached a state worth looking at. A third arrived already dead.

The cause is not the search parameters, which are already tuned — window,
ordering, relevance language, region, term rotation. It is that `search.list`
costs 100 units per call whatever it returns, and it was the only mechanism
buying candidates.

Meanwhile the cheapest mechanism the API offers was switched off. A channel's
public feed costs nothing, and the code to read it already existed for manually
listed channels. `YOUTUBE_WATCH_CHANNELS` was empty because it asks the user to
name channels in advance — which is exactly what a radar exists to avoid.

So the list is no longer named, it is **learned**. A creator with several
measured items and a good average is promoted automatically, read back out of
the scores discovery itself produced. Two guards keep a fluke off the list: a
minimum number of items, so one lucky video is not a track record, and a bar on
the *average*, so a single hit does not carry an otherwise quiet channel.

Measured per run: ~101 units for ~53 items became 102 units for ~100 items.

Two corrections came out of building it, both worth recording because both were
silently wrong before:

**`videos.list` was never charged.** One unit per fifty ids, real money,
counted as zero. The daily figure under-reported actual spend, and the error
would have grown with every id arriving from a free feed. All pricing now goes
through one accounted path.

**Feed items were re-priced every run.** A feed returns the same fifteen
uploads until the channel posts again, so each run paid to re-read what it
already had — about 13 units a run against sixty channels. Sources can now ask
which ids are already stored, which is a capability rather than a database
handle, and so keeps the plugin sandbox intact.

One cost accepted deliberately: a discovery run now takes about a minute rather
than seconds, because sixty feeds are read at one request per second. At a
twenty-minute interval that is under 5% duty cycle, and being impolite to a
free endpoint to save forty seconds would be a bad trade.

---

## ADR-028 — Never rank the whole time series to answer a question about ten rows

**Status:** accepted

The analysis pass took 129 seconds inside a 600 second interval — a 21% duty
cycle, and rising, because discovery had just been changed to return roughly
twice as many items.

Profiling rather than guessing found the cost in one place, and not the one
expected. Clustering, the obvious suspect, took 6 seconds. `creatorSamples`
took **123 ms per call**, once per creator, about 1,300 times.

The query filtered in the wrong order. It computed a `ROW_NUMBER()` window over
the entirety of `content_metrics` — 79,000 rows — and only then narrowed to a
single creator, repeating that for the next creator, and the next. Rewritten as
a correlated lookup that narrows to the creator's own content first, it costs
3.7 ms. The pass now takes 14 seconds.

What makes this worth an ADR is that the codebase already knew. `LATEST()` in
the ranked read does exactly the right thing, with a comment beside it
explaining that `content_metrics` is the largest table and that a `ROW_NUMBER()`
across all of it would be paid on every load. `creatorSamples` was written
later and did not follow it.

So the rule is stated once, here, rather than left in a comment on one query:
**anything that ranks or scans the whole metric series to answer a question
about a handful of rows is wrong, however readable the SQL.** Filter to the
rows you want first; seek the index for each.

Two secondary observations from the same session, recorded because they close
open questions rather than because they needed decisions:

Region tagging on watched-channel items (ADR-027) worked — no untagged items
have been stored since, and the remaining 300 predate the fix.

Breakout detection went from 0 to 177 detected, which is the creator backfill
of ADR-024 finally having baselines to compare against.
