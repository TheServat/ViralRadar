# Running it

## The desktop build

```bash
npm run package     # builds dist/viral-radar[.exe] for the platform you are on
```

One file, around 90 MB, most of which is the Node runtime. The radar's own code
and the whole dashboard come to under two.

Cross-compiling is not possible: a single executable is made by injecting the
app into the Node binary that is running, so each platform builds its own. The
release workflow does that on four runners: Linux, Windows, Apple silicon and
Intel Mac.

The Intel one is on borrowed time. `macos-13` was retired in December 2025 and
`macos-15-intel` replaces it until August 2027, after which GitHub hosts no
x86_64 macOS runner at all. Worth knowing because of *how* a retired label
fails: the job is never scheduled and simply queues for ever, so the release
never publishes and nothing anywhere reports an error.

What `viral-radar install` actually does, per platform:

| | start at login | where it installs |
| --- | --- | --- |
| Windows | a `.cmd` in the Startup folder | `%LOCALAPPDATA%\Programs\ViralRadar` |
| macOS | a launch agent in `~/Library/LaunchAgents` | `~/Applications/ViralRadar` |
| Linux | a systemd **user** unit | `~/.local/share/viral-radar` |

All three are per-user. Nothing needs administrator rights and nothing is
written outside your home directory.

On Linux, add `sudo loginctl enable-linger $USER` if you want it to keep
collecting while you are logged out.

Settings and the database live next to the installed executable, so the whole
thing can be moved by moving that folder.

## Cutting a release

Versions start at `0.0.1`. The tag is the trigger: pushing one that looks like
`v*` builds all four executables and drafts a release with them attached.

The number lives in three places — `package.json`, `apps/api/package.json` and
`apps/api/src/version.ts` — plus the version resource written into the Windows
executable, which is derived from the first. A test fails if the code and
`package.json` disagree, so they cannot drift apart unnoticed.

```bash
# 1. bump all three by hand, then make the lockfile agree
npm install --package-lock-only

# 2. the drift test is the check
npm test

# 3. after it is merged
git tag v0.0.3 && git push origin v0.0.3
```

**Bump first, tag second.** The tag has to point at a commit that already
carries the new number. Tagging `v0.0.2` on a commit whose `package.json` says
`0.0.1` builds perfectly happily and ships binaries that report the wrong
version — the drift test cannot catch it, because within that commit the two
files agree. Moving the tag afterwards is the fix, and re-running the workflow.

The draft then appears under Releases with four binaries on it, for you to read
and publish. To build without publishing anything — a dry run of the whole
matrix — start the Release workflow by hand from the Actions tab; the publish
step only runs for a tag.

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

## Deciding what to make

**Today's brief** answers what topic. **What works** answers what shape: title
length, content type, and what to put in the title, for whatever language,
country and platform you filter to.

Two controls change what it is allowed to say:

```text
Period            more days = more items = narrower intervals
Minimum certainty 0.4 by default; lower it to get an answer from a thin
                  database, at the cost of noisier scores underneath
```

The same page answers **when to post**, in the timezone you set:

```text
TIMEZONE=Asia/Tehran    an IANA name, not an offset
```

Check the zone printed above that chart. It defaults to the machine's own,
which on a VPS or a laptop set up in another country is quietly wrong and would
shift every hour on the page. Only items published over a day ago count, and
items whose publish time had to be guessed never count.

Read the whiskers, not just the bars. A bar whose whisker crosses the dashed
baseline is greyed out on purpose — it could be chance, and the page will not
put it in the headline list. If everything is grey, the honest reading is that
there is not enough data yet, not that nothing works.

**Click a bar to see what it is made of.** Every bar and every finding opens
the strongest items behind it — real posts, with thumbnails and links, ranked
the same way the chart ranks them. Use it before acting on a number: a bucket
of two hundred items that turns out to be one channel posting two hundred times
is a fact the lift alone will not tell you.

The dialog repeats the claim above the list, and says which of the two it is —
proven, or possibly chance. Examples under an unproven bar are a sample of the
group, not a set of things that worked.

**Thumbnail bars open as pictures.** They are shown large enough to judge, each
labelled with the measurement that put it in that band, and clicking one gives
the full size — the platform's larger copy where it has one, falling back to
the listed thumbnail. The other charts open as cards, and the toggle in the
dialog's title bar switches either way.

The images are loaded from the platform that hosts them, so they need the
browser to be able to reach that platform. Each one gives up after eight
seconds and offers a retry: a blocked host does not refuse the connection, it
drops the packets, so without a deadline the browser would show a spinner
forever and the page would look broken rather than the image looking
unreachable. A gallery full of **could not be loaded** means exactly that —
usually a VPN that is off — and the retry is there for the moment it comes
back.

The same applies on **Today's brief**: opening a topic leads with the best
posts carrying it, as cards rather than a list of titles, because the question
you open a topic with is what a post about it actually looks like.

## Discovery cost

YouTube's `search.list` costs 100 quota units a call; a channel feed costs
nothing. Channels that perform well are promoted onto a free watch list
automatically:

```bash
WATCH_TOP_CREATORS=60    # 0 switches it off and leaves search as the only path
WATCH_MIN_ITEMS=2
WATCH_MIN_SCORE=30
```

Measured effect: a run went from ~101 units for ~53 items to 102 units for
~100 items. A discovery run now takes about a minute rather than seconds,
because it reads sixty feeds politely at one request per second — at a 20
minute interval that is under 5% of the time.

Watch the `watched channels` log line for how many fresh uploads the free path
found, and `quotaSpent` in `sys_kv` for the day's real total.

`/api/v1/reports/terms` shows what each seed word has produced. It only counts
items over a day old — a word used an hour ago has found nothing that could
have taken off yet — so it is empty on a new database and fills in as evidence
accumulates. Words with 40+ finds and no movers are skipped automatically, and
retried every fifth run in case that changes.

## Breakouts need a baseline

A breakout is "far above what this account normally gets", which the system can
only say once it knows the normal. A background job learns it:

```bash
BACKFILL_PER_RUN=60          # creators per run; 0 switches it off
BACKFILL_INTERVAL_MIN=30
```

For YouTube this costs no API quota for the channel listing and about one unit
per fifty videos to price them. Coverage climbs on its own; the log line
`creator history` reports it after each run.

If breakouts stay at zero, this is usually why — not a lack of breakouts, but a
lack of baselines to measure them against.

## Matching what you make

```bash
INTERESTS=a sentence or two describing your channel, in any language
```

Needs `EMBED_MODEL`, and costs no extra model call — the description is embedded
once and compared against vectors the clustering already built.

`/api/v1/system/interests` reports whether it is on and how much of the corpus
has been scored. Coverage fills in a few thousand items per embedding run; the
first run after writing a description scores the whole backlog, because every
item already has a vector and none would otherwise pass through.

**Where it shows up.** The dashboard and **Today's brief** both lead with a
*For your channel* section once a description is set. Both are filtered by
closeness and ranked by score — never sorted by closeness, and the difference
matters more than it sounds. On a real database the ten items closest to a
channel description scored between 2.7 and 29, because the thing that most
resembles a description of comedy clips is a hashtag-stuffed clip nobody is
watching. What is worth making is the intersection: close to what you make
*and* actually moving.

The dashboard uses a fixed bar of 50%. The brief lets you move it between 40%,
50% and 60% and shows how many items clear each, so an empty list says "nothing
matched today" rather than looking broken. A fixed bar is deliberate: a
relative one — the closest fifth of whatever is there — would always return
something and would claim a match on a day when nothing matched.

Rewording the description clears every stored match and rescores — a match
against a definition that no longer exists is worse than no match.

## Grouping across languages

Off unless you switch it on, and it needs [Ollama](https://ollama.com):

```bash
ollama pull paraphrase-multilingual     # 562 MB
EMBED_MODEL=paraphrase-multilingual
```

The **System** page then shows whether the model passed its own check, its
separation score per language, and how much of the corpus has a vector.
Coverage fills in on its own at `EMBED_MAX_PER_RUN` items every
`EMBED_INTERVAL_MIN` minutes; items without a vector still group by wording.

If the page says **Refused**, the model failed to tell related text from
unrelated text in one of your languages. Do not lower the bar — try another
model, or clear `EMBED_MODEL`. A model that scores everything alike merges
every topic into one.

## Being told instead of looking

Set `NOTIFY_CHANNELS=telegram` (and the two Telegram keys) or
`NOTIFY_CHANNELS=webhook` with a URL, and a job runs every
`NOTIFY_INTERVAL_MIN` minutes looking for anything worth interrupting you for.
With `NOTIFY_CHANNELS` empty the job is never registered at all.

```bash
NOTIFY_MIN_SCORE=65        # raise it if too much arrives, lower it if too little
NOTIFY_MIN_CONFIDENCE=0.5  # raise it if early items turn out to be false alarms
NOTIFY_QUIET_HOURS=23,8    # held until 8am, then delivered
```

Use **Send a test notification** on the Settings page after changing any of it.
If a channel is switched on but missing its token, Settings says so — otherwise
it would send nothing and look like it was working.

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

## Pace

The analysis pass runs every `ANALYZE_INTERVAL_MIN` minutes and takes about
14 seconds on a database of ~7,000 items and ~80,000 measurements. If that
figure climbs towards the interval itself, profile before tuning the interval:
the last time it did, one badly-shaped query accounted for nearly all of it.

## Asking the radar questions

`.mcp.json` registers the radar as an MCP server for this directory, so Claude
Code picks it up automatically. To check it by hand:

```bash
node apps/api/src/main.ts mcp
```

It then waits on stdin for JSON-RPC. The radar itself must be running — the
tools read through the HTTP API, and will tell you to start it if it is not.

One rule if you extend it: **nothing may write to stdout except the protocol.**
That is why the `mcp` command forces `LOG_LEVEL=silent`; a single stray log line
corrupts the stream and the client reports a parse error rather than your
message.

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
GET  /api/v1/reports/formats?…              what shape of content wins
GET  /api/v1/reports/timing?…               what hour to post, age-adjusted
GET  /api/v1/reports/terms?source=youtube   what each seed word bought
GET  /api/v1/reports/examples?…             the items behind one bar
GET  /api/v1/export?format=csv|json&…       the current list, as a file
GET  /api/v1/missed?hours=168               what peaked while you were away
POST /api/v1/content/:id/archive            mark as dealt with
DELETE /api/v1/content/:id/archive          undo that
GET  /api/v1/facets                         languages, countries and sources present
GET  /api/v1/sources                        capabilities + health
POST /api/v1/sources/:id/run
GET  /api/v1/system/health | interventions | events
GET  /api/v1/system/settings/status         whether a settings password is set
GET  /api/v1/system/settings                editable keys; secrets never returned
POST /api/v1/system/settings                writes .env, whitelisted keys only
GET  /api/v1/system/notify                  channels configured, and what is filtered
GET  /api/v1/system/embedding               semantic grouping: model, verdict, coverage
POST /api/v1/system/notify/test             one message, to prove the setup works
POST /api/v1/system/collect | analyze
POST /api/v1/system/interventions/:id/resolve
GET  /api/v1/stream                         SSE
```

`/clusters` accepts the same `lang`, `country` and `source` filters as
`/trends`, plus `minSources` — a topic matches when a post *inside it* matches,
so "Persian topics" means topics containing Persian posts.

Filter parameters, all optional: `source`, `lang`, `country`, `type`, `state`,
`minScore`, `maxAgeHours`, `creator`, `hashtag`, `q`, `limit`, `offset`, `sort`
(`score` | `acceleration` | `velocity` | `recent` | `creator_anomaly`), and
`archived` (`hide`, the default | `only` | `include`).

`/export` takes those same filters, so the file matches the view it came
from. It is a plain link rather than a fetch, so the browser handles the
download and keeps the filename.

`/reports/examples` takes `dimension` (`format`, the default | `timing` |
`thumbnail`), `group`, `bucket` and `limit` (default 6, max 24), plus whichever
filters that dimension's own endpoint takes — pass the same ones the chart was
drawn with or the examples will come from a different population. It answers
`n` for the whole bucket and `items` for the strongest few, ranked by the
measure that dimension's chart uses.

`/reports/formats` takes `lang`, `country`, `source`, `type`, plus `hours`
(default 336) and `minConfidence` (default 0.4). `/reports/timing` takes the
same, with `hours` defaulting to 720 and `settleHours` (default 24) setting how
old an item must be to count. Like every other endpoint it
honours the `LANGUAGES` preference unless `lang` is given; `lang=all` clears it.

Set `API_TOKEN` to require `X-Radar-Token`, `Authorization: Bearer`, or `?token=`.

`SETTINGS_PASSWORD`, if set, additionally guards the settings routes and
`/system/notify/test` via an `X-Settings-Password` header. Five failures from
one address answer `429` with `Retry-After` for fifteen minutes.

## Backup

```bash
sqlite3 data/radar.db ".backup data/backup.db"   # or just copy the file when stopped
```

One file. Copy it, and you have everything.
