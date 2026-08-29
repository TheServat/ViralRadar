<p align="center">
  <img src="docs/cover.svg" alt="Viral Radar — what is exploding on the internet right now" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/TheServat/ViralRadar/actions/workflows/ci.yml">
    <img src="https://github.com/TheServat/ViralRadar/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <img src="https://img.shields.io/badge/node-%E2%89%A524-informational" alt="Node 24 or newer" />
  <img src="https://img.shields.io/badge/runtime%20dependencies-0-success" alt="Zero runtime dependencies" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="MIT licence" /></a>
</p>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a> ·
  <a href="#what-it-measures">What it measures</a> ·
  <a href="#sources">Sources</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="docs/">Docs</a> ·
  <a href="#راهاندازی-سریع-فارسی">فارسی</a>
</p>

---

# Viral Radar

A local program that answers one question, without you typing a topic:

> **What is exploding on the internet right now — and what should I make today?**

It watches public sources, measures how fast each post is growing, compares that
growth with what is *normal for that platform and that creator*, groups the same
story across platforms, and ranks what it finds.

No topic input. No AI required. No account anywhere. Nothing leaves your machine.

## Install it like a program

Download the file for your system from
[Releases](https://github.com/TheServat/ViralRadar/releases), then run it once:

```bash
viral-radar install
```

That copies it where programs belong, starts it at login, and puts a shortcut on
your desktop. **Node does not need to be installed** — the runtime is inside the
file — and nothing needs administrator rights. `viral-radar uninstall` stops it
starting at login and leaves your settings and database alone.

From then on it collects in the background and the shortcut opens the dashboard.

macOS and Windows will warn that the app is unsigned, because these builds carry
no code-signing certificate. On macOS: right-click, Open, then Open again. On
Windows: More info, Run anyway.

## Quick start

```bash
npm install            # dev tooling only — the backend has zero runtime dependencies
cp .env.example .env
npm run build          # builds the dashboard once
npm start              # http://127.0.0.1:7788
```

Needs **Node.js 24 or newer** and nothing else — no database server, no Docker,
no cloud account. On Windows, `scripts\install.ps1` does all of the above and
puts a shortcut on your desktop.

Five sources start working immediately with no configuration at all. The rest
each need a free key, and the **Settings** page walks you through them.

> **Give it two collection cycles — about 40 minutes — before judging the
> results.** Growth cannot be measured from a single observation, so the first
> pass is only a snapshot. This is not a bug; it is what the whole thing is
> about.

## What it measures

The unit of analysis is **a piece of content and how its numbers move over
time** — never a predefined topic.

| Signal | What it answers | Weight |
| --- | --- | --- |
| **Velocity** | how fast is it gaining, per hour | 30% |
| **Acceleration** | is the growth itself speeding up | 30% |
| **Anomaly** | how far above this creator's own normal is it | 15% |
| **Engagement** | interactions per unit of reach | 10% |
| **Cross-source** | do independent platforms carry the same story | 10% |
| **Freshness** | time decay | 5% |

Raw numbers are never compared across platforms. Each value is first ranked
against **that platform's own recent distribution**, per hour of day, so a
Reddit upvote and a YouTube view can end up in the same list honestly.

Every item carries a **score** (0–100, how remarkable) and a separate
**confidence** (0–1, how much evidence backs it). A 40M-view video seen once has
a high score and low confidence — and the dashboard says so.

**Lifecycle:** `NEW → EMERGING → RISING → HOT → VIRAL → PEAK → DECLINING → DEAD`.
`EMERGING` deliberately means *small but exploding* — the 1,200-follower account
at hour two, not the thing everyone already saw yesterday.

<details>
<summary><b>Worked example: why 60 points can outrank 326</b></summary>

Two Hacker News posts, real numbers from a running instance:

| | Harness Engineering | Queryable Executables |
| --- | --- | --- |
| Points | 60 | **326** |
| **Growth** | **69.6 points/hour** | 3.8 points/hour |
| Acceleration | 70.0 | 3.1 |
| Age | 1.2 hours | 38.8 hours |
| Freshness | 0.90 | 0.03 |
| Growth rank on the platform | 97th percentile | 76th |
| **Score** | **65.9** | 59.8 |

The second has five times the points and loses, because sixty percent of the
weight is on growth rather than size. The first is exploding *now*; the second
already happened.

</details>

## Sources

Sixteen adapters. Eleven need nothing but the program itself.

**Working with no configuration**

| Source | Gives | Real metric |
| --- | --- | --- |
| **Google Trends** | search topics per country | approximate traffic band |
| **Google News** | 8 topic sections × your language and country | — |
| **Wikipedia** | most-read articles per language | **daily pageviews** |
| **Hacker News** | stories, `top` and `new` | points, comments |
| **RSS / Atom** | any feed you list | — |
| **Mastodon** | posts, hashtags and shared links | favourites, boosts, replies |
| **Bluesky** | public feeds | likes, reposts, replies, quotes |
| **GitHub** | recently created repositories | stars, forks |
| **Charts** | Steam, Apple, Spotify | rank movement, concurrent players |
| **Telegram** | public channel previews | **views per post** |

**One free key each** — the Settings page links to every one

| Source | Gives | Why it matters |
| --- | --- | --- |
| **YouTube** | trending charts and open search | **real view counts** — the most valuable source here |
| **Reddit** | `r/all/rising`, `r/popular` | upvotes, comments, crossposts |
| **Imgur** | the gallery: `viral` and `rising` | **views per post** — the purest virality signal |
| **Twitch** | live streams | **people watching right now** |
| **TMDB** | film and television | a popularity figure that moves daily |
| **Product Hunt** | product launches | votes, comments |
| **Giphy** | trending GIFs and stickers | rank only |

**Registered but unavailable:** TikTok, X and Instagram appear in the dashboard
with the exact reason they cannot run and the exact step that would change it.
They return no data rather than fake data. See [docs/sources.md](docs/sources.md).

## The dashboard

Vue 3, TypeScript and Vuetify, in **English, Persian and Arabic** with full
right-to-left support. Built once and served by the same process as the API —
one port, no second server.

| Page | What it is for |
| --- | --- |
| **Dashboard** | viral now, breaking out, emerging, rising, cross-platform topics |
| **Today's brief** | *what to make today*, what matches your own channel, and what peaked while you were away |
| **What works** | what *shape* of content wins, and what hour to post it |
| **All trends** | every item, with filters that apply after detection |
| **Topics** | stories grouped across platforms |
| **Creators** | breakouts and a leaderboard measured against each account's own history |
| **Reports** | scatter, heatmap, timeline, distributions, per-source quality |
| **Sources** | what each plugin can do, its health, and what it needs |
| **System** | jobs, events, network state, manual interventions |
| **Settings** | writes `.env`, with a first-run wizard, and a password if you want one |

Charts are hand-built SVG rather than a library: they inherit the theme, mirror
correctly in right-to-left, animate on data change, and cost a few kilobytes.

## For your channel, not just for the internet

Describe what you make in a sentence — in any language — and the dashboard and
**Today's brief** both lead with the items closest to it.

```bash
INTERESTS=comedy clips and challenges for a Persian-speaking audience
```

The description is embedded once and compared against vectors the clustering
has already built, so it costs no extra model call.

The important part is what it does *not* do. It filters by closeness and ranks
by score — it never sorts by closeness. On a real database the ten items
closest to that description scored between 2.7 and 29 out of 100: the thing
that most resembles a description of comedy clips is a hashtag-stuffed clip
nobody is watching. The useful answer is the intersection — close to what you
make **and** actually moving — and an empty one is allowed, because "nothing
matched today" is a real answer.

## What works

Knowing *what* is spreading still leaves the question a creator acts on: given
that you are making something today, how long should the title be, should it
ask a question, should it be a short video or an image.

The **What works** page answers that for whatever slice you filter to, and it
is built to be read honestly rather than to look decisive:

- **Everything is a rank inside its own platform.** Raw scores cannot be
  compared across sources — Spotify's numbers and Reddit's are not the same
  units — so every comparison uses the per-source percentile the engine
  already computes.
- **The baseline is your filtered set, never 50.** Persian items average the
  32nd percentile of their own sources; calling a 49 "below average" would be
  exactly backwards.
- **A difference the sample cannot support is not a finding.** Every bar
  carries a 95% interval. A bar longer than its whisker is a result; a long bar
  whose whisker crosses the baseline is greyed out and stays out of the
  headline list. Groups under 25 items are shown but never counted.

Real output from one database — Persian, last 14 days, 939 items:

```text
100+ character titles   +17.0   images        +16.5
1-4 word titles         -14.3   text posts     -8.6
emoji in the title       +7.3   question mark  +0.8  ← not a finding
```

The question mark is the point: +0.8 with a ±7.4 interval is noise, and the
page says so instead of dressing it up as a tip.

The same page answers **when to post**, and that half has a trap worth naming.
Rank falls steeply with age — on this database by 32 points between the newest
and oldest items — so comparing publish hours directly would mostly measure
*when the collector happened to be running*. Every item is therefore compared
against others of the same age, and only that residual is aggregated by hour.
The size of the effect that was removed is printed on the page, because when
the correction is bigger than the finding, you should be told.

```text
20:00       +11.1      evening (18–24)   +5.1
03:00       -31.4      night   (00–06)  -21.7
```

Set `TIMEZONE` to an IANA name — `Asia/Tehran`, not `+03:30` — so daylight
saving is handled for you. It defaults to the machine's own zone, which is
often wrong on a VPS or a laptop set up elsewhere, so the resolved zone is
printed above the chart where a mistake is obvious.

What it cannot do is separate correlated causes. Title length travels with
content type, which travels with platform. Normalising per source removes most
of the platform effect and nothing removes the rest, so the page says "these
did better" and never "this will make yours do better".

**Every bar opens.** Click one — or click a finding — and it shows the
strongest items it was computed from: real posts with their thumbnails, view
counts and links. A number like "+17.0" is a claim, and a claim is only usable
once you can see what it was made from. The examples are selected by the same
bucketing the chart used and ranked by the same measure, so what you are
looking at is that bar, not a similar list. On the timing charts that
distinction is load-bearing: ranking them by score would hand back the newest
items in the hour rather than the ones that actually did best in it.

Thumbnail bars open as a **gallery** rather than a list — an answer about
images that shows them 64 pixels wide has not answered anything. Each one
carries the measurement that put it in that band, so the grouping is checkable
rather than something to take on trust, and clicking gives you the picture full
size without opening the platform. Every other bar can be switched to the same
view.

## What thumbnail wins

The title analysis can say a hundred-character title beats a twenty-character
one. It said nothing about the image, which for a video audience is at least
half the click.

Thumbnails are now measured the same way — same statistics, same refusal to
call noise a finding. On 1,136 Persian thumbnails:

```text
vivid colour   -4.4      muted colour   +3.2
cluttered      -4.0      a person in frame  +2.9
```

Restrained colour, uncluttered, a person visible but not filling the frame.

Dimensions and **busyness** — how hard the image resisted compression, which
rises with text, edges and detail — come from the file header and need nothing
installed. Brightness, contrast, colour and skin tone need a decoder, and
`ffmpeg` is used when it happens to be present. Without it the analysis simply
has fewer columns and says so.

The measures are rough on purpose: "a person in frame" is inferred from
skin-toned pixels, which wood and sand also satisfy. That is survivable
because the statistics are honest — a rough signal measured across thousands
of items with its error bars shown is useful, where a sophisticated one
presented as certainty is not. The interface says this above the charts, not
in a footnote.

```bash
MEDIA_PER_RUN=250        # thumbnails measured per run; 0 switches it off
MEDIA_INTERVAL_MIN=15
```

## Filtering by what you actually make

Every other filter here is categorical — this language, that platform, that
country. None of them expresses *"I make Persian comedy clips"*, which is the
filter a creator actually wants, because subject is not a category the sources
supply.

Describe your channel in a sentence:

```bash
INTERESTS=کلیپ طنز و سرگرمی، چالش، ترفند و ویدیوهای کوتاه
```

Then sort or filter by **match**. On a live database, the same Persian feed:

```text
by score                         by match
70.5  dollar exchange rate       80%  a dusty shoebox I found of my mother's
66.6  #dollyparton               80%  subscribe ❤️
61.3  #dollyparton               77%  Persian short story, went dark 😂
59.2  #DollyParton               77%  dubbed “neighbour from hell” clip
58.3  a football skill clip      73%  #ترفند #اکسپلور
```

**It costs no model call.** The obvious way to build this is to ask an AI about
each item — which is what comparable tools do, once per item, per run, for ever.
Unnecessary here: the clustering already builds a verified multilingual
embedding for every item, so embedding one description and taking a dot product
gives the same answer instantly and offline.

Two things it is careful about. Match is a *similarity between two pieces of
text*, not a judgement about quality, and the interface says so rather than
dressing it up as a verdict. And an item that has not been scored yet is never
filtered away — unscored means the embedding job has not reached it, and hiding
new arrivals behind a test they never took would bury exactly what this exists
to surface.

Needs `EMBED_MODEL`. Empty `INTERESTS` and every list behaves as before.

## Asking it questions

The radar speaks [MCP](https://modelcontextprotocol.io), so an AI assistant can
read your own measurements instead of guessing. `.mcp.json` is committed, so in
Claude Code it is available in this directory with no setup — just ask:

> what is rising in Persian right now, what shape should it be, and when should I post it

Eight tools, named for questions rather than for tables:

| Tool | Answers |
| --- | --- |
| `whats_rising` | what is still climbing, by acceleration — the "what do I make today" list |
| `trending_now` | what is spreading, strongest first |
| `topics` | stories grouped across platforms and languages |
| `creator_breakouts` | posts far above their own account's normal |
| `what_shape_wins` | title length, content type, what the title contains |
| `best_time_to_post` | which hours and days, with age subtracted |
| `search_radar` | free-text search over everything collected |
| `for_my_channel` | what is trending **that fits what you make**, matched by meaning |
| `what_thumbnail_wins` | brightness, colour, clutter, whether a person is in frame |
| `radar_status` | is it running, how much has it collected, what is switched on |

It reads through the HTTP API rather than the database, so it never contends
with the analysis pass for locks, and if the radar is not running it says so
instead of returning something stale.

No SDK: MCP is JSON-RPC over stdio, which is small enough to implement
directly and keeps the zero-dependency promise.

## Working through it

Three things that turn the dashboard from something to look at into something
to work from:

**Hide what you have done.** A tick on any card marks it dealt with, and it
stops appearing. Not a delete — it keeps being measured and keeps feeding
baselines and topics, so hiding a thing never costs you the data behind it.
**Show hidden** on the trends page lists what you have covered and puts
anything back with one click.

**Export.** Any filtered list, as CSV or JSON, with exactly the filters that
were on screen. The CSV opens correctly in Excel — it carries a BOM, so Persian
and Arabic titles are not mojibake — and a title beginning `=` or `+` is
neutralised rather than executed as a formula when the file is opened.

**What you missed.** At the bottom of Today's brief: things that *peaked* in
the last few days, ranked by the height they reached rather than where they are
now. Anything still climbing is deliberately excluded — that is the rest of the
dashboard. This is evidence about what worked, not a plan.

## Discovery that learns

`search.list` costs **100 quota units** per call and returns whatever matches.
A channel's public feed costs **nothing** and returns the newest uploads of a
channel already measured as good.

So channels earn their way onto a watch list. Any creator with several measured
items and a good average score gets followed for free from then on — nothing is
named in advance, the list is read back out of the scores discovery itself
produced.

Measured on one database, per discovery run:

| | before | after |
| --- | --- | --- |
| quota units | ~101 | **102** |
| items returned | ~53 | **100** |
| from proven channels | 0 | ~50 |

Same cost, roughly double the items, and half of them from channels with a
track record rather than from a keyword match.

```bash
WATCH_TOP_CREATORS=60    # channels to follow for free; 0 switches it off
WATCH_MIN_ITEMS=2        # several measured items, so one lucky post is not a record
WATCH_MIN_SCORE=30       # the bar is the average, not the best
```

Seed words are judged the same way. Open discovery needs *some* query string,
so it rotates broad seed words — but which ones ever surfaced anything that
moved was never recorded, so a dead word kept costing 100 units a turn for
ever. The word that found each item is now stored, and the rotation skips words
with real evidence against them.

Two rules stop that becoming a trap. A word is only demoted after at least 40
items found and not one of them ever moving, so a newly added word is never
starved for being new. And every fifth run the demoted words get a turn anyway,
because what is trending changes and a judgement about a moving target should
not be permanent. With no measurements at all, this is exactly the plain
rotation it replaces.

Two things make this safe. Ids already stored are never re-priced — a feed
returns the same uploads until the channel posts again, and paying for those
twice cost about 13 units a run before it was fixed. And `videos.list` is now
charged properly at one unit per fifty ids; it was previously free in the
accounting but not in reality, so the daily figure under-reported real spend.

## Creator baselines

A breakout — "this got forty times what this account usually gets" — is the
signal worth the most, because it catches a small account mid-explosion rather
than a big account being big. It needs the account's own history, and open
discovery does not produce one: it finds a strong video from a channel and
never goes back. That left 2,189 of 2,770 creators with exactly one measured
item, so 90% could never be judged against themselves.

A background job now fetches a creator's recent uploads to establish their
normal, prioritised by how well their best item did — knowing the baseline for
a channel that reached 70 is worth more than for one that reached 4. For
YouTube it reads the public channel feed, which costs **no API quota**, then
prices the video ids in one batched call: about one quota unit per fifty
videos.

One run of 60 creators took YouTube from 55 to 115 judgeable creators.

These fetched posts are stored apart from the content table and are never
scored, refreshed, clustered or shown. They are reference observations, not
candidates — a backfill reaches into a channel's older uploads, and those are
not trending.

```bash
BACKFILL_PER_RUN=60          # creators per run; 0 switches it off
BACKFILL_INTERVAL_MIN=30
```

## Semantic grouping (optional)

The word-based clustering groups items that share vocabulary. It cannot see two
things with no words in common — which is exactly the same story reported in
Persian and in English. If you publish in Persian about topics the English
internet is also carrying, that is the gap.

With [Ollama](https://ollama.com) and one embedding model, a second pass merges
topics that mean the same thing:

```bash
ollama pull paraphrase-multilingual     # 562 MB
EMBED_MODEL=paraphrase-multilingual
```

Real merges from one database, found by meaning alone:

```text
en  Two German airport workers die of malaria after 'mosquito arrives on plane'
fa  سفر هوایی پشه آلوده به آلمان؛ ۶ کارمند فرودگاه مالاریا گرفتند، ۲ نفر جان باختند

en  US faces critical shortage of Patriot missiles in Europe
fa  کمبود «فراتر از بحران» موشک‌های پاتریوت در اروپا
```

Three things make this safe to switch on:

**It is never required.** Empty `EMBED_MODEL` means the pass does not run and
clustering is bit-for-bit what it was.

**It can only merge, never split.** The word-based pass runs first and is
untouched; this only joins what it produced.

**The model has to prove itself first.** It is asked, in each of your
languages, to separate two sentences that mean the same thing from one that
does not. A model that cannot is refused and logged, not used.

That check is not theoretical. Of three models advertised as multilingual, the
separation scores measured here were:

| model | size | English | Persian |
| --- | --- | --- | --- |
| **paraphrase-multilingual** | 562 MB | 0.87 | **0.99** |
| bge-m3 | 1.2 GB | 0.61 | 0.62 |
| qwen3-embedding:0.6b | 639 MB | 0.59 | 0.57 |

The smallest one is also the best here, which is why it is the documented
default. Anything under 0.15 is rejected outright.

The merge threshold was tuned against a real corpus rather than guessed: at
0.86 cross-language topics doubled with no over-merging, at 0.78 one topic
swallowed 264 items, and at 0.70, 839. Lower it carefully.

## Notifications

Noticing something early is worth nothing if it only happens while you have the
dashboard open. Set `NOTIFY_CHANNELS` and the radar tells you instead.

```bash
NOTIFY_CHANNELS=telegram        # telegram, webhook, or both
NOTIFY_TELEGRAM_BOT_TOKEN=      # @BotFather → /newbot
NOTIFY_TELEGRAM_CHAT_ID=        # @userinfobot gives you yours
NOTIFY_KINDS=viral,breakout,intervention
NOTIFY_MIN_SCORE=65             # below this is not worth interrupting you
NOTIFY_MIN_CONFIDENCE=0.5       # what stops a first measurement being announced
NOTIFY_QUIET_HOURS=23,8         # held until 8am, not dropped
NOTIFY_MAX_PER_RUN=8            # one digest per check, strongest first
```

The webhook channel posts plain JSON, so Discord and Slack incoming webhooks
work unchanged, and so does anything you write yourself. **Send your new
Telegram bot one message first** — Telegram does not let a bot open a
conversation.

There is a **Send a test notification** button on the Settings page, because a
notification setup that silently does nothing is worse than none.

## Locking the Settings page

Settings lists which credentials are configured and can rewrite `.env`. If the
dashboard runs on a machine other people can reach, set:

```bash
SETTINGS_PASSWORD=something-only-you-know
```

The page then asks before showing anything, and five wrong guesses buy a
fifteen-minute lockout. Empty — the default — leaves it open.

This protects the page, not the file. Anyone who can read `.env` can read every
key in it regardless, password or no password.

## Commands

```bash
npm start                          # dashboard + background scheduler
npm run build                      # rebuild the dashboard after changing web/
npm run package                    # build the desktop executable for this platform
npm test                           # 272 tests
npm run typecheck

node apps/api/src/main.ts collect            # one discovery pass, all sources
node apps/api/src/main.ts collect youtube    # just one
node apps/api/src/main.ts refresh HOT        # re-measure the fast movers
node apps/api/src/main.ts analyze            # recompute scores, topics, baselines
node apps/api/src/main.ts top 20             # leaderboard in the terminal
node apps/api/src/main.ts sources            # what is configured and what is not
node apps/api/src/main.ts doctor             # config + database + connectivity
node apps/api/src/main.ts reclassify         # re-run language detection over stored items
node apps/api/src/main.ts cleanup            # apply the retention policy now
node apps/api/src/main.ts mcp                # expose the radar to an AI assistant
```

## Configuration

Everything lives in `.env`, and everything worth changing is editable from the
**Settings** page. See [.env.example](.env.example) for the annotated list.

```bash
REGIONS=IR,US          # countries Google Trends, Google News and YouTube are asked about
LANGUAGES=fa,en        # a preference, not a rule — any page filter overrides it
YOUTUBE_API_KEY=       # unlocks real view counts
HOT_REFRESH_MIN=5      # how often fast movers are re-measured
TIMEZONE=Asia/Tehran   # the clock "when to post" is expressed in
EMBED_MODEL=           # empty = word-based clustering only, which is the default
INTERESTS=             # a sentence describing your channel; empty = no subject filter
BACKFILL_PER_RUN=60    # creators to learn a baseline for per run
WATCH_TOP_CREATORS=60  # proven channels followed for free, no quota
NOTIFY_CHANNELS=       # empty = no notifications; telegram and/or webhook
SETTINGS_PASSWORD=     # empty = the Settings page is open to anyone
MAX_AGE_HOURS=72       # anything older stops counting as "now"
NETWORK_MODE=DIRECT    # or HTTP_PROXY with PROXY_URL
AI_PROVIDER=           # empty = AI_DISABLED, which is fully supported
```

Filters — language, country, platform, type, lifecycle state, minimum score,
creator, hashtag, free text — are applied **after** detection, never before.

## Project layout

```text
viral-radar/
├── apps/
│   ├── api/            backend: pipeline, trend engine, HTTP API
│   │   ├── src/core/       the domain — pure, no I/O, no framework
│   │   ├── src/sources/    one file per platform adapter
│   │   ├── src/pipeline/   collect · analyze · schedule
│   │   ├── src/db/         every SQL statement, plus migrations
│   │   ├── src/notify/     Telegram and webhook channels
│   │   └── tests/          272 tests
│   └── web/            Vue 3 dashboard, built into web/dist
├── docs/               architecture, scoring, sources, security, decisions
├── scripts/            installers and launchers
└── data/               the SQLite file (git-ignored)
```

## Documentation

| | |
| --- | --- |
| [architecture.md](docs/architecture.md) | layers, module boundaries, data flow |
| [trend-engine.md](docs/trend-engine.md) | the scoring model, in detail |
| [sources.md](docs/sources.md) | every adapter and the plugin contract |
| [database.md](docs/database.md) | schema and query patterns |
| [security.md](docs/security.md) | threat model and controls |
| [operations.md](docs/operations.md) | running it, tuning it, fixing it |
| [decisions.md](docs/decisions.md) | why the stack is what it is |
| [CONTRIBUTING.md](CONTRIBUTING.md) | conventions, and what a pull request needs |
| [SECURITY.md](SECURITY.md) | reporting a vulnerability, and what is in scope |
| [limitations.md](docs/limitations.md) | what this cannot do, and why |

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md)
describes the conventions that are unusual enough to be worth reading first —
zero runtime dependencies, never inventing data, and reporting what the data
cannot support.

- [Report a bug](https://github.com/TheServat/ViralRadar/issues/new?template=bug_report.yml)
- [The numbers look wrong](https://github.com/TheServat/ViralRadar/issues/new?template=wrong_numbers.yml)
- [Request a feature](https://github.com/TheServat/ViralRadar/issues/new?template=feature_request.yml)
- [Security policy](SECURITY.md) — please do not report vulnerabilities publicly

## What this is not

It is not a hyperscale system and does not pretend to be one. It is a
single-process program that comfortably handles a serious personal research
workload on one machine.

It also does not bypass anything: no CAPTCHA solving, no rate-limit evasion, no
authentication bypass, no IP rotation. A 429 is obeyed. A challenge page becomes
a **manual intervention** card that asks *you* to decide.

---

<div dir="rtl">

## راه‌اندازی سریع (فارسی)

این برنامه فقط روی کامپیوتر خودت اجرا می‌شود. نه سرور می‌خواهد، نه داکر، نه دیتابیس جدا.

```bash
npm install
cp .env.example .env
npm run build
npm start              # داشبورد: http://127.0.0.1:7788
```

روی ویندوز، `scripts\install.ps1` همهٔ این‌ها را انجام می‌دهد و یک شورتکات روی دسکتاپ می‌گذارد.

**پنج منبع بدون هیچ تنظیمی فوراً کار می‌کنند.** برای دیدن ویدیوهایی که واقعاً
بازدید می‌گیرند، یک کلید رایگان یوتیوب بگیر (دو دقیقه) و در صفحهٔ **تنظیمات**
واردش کن — همان‌جا لینک گرفتن هر کلید هست.

```bash
REGIONS=IR,US          # کشورهایی که برایشان محتوا می‌سازی
LANGUAGES=fa,en        # فقط یک ترجیح؛ فیلتر هر صفحه بر آن غلبه می‌کند
```

### نکتهٔ مهم

سیستم برای محاسبهٔ **سرعت رشد** به حداقل دو اندازه‌گیری نیاز دارد. بعد از اجرا
حدود ۴۰ دقیقه صبر کن تا ستون‌های «وایرال» و «در حال ظهور» پر شوند. اجرای اول
فقط یک عکس لحظه‌ای است.

### بهترین بخش برای کار تو

صفحهٔ **«امروز چه بسازیم»**: موضوع‌هایی که همزمان در چند پلتفرم بالا آمده‌اند،
با فیلتر زبان و کشور. کنار هر گزینهٔ «تعداد پلتفرم» نوشته چند موضوع در آن حالت
وجود دارد، تا اگر فیلتری خالی برگشت بدانی چرا.

اگر یک ماجرا همزمان در تلگرام، یوتیوب و خبرگزاری‌ها باشد، یعنی همان روز ارزش
ساختن دارد.

### رابط کاربری

کامل به سه زبان **فارسی، انگلیسی و عربی** با پشتیبانی راست‌به‌چپ. هر عددی که
می‌بینی برچسب صریح دارد و با نگه‌داشتن ماوس توضیحش را می‌گوید.

</div>
