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

The re-exec is the part that broke — see ADR-043.

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
- **Saving is honest about what happened.** The configuration is rebuilt from
  the file and swapped in, so a save takes effect on the running radar and the
  jobs are re-registered with any changed intervals. Three answers are possible
  and the response distinguishes them: applied, applied except for a named key
  that needs a restart, or written and refused because the new values do not
  validate. A refusal leaves the running configuration untouched — half-applying
  an invalid one to a live radar is worse than not applying it.

The file keeps its comments and ordering, because it is still a document the
user edits by hand.

*Updated: this originally read "the response says a restart is required rather
than pretending the change is already live", which was honest but wrong-headed.
Telling someone to restart after editing a sentence of description is the kind
of friction that makes a setting go unused. The rebuild is what removed it; the
honesty stayed.*

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

That number did not hold, and not because the query changed — see ADR-042.

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

---

## ADR-029 — Seed words are judged on what they found, and the judgement expires

**Status:** accepted

Open discovery has to supply a query string, so it rotates fifteen very broad
seed words. Each search costs 100 quota units. Which words ever surfaced
anything that went on to matter was not recorded, so all fifteen were rotated
equally for ever and a word that had never produced a mover cost the same as
one that produced them regularly.

The word that surfaced each item is now stored on the item. Aggregating it
would have been smaller, but the yield of a word is only knowable *after* the
items it found have been scored — hours later — and the column is the only link
back to them.

The selection rule is where the care went, because both ways of getting this
wrong are easy:

**Demoting too eagerly kills new words.** A word added yesterday and a word
that has failed for a month look identical if you only count movers. So a word
is demoted only after at least 40 items found with not one ever moving. Below
that, silence means "not enough turns", not "no good".

**Demoting permanently freezes a judgement about a moving target.** What is
trending changes; a word that was dead last month need not be dead now. So
every fifth run the demoted words get a turn regardless, and a demotion can be
overturned by the evidence it produces.

Two properties fall out and are worth stating because they are what make this
safe to ship on day one. With no measurements — every fresh database — the
rule reduces exactly to the fair rotation it replaces. And if every word ends
up demoted, it searches anyway rather than returning nothing: discovery going
quiet would look like a calm system rather than a broken one, which is the
worst failure mode available here.

---

## ADR-030 — MCP by hand, over the API, named for questions

**Status:** accepted

A survey of comparable projects found one feature worth copying outright: the
category leader on GitHub exposes its data over MCP, and this user works inside
an AI assistant every day. The shortest path from a measurement to a decision is
being able to ask for it.

Three decisions inside the implementation.

**No SDK.** MCP is JSON-RPC 2.0 over stdio with three methods that matter. That
is fifty lines, and writing them keeps the promise the rest of the project makes
— no runtime dependencies — rather than spending it to save an afternoon.

**Through the HTTP API, not the database.** The query logic already lives in the
API and duplicating it would let the two drift; the analysis pass holds long
write transactions that a second reader would contend with; and when the radar
is not running, "start it" is a better answer than a stale read. The cost is
that the radar must be up, which is the correct dependency to have.

**Tools named for questions.** `whats_rising`, `best_time_to_post`,
`what_shape_wins` — not `query_content_scores`. A tool named after a table makes
the model translate between the schema and the question, and it does that badly.
Results are rendered as prose with units spelled out, for the same reason: a
model reasons better over "better by 21.2 points (±9.0, from 68 items)" than
over a nested object it has to interpret.

Two failures found by writing the tests rather than by reading the spec:

The logger writes to **stdout**, which is the protocol channel — so `silent` had
to become a real log level rather than a string that quietly fell back to
`info`. Without it, the first log line would corrupt the stream and the client
would report a parse error instead of an answer.

And malformed input was answered with silence. `fail()` treats a null id as "a
notification, stay quiet", but a parse error is precisely the case the spec says
must be answered with a null id — the id could not be read, so silence leaves
the client waiting for ever.

---

## ADR-031 — Subject matching by embedding, not by asking a model per item

**Status:** accepted

Every filter in this system was categorical: language, country, platform, type,
state. None of them can express "I make Persian comedy clips", and that is the
filter a creator actually wants — subject is not a category any source supplies.

The obvious implementation is to score each item with an AI. It is what the
comparable projects do, and it costs one call per item, per run, indefinitely.

It is also unnecessary here. ADR-023 already built a sentence embedding for
every item, using a model that had to demonstrate it can separate related from
unrelated text in the user's own languages. Embedding one description and taking
a dot product against vectors that already exist gives the same answer
instantly, offline, and at no marginal cost. Measured on the live corpus against
a Persian comedy description: comedy clips at 0.80, unrelated foreign news at
0.01.

Three decisions about honesty, which is where a feature like this usually goes
wrong:

**It is called a match, not a score.** The number is a similarity between two
pieces of text. It is displayed as a percentage rather than a decimal so it does
not read as a verdict out of one, and the MCP tool says outright that it is not
a judgement about quality.

**An unscored item is null, never zero.** Zero would mean "measured, and
irrelevant". Null means "not measured yet", and the filter keeps those rather
than dropping them. Getting this backwards would bury every newly collected
item behind a test it had not taken — precisely the items the whole system
exists to surface.

**Rewording clears the corpus.** A stored match answers a question that was
asked with particular words; change the words and every stored value is
answering something nobody asked. They are cleared and rescored rather than
left to filter against a definition that no longer exists.

One implementation trap worth recording: the relevance backfill was first gated
behind the embedding step having work to do. On the day a description is
written every item is already embedded, so nothing passed through and nothing
was ever scored — the feature appeared to do nothing at all, with no error.

---

## ADR-032 — Thumbnails measured crudely, reported honestly

**Status:** accepted

The format analysis could say a hundred-character title outperforms a
twenty-character one, with an interval. It said nothing about the image, which
for a video audience is at least half the click.

ADR-026 declined perceptual hashing because it needs decoded pixels, and with
no runtime dependencies that meant hand-writing a JPEG decoder. That reasoning
still holds for *hashing*. It does not hold for *measurement*, because the
answer turned out to be a split:

**The file header alone is informative.** Dimensions come free, and so does
compressed bytes per pixel — an image full of text, faces and edges cannot be
squeezed as hard as a flat one, so density reads as visual busyness. No decoder
required, so this half works everywhere.

**The rest uses `ffmpeg` if it is there.** Brightness, contrast, colour and
skin tone need pixels. `ffmpeg` reduces a thumbnail to a 16×16 raw RGB grid,
which is 768 bytes and plenty for a mean and a spread. It is optional exactly
as Ollama is: absent, the analysis has fewer columns and says so.

The measures are deliberately crude. "A person is in frame" is a count of
skin-toned pixels by the Kovac rule, which wood, sand and orange walls also
satisfy. That is acceptable *only* because the statistics around it are the
same honest ones as everywhere else — sample sizes, confidence intervals, and
a refusal to call anything a finding the data cannot support. A rough signal
measured across thousands of items and reported with its error bars is useful;
a sophisticated one presented as certainty is not. The interface says so above
the charts rather than in a footnote.

One thing worth recording because it nearly shipped wrong: the first bands were
tidy round numbers, and they put 75% of real thumbnails in a single "dark"
bucket. A group where four in five items share a label says nothing however
carefully it is measured. The boundaries were recalibrated against the actual
distribution — thumbnails are much darker, punchier and warmer than an
untrained guess expects — and one "finding" disappeared in the process, which
is the clearest possible argument for having looked.

---

## ADR-037 — Stratification belongs in `lift.ts`, not in each analysis

**Status:** accepted · **generalises ADR-022 and ADR-036**

The same correction has now been discovered four times. Timing was measuring
item age (ADR-022). The thumbnail analysis was measuring letterbox padding
(ADR-036). The opening analysis was measuring which subjects are made as
shorts. And the title analysis — sitting on the same page as the second of
those, one file away from a working implementation — was measuring the content
type mix: a 26.8-point spread across types, wider than the age effect that
prompted the first fix.

Each time the fix was written inside the module that had the bug, so the module
next door kept it. `stratify` now lives in `lift.ts` alongside `summarise`,
which is where the definition of "what counts as a finding" already lives, and
the three existing users call it instead of carrying their own copy.

What it cost to not have it: on a real corpus the title analysis reported emoji
at +4.0 and hashtags at +3.0 as proven results under the heading "What the data
actually supports". 63% of emoji titles and 77% of hashtag titles are shorts.
Stratified, both are approximately zero. A genuine effect was hidden the other
way — question marks read +0.7 and unproven pooled, and −2.5 and proven once
the format is removed.

The rule this leaves: **anything that buckets a mixed population by something
other than what varies most across it needs a stratum**, and the spread removed
is always reported, because when the correction is larger than the finding the
reader is looking at the correction.

---

## ADR-036 — Thumbnail measures are adjusted for the frame, not just the picture

**Status:** accepted · **corrects ADR-032**

The thumbnail analysis shipped reporting that dim images win. They do not. It
was measuring the letterbox.

YouTube serves every thumbnail at 320x180. A short is filmed 9:16, so it
arrives fitted into that frame with black bars down both sides, and the bars
are pixels like any others. On a corpus of 8,469 YouTube thumbnails, shorts
averaged 0.219 brightness against 0.321 for ordinary videos, and compressed to
6,953 bytes against 11,934 — a 42% difference at identical pixel dimensions,
which is the signature of large flat regions rather than of darker photography.
Brightness, saturation and density are all contaminated by it.

Pooled, that produced "dim wins". Split by format the effect reverses: among
shorts, dim was +2.7 and very bright -3.7; among ordinary videos, very bright
was +2.3 and dark -3.6. The pooled number was not a compromise between two
truths, it was the format mix wearing a brightness label — and shorts both
outnumbered videos and performed differently.

Every measure is now centred within its own content type, the same
stratification ADR-022 applies to age in the timing analysis, and the spread
removed is printed above the charts. After the correction the brightness bands
sit at -2.3, +2.0, +0.7 and +1.9: brightness barely matters, which is the
honest answer and was always available underneath.

The measurements themselves are still taken over the padding, so a "dim" short
is still mislabelled in absolute terms — the comparison is fixed, the number is
not. Cropping the bars before measuring would fix that too, and needs every
stored thumbnail re-measured to stay coherent, so it is recorded in
`limitations.md` rather than half-done.

Found by a user looking at the examples behind a bar and noticing they were all
padded. That is the drill-down doing the job it was built for.

---

## ADR-033 — A warning you cannot act on is worse than no warning

**Status:** accepted

Two Reddit interventions sat on the System page for two days, telling a user who
had never configured Reddit to go and configure Reddit. They were raised while
Reddit was enabled; the user then narrowed the enabled sources to Google Trends
and YouTube, and the warnings outlived the source that produced them.

Nothing could resolve them. The source that would clear the condition never
runs, so the only exit was manual dismissal of something the user did not cause
and could not fix. Meanwhile a healthy system looked broken.

Interventions are now filtered on read to sources that are actually enabled.
Filtered rather than deleted: the record is history, and re-enabling the source
should bring the warning back without it having to be rediscovered. The count of
muted ones is returned alongside, so "why am I not seeing this" has an answer
that is not "read the database".

The general rule: **an alert is a request for action.** If the person reading it
has no action available, it is not an alert, it is noise wearing an alert's
clothes.

---

## ADR-034 — A desktop build, using each platform's own mechanisms

**Status:** accepted

Running this needed a terminal, a Node install and a command that keeps a window
open. That is fine for the person who wrote it and a wall for everyone else, so
it is now a single file you download and run.

**Node's own SEA, not a framework.** The executable is a copy of the Node runtime
with the app injected into it — no Electron, no Tauri, no Rust toolchain. It
costs one dev dependency (esbuild, to flatten the ES modules into the single
CommonJS file SEA requires) and produces about 90 MB, nearly all of it Node.

Two things are read from disk at runtime and had to move inside: the SQL
migrations and the built dashboard. Both are inlined at build time by swapping a
committed stub module for a generated one. Every consumer checks whether the map
is empty and falls back to disk, so one code path serves both builds and neither
knows which it is in.

That swap exposed a trap worth recording. `import.meta.url` is empty in a
CommonJS bundle, and two module-level constants were computed from it — so the
packaged binary threw before reaching its first line. They are now computed on
use, which is also where they are actually needed.

**The install mechanism is per-user and unprivileged.** Windows Scheduled Tasks
were the first choice and are wrong: `schtasks /SC ONLOGON` is refused with
"Access is denied" for an unprivileged user *even when registering the task for
that same user*, so installing would have demanded elevation for something that
needs none.

The second attempt — a Run registry key pointing at a generated VBScript
launcher, to avoid a console window — was worse in a way that only showed up
against a real machine: **Kaspersky removed the executable and the script
mid-test.** An unsigned binary, running from a temp folder, writing a launcher
and registering itself to start at login is indistinguishable from malware, and
it was treated as such.

So it installs the way ordinary software does. The binary is copied to
`%LOCALAPPDATA%\Programs`, `~/Applications` or `~/.local/share`, and startup is
a visible `.cmd` in the Startup folder, a launchd agent, or a systemd user unit.
Nothing is hidden, nothing touches the registry, and the file that starts it is
somewhere a person can find and delete.

The console window that a `.cmd` leaves is the accepted cost. `start /min` keeps
it out of the way, and a completely invisible process that fails leaves nothing
to notice — which for a tool that quietly collects data all day is the worse
failure.

**A double-click does the useful thing.** With no arguments, a packaged build
checks whether the background service is already answering; if it is, it just
opens the browser rather than starting a second copy and failing to bind the
port.

**It carries its own identity.** A SEA build is a copy of Node, so without
intervention it shows Node's icon and calls itself "Node.js JavaScript Runtime"
in the task manager. The icon and version strings are written with `resedit`,
which is pure JavaScript and needs no Windows SDK. The mark is rasterised from
the same design as the app icon by a small script, because no SVG rasteriser was
available without adding a native dependency.

---

## ADR-038 — Timing is stratified by source as well as by age

**Status:** accepted · **corrects ADR-022**

ADR-022 removed the age confound from the timing analysis and stopped there,
which left the larger of the two in place.

Sources sit at very different ranks by construction: on a real corpus charts
and wikipedia average the 0th percentile of their own distribution, googletrends
the 13th, youtube the 38th, bluesky the 45th. That is a 45-point spread against
age's 22 — and publish hours are not evenly distributed across sources, because
different collectors run on different schedules and different platforms publish
at different times of day. An hour could therefore win by being the hour a
high-ranking source happens to publish in.

The stratum is now the pair, `source|ageBand`. Both spreads are reported so the
page can say which correction did the work. On the live database the top
finding was hour 3 at -11.1 +/-2.8 over 438 items; after the correction it is
-1.6 +/-4.4 over 245 and is no longer a finding at all.

The sample shrinks because the same pass now also excludes date-only
timestamps. A source that records a publication date but not a time lands every
item at midnight UTC, which is not an observation about posting time — it is
the absence of one, and 193 items were sitting at hour 3 in the user's timezone
for that reason alone.

---

## ADR-039 — An opening is judged against accounts of its own size

**Status:** accepted · **corrects ADR-037**

Dividing views by subscribers does not remove the channel-size effect. It
inverts it, and the inverted version is bigger than the format effect ADR-037
was written to fix.

After the format correction, and on the same corpus that correction was
validated against: accounts under 100 subscribers read 10.1x, accounts over
100,000 read 0.27x. A 37-fold gradient, against format's 4.5-fold. A channel's first hundred
subscribers are the least predictive of who sees a video — one video reaching a
recommendation feed swamps the denominator — and its hundred-thousandth is the
most. So the list was a ranking of which subjects very small accounts tag.

The stratum is now `contentType|sizeBand`, with bands at 100 / 1k / 10k / 100k.

What that cost while it was wrong is the strongest evidence for it: the two
subjects the module cited as its own validated answer, `qadimi` at rank 1
(14.9x, median 81 subscribers) and `rap` at rank 3 (12.2x, median 89), fall to
rank 76 at 1.4x and rank 176 at 0.9x — the second being exactly ordinary for
accounts that size. Most of the top ten changed. The eight-channel bar was
re-derived against the corrected measure rather than inherited; eight still
holds, for the same reason and on different subjects.

This is the fourth instance of ADR-037's rule and the second module where the
first stratum found was not the largest one. The check that catches it is
mechanical: for each candidate confound, print the gradient across it *after*
the corrections already applied.

---

## ADR-040 — Each thumbnail measure is judged against the images it could be read from

**Status:** accepted · **extends ADR-032**

The thumbnail analysis is the only one where the items in the buckets are a
strict subset of the items in the baseline, and the difference is not random.

A thumbnail that failed to download, or that the decoder could not read, is
still a row. The pipeline records it on purpose, so a failure is visible rather
than silently retried. It has no brightness, so `assignThumbnailBucket` returns
null and it lands in no band — while still sitting in a baseline computed over
every item. ADR-032 covers only the all-or-nothing case: absent, the analysis
has fewer columns and says so. It does not cover partial coverage.

Those rows average the 28.0 adjusted percentile against 35.5 for the rest, so
they pushed every band of every group the same half-point in the same
direction. That shift is a measure of how often the decoder worked, wearing a
brightness label. Today it is under every band's margin and never inverts a
direction, but nothing holds it there: it is proportional to the coverage
missing, and at 60% coverage it moves every band by nearly three points.

The baseline is now computed per group from the items that group could place,
and each group reports how many it could not. Per group rather than once,
because `busyness` reads `density`, which is missing on more items than
`brightness` is — one shared correction would be wrong for both.

The headline number over every item is kept, and labelled as a headline.

---

## ADR-041 — The examples behind a thumbnail bar are ranked by that bar's own measure

**Status:** accepted · **restores the guarantee in ADR-036**

The drill-down that shows real thumbnails behind a bar was ranking them by raw
percentile while the bar was computed from the format-adjusted residual.

The endpoint's contract already said otherwise — *"ordering is by the measure
the bar itself was computed from, never by raw score"* — and the timing branch
honours it. The thumbnail branch could not: `formatAdjusted` was declared
without `export`, so the adjusted value was not reachable from the call site.
Nothing failed; a private helper is not a visible symptom.

Format means span 43.6 points inside this sample, so the two orderings barely
overlap: on the live database, ranking the brightness bands both ways shares 0
to 4 of twelve items. Half to all of the thumbnails offered as proof for a bar
were selected by which format they were in — the exact confound ADR-036
removed, reintroduced in the one place a reader goes to check the number, and
the mechanism ADR-036 credits with catching that confound in the first place.

No reported statistic was wrong. This is the worse failure of the two: a
correct number illustrated with the wrong evidence, where the check that would
find the next confound of this class had been quietly disabled.

---

## ADR-042 — The database is given statistics, and the index the planner needs anyway

**Status:** accepted · **continues ADR-028**

ADR-028 rewrote `creatorSamples` from 123 ms per call to 3.7 ms and recorded a
14-second pass. On the live 198 MB database the same query had drifted back to
18.5 ms per call, and the fix was not in the query at all.

`ANALYZE` had never been run. `sqlite_stat1` did not exist, so the planner was
guessing from index shape alone, and for `WHERE source = ? AND author_id = ?
ORDER BY first_seen_at DESC` it chose `content_source_seen_idx (source=?)` —
satisfying the ordering and then testing `author_id` on every row of the
source. A full scan of YouTube per creator, about fifteen hundred times a pass.
Which is the anti-pattern ADR-028 is about, arrived at by a different route: the
query narrows correctly, the planner was declining to.

Measured on a copy of the live file:

```text
as it shipped     SEARCH c USING INDEX content_source_seen_idx (source=?)
                  18.47 ms per creator   ->  27.0 s per pass
after ANALYZE     SEARCH c USING INDEX content_author_idx (source=? AND author_id=?)
                   0.05 ms per creator   ->   0.1 s per pass
```

`ANALYZE` on that file takes 282 ms, once.

Three changes, because a decision this expensive should not rest on one
mechanism:

  - `ANALYZE` when `sqlite_stat1` is absent, and after any migration. Absent
    statistics are catastrophic; stale ones are a rounding error next to that,
    so this does not run on a schedule.
  - `PRAGMA optimize` at shutdown and on the daily sweep, which is what keeps
    them current. SQLite decides for itself whether anything is worth redoing.
  - `content_author_seen_idx (source, author_id, first_seen_at DESC)`, which
    serves both the equality and the ordering and was chosen unconditionally in
    testing — including with no statistics at all.

The pass now takes 8.2 seconds on a database twice the size of the one ADR-028
measured. What makes this worth recording is where the time was going: the pass
runs synchronously, on the thread serving HTTP and the live stream, inside a
write transaction. Thirty seconds of every ten minutes was not slow background
work, it was the whole program stopping.

---

## ADR-043 — The proxy re-exec is built from the shape of the build

**Status:** accepted · **repairs ADR-011**

ADR-011's re-exec worked from a clone and failed in every packaged launch
shape, in the two opposite ways that are each worse than an error.

The child's arguments were `['--use-env-proxy', ...process.argv.slice(1)]`.
`slice(1)` drops the executable and keeps the script path, which is right for
`node main.ts serve` and wrong for `viral-radar serve` — a packaged build still
has something in `argv[1]`, so the child received an extra argument. It also
does not parse Node's CLI flags at all, so it read `--use-env-proxy` as the
command name. Against the shipped binary:

```text
$ NETWORK_MODE=HTTP_PROXY PROXY_URL=... ./viral-radar.exe serve
restarting with proxy routing enabled
Unknown command "--use-env-proxy". Try: radar help        # exit 1
```

`serve` is what the login launcher runs. So configuring a proxy meant the
installed application stopped starting at login: on Windows a minimized console
that exits 1, on Linux a systemd unit with `Restart=on-failure` looping.

The other shape is quieter and worse. `applyNetworkMode()` sat *below* the
no-argument desktop branch, which returns. Double-clicking the executable —
the ordinary way to start it before the next logon, since installing does not
start it — therefore collected entirely over direct connections. Not a wall of
errors: a working dashboard, and every platform contacted from the user's own
address. `radar doctor` reported `network HTTP_PROXY via proxy` throughout,
because it is excluded from `applyNetworkMode` so its probes measure a plain
connection.

Both are fixed: the child's argv is chosen by `isPackaged()`, the flag travels
in `NODE_OPTIONS` (which both build shapes honour, so there is one mechanism
rather than two), and `applyNetworkMode()` runs before any branch that returns.

`NETWORK_MODE` and `PROXY_URL` are also added to `RESTART_REQUIRED`. Saving
them used to answer "Saved and applied. No restart needed", which is the worst
available lie: the person who has just configured a proxy carries on collecting
from their own address believing they are not.

Neither failure could appear in development, because from a clone the argv is
correct and nothing had ever run the packaged binary with a proxy set. The
release workflow now does, on every platform, and fails on the exact string the
broken child printed.

---

## ADR-044 — Scoring covers the window; clustering covers the recent part of it

**Status:** accepted

`contentToScore` took the first 4,000 rows of its window. Its only caller never
passed a limit, so that default always applied, and on a real database it meant
4,000 of 9,022 eligible items — reaching 9.3 hours back into a 48-hour window.

The 5,022 it dropped were the oldest, which is the worst possible way to cut.
An item that is not re-scored keeps the score *and the age* it had when it was
last read, and the dashboard filters on that stored age. So items were passing
a "last 24 hours" filter while actually being older, with states frozen at
whatever they were — RISING, HOT — hours after the fact. Nothing logged it.
`docs/architecture.md` promised "score every item in the window".

There was also no index on `last_seen_at`, so the query was a full scan of
`content` plus a temporary B-tree, over rows carrying `body` and `raw`, every
ten minutes: 270 ms for the truncated 4,000. With the index, all 9,022 come
back in 103 ms — twice the data, faster.

Raising the cap alone took the pass from 8 seconds to 51, and profiling put 47
of those in one place. Clustering's blocking threshold is a fraction of the
corpus size, so at ten thousand documents a term appearing in twenty-six
hundred is still used to find candidates: the candidate sets grow with the
corpus and the work grows with its square. Scoring 10,653 items takes 2.9
seconds. Clustering them takes 47.

So the two populations are now different, deliberately. Every item in the
window is scored; the most recent 4,000 are clustered — which is exactly the
set clustering was already receiving, back when the scoring cap was silently
doubling as its own. The pass costs about 10 seconds for 2.7 times the scoring
coverage.

Naming the clustering limit is the point. It was previously invisible, a
side-effect of a number that looked like it was about memory. Making it
absolute rather than proportional is the real fix and changes which clusters
form, so it is recorded in `docs/limitations.md` rather than guessed at here.

The scoring ceiling stays, at 50,000, because a ceiling on memory is still
worth having — every row in that table holds 6.6 MB of text in total, so it is
far above anything retention allows. When it binds, the pass now says so.

---

## ADR-045 — The gaps page spends one budget, in the unit that costs

**Status:** accepted

The page compared seven days of demand against about thirty-eight hours of
supply, and said neither number.

`supplyItems` took the newest 4,000 rows of the window. On the live database
9,610 were eligible and the 4,000th reached 37.8 hours back into a 168-hour
window. That cut is the worst possible shape for this question: coverage is a
count over the supply set, so every dropped item can only push a topic towards
"uncovered", and the older a demand topic is the less of the supply that
existed when it trended is still in the comparison. The bias runs one way, and
hardest on exactly the rows the page is about.

Measured against the full window, two topics changed verdict — one matched an
official trailer collected 90 hours earlier at 0.751, well inside the window
and well outside the slice. The documented escape hatch fails in the same
direction: the "closest match" line, which exists so a wrong threshold becomes
visible, printed unrelated videos at 0.49 and 0.67 and so reported a *more*
confident gap than the truth.

Three changes.

**The budget is pairs, not items.** Cost here is topics times items, so capping
the two independently caps nothing: 200 topics and 20,000 items were each
defensible alone, and together sixteen times the load the code's own comment
called unacceptable — reachable from a URL, because the parameter parser clamps
rather than refuses. One budget of 700,000 pairs is spent on whichever side
asked for more. At the defaults it buys the whole window.

**The matcher keeps only what it shows.** It built a match object for every
pair and sorted the lot to read three of them: 621,000 allocations for 180
results, and the `score <= 0` guard filters almost nothing because 93% of real
dot products are positive. A short ranked list gives the same answer for a
third less time, which is part of what makes comparing the whole window
affordable.

**What was compared is on the page.** `supplyEligible`, `supplyCompared` and
the age of the oldest item compared. A bare count of 4,000 looks identical
whether the database holds four thousand items or forty thousand, and when the
supply window is shorter than the demand window the page now says so before the
list rather than not at all.

The cost of answering honestly is about 2.7 seconds of single-threaded work on
a week of collection, against 0.9 for the wrong answer. It is a page a person
asks for and waits on, so that is the right way round — but it is a real stall
on the thread that also serves the live stream, and it is recorded in
`docs/limitations.md` rather than left to be discovered.
