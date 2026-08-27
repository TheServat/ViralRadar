# The trend engine

All of this lives in [`src/core/score.ts`](../src/core/score.ts) as pure
functions over a metric time series. `now` is a parameter, never `Date.now()`,
which is what lets [`tests/score.test.ts`](../tests/score.test.ts) describe four
hours of growth without waiting four hours.

## The two ideas

**1. Never compare raw numbers across platforms.** Every raw value is first
turned into a rank against that platform's own recent distribution. 700 points
on Hacker News and 900,000 views on YouTube can then sit in the same list
without either one dominating by unit alone.

**2. Growth behaviour beats size.** Acceleration carries the same weight as
velocity. That is what surfaces a 1,200-follower account at hour two instead of
the next morning, when it no longer matters.

## Velocity

Least-squares slope over the most recent points, in primary-metric units per
hour:

```
velocity = slope(hours, values)   over the last ≤5 observations
```

A single last-minus-previous delta was rejected: platform counters are noisy and
often update in steps, so one lagging refresh would read as a stall.

With fewer than two observations, velocity is `null` — **unknown**, not zero.
That distinction propagates all the way to the lifecycle state, where a single
observation can never produce more than `NEW`.

## Acceleration

The series is split in half and the two growth rates are compared:

```
ratio = (recent velocity + 1) / (max(earlier velocity, 0) + 1)
normalised = clamp(log₂(ratio) / 3, 0, 1)      2× → 0.33   4× → 0.67   8×+ → 1
```

This is what turns `2K → 8K → 35K → 180K` into a signal rather than just a large
number. The `+1` keeps the ratio defined when something starts from a standstill.

## Anomaly

Against the creator's own history, not the platform's:

```
creatorAnomaly = current / max(creator median, 1)
normalised     = clamp(log₁₀(ratio) / 2, 0, 1)     10× → 0.5   100× → 1
```

The baseline is computed from that creator's *other* items, with the item being
judged removed from the sample — a video must not be allowed to raise the bar it
is measured against.

With no creator baseline (fewer than three prior posts), this falls back to how
large the item is for the platform. It never silently becomes zero.

## Engagement

Only from metrics the platform actually exposes:

```
(likes + comments + shares + reactions) / views
```

falling back to the primary metric as the denominator when there is no view
count. Each source declares its own `engagementReference` — 8% is outstanding on
YouTube, while comments-per-upvote on Hacker News runs far higher — so the
normalisation is per platform, not universal.

If a platform exposes no interaction metric at all, this is `null` and is
excluded from the weighting rather than counted as zero.

## Cross-source

```
1 source → 0    2 → 0.33    3 → 0.67    4+ → 1
```

Corroboration comes from the clustering pass: how many distinct platforms carry
the same story.

## Putting it together

```
score = 100
      × weighted mean over the signals that are ACTUALLY AVAILABLE
      × ageGate         (0.35 once past MAX_AGE_HOURS)
      × evidenceGate    (0.55 + 0.45 × fraction of weight available)
```

Renormalising over available signals matters: Reddit exposes no view count, so
an engagement rate is often unknowable there, and treating that as a zero would
quietly punish an entire platform for what its API does not return.

The `evidenceGate` is the counterweight. An RSS headline exposes no metrics at
all; without it, such an item would ride freshness alone to the top of a chart
next to a video with a real view counter. There is a test for exactly that.

## Confidence

Deliberately unrelated to how big the numbers are:

```
0.30 × observations (÷6, capped)
0.20 × observation span (÷6h, capped)
0.20 × recency of the last observation
0.15 × signal coverage
0.15 × cross-source corroboration
      × source reliability (0.2–1.0)
```

Source reliability blends the plugin's declared trust with its observed
behaviour — a source failing a third of its runs cannot lend full confidence to
what it reports.

## Lifecycle

```
                 ┌──────── observations < 2 ────────┐
                 │                                   ▼
                 │                                 NEW
   ┌─────────────┴──────────────┐                   │
   │  accelerating              │                   │
   │  and not yet big  ────────────► EMERGING       │
   │                            │       │            │
   │  score ≥ 78, top 10% ─────────► VIRAL          │
   │  score ≥ 62, top 30% ─────────► HOT            │
   │  score ≥ 40 ──────────────────► RISING ◄───────┘
   └────────────────────────────┘
                 │
      growth stalls or halves
                 ▼
     PEAK ──► DECLINING ──► DEAD
```

`EMERGING` is checked **before** the size-based states, on purpose. Otherwise it
would just mean "slightly less viral" instead of *small but exploding*.

Two measurements with no change at all classify as `NEW`, not `DECLINING`.
Counters on several platforms only tick in steps, and calling a ten-minute-old
post "declining" would be plainly wrong.

## Time-of-day normalisation

Baselines are stored per source **and per hour of day** (`h00`–`h23`), and the
hourly bucket is used once it has at least 20 samples. A platform that is busier
at 20:00 should not produce a breakout every evening.

## Creator breakout

Fires only when all three hold:

- the creator has at least **5** prior observed items,
- the item is at least **5×** their median,
- and it clears their own **p90**.

The p90 condition stops a lucky spread of small numbers around a tiny median
from masquerading as a breakout.

## Clustering

No embeddings, no vector database, no model. tf-idf cosine similarity over
stemmed tokens, with a rare-term inverted index for blocking, plus SimHash for
outright reposts and Jaccard overlap to rescue short titles.

The suffix stripper in `core/text.ts` is not a linguistically correct stemmer
and does not try to be. Headlines about one event never agree on morphology —
"erupts", "eruption", "evacuated", "evacuations" — and without folding those
together the clustering sees four unrelated stories. It only has to make
variants collide. Non-Latin scripts are left alone.

Cluster growth is measured in **items joining per hour**, which is the one
growth number that means the same thing on every platform.

Labels come from the strongest keywords, mapped back from stems to the most
common surface form so they read as words a person actually wrote. An optional
AI plugin can rename them; nothing depends on it.

## Format analysis

A separate question from detection, sharing its normalisation: not *what* is
spreading but what *shape* of thing spreads. `core/format.ts` is pure and
takes the samples it is given.

Three rules keep it from being astrology with a chart:

**Rank, not score.** Every sample is its `source_percentile`, so an item is
only ever compared against its own platform's recent distribution.

**The baseline is the filtered population.** Computed from the samples, not
assumed to be 0.5. This matters more than it sounds: Persian items average the
32nd percentile of their own sources, so a fixed 50 would report every Persian
result as below average.

**An interval on every bucket.** Sample variance, Bessel-corrected, 95%
two-sided. A bucket is only a finding when `|lift| > margin` *and* it has at
least 25 items. A single-item bucket gets an infinite interval rather than a
zero one — which correctly makes it never significant instead of always.

Feature detection is Unicode-aware and deliberately lives in TypeScript rather
than SQL. SQLite cannot match an emoji: it is a surrogate pair the `LIKE`
misses and a character `LENGTH` miscounts. The SQL version of this analysis
found 1 emoji title in 939; the correct one finds 487. That failure is silent
and reads as a real result, which is why the whole extraction moved out of the
database.

The analysis cannot separate correlated causes — title length travels with
content type, which travels with platform. Per-source normalisation removes
most of the platform effect; nothing removes the rest. The interface says
"these did better" rather than "this made them do better", and that wording is
load-bearing rather than modest.

## Timing analysis

The same machinery as the format analysis — `core/lift.ts` holds the shared
statistics so both agree on what counts as a finding — with one extra step that
is not optional.

**Rank decays with age.** Measured on a live database: items 24-48 hours old
averaged the 39th percentile of their own sources, 48-96 hours old the 32nd,
4-10 days the 24th, older than that the 18th. That is a 32-point spread from
age alone, wider than any timing effect actually present.

Publish hours are not evenly distributed across those age bands — collection
started when it started — so aggregating raw rank by hour would largely report
which hours happen to hold the newest items. The result would look like advice
about posting and be a fact about the scheduler.

So every item is centred within its own age band before aggregation:

```text
adjusted = percentile − mean(percentile | age band) + mean(percentile)
```

Re-centred on the overall mean rather than on zero, so the numbers stay
readable. One consequence to be aware of: an adjusted value can fall outside
0-100, because it is a difference wearing a percentile's clothes. The interface
therefore shows lift for timing and suppresses the rank line, rather than
printing a negative percentile.

`ageSpread` — how much the correction was worth — is returned and displayed.
When the correction exceeds the finding, that is something the reader needs.

Two exclusions, both upstream in the query:

- **Estimated publish times.** The system estimates one when a source does not
  provide it. Using an estimate to analyse publish timing would be circular, so
  only `published_at_source IN ('api','feed')` qualifies.
- **Items younger than a day.** They have not had the same chance to prove
  themselves, so letting them compete would measure recency again.

Hours and weekdays come from `Intl` in the configured `TIMEZONE`, not from
offset arithmetic: offsets are not constant under daylight saving, and Iran,
India and Nepal sit on half- and quarter-hour offsets that integer division of
epoch seconds gets wrong.

## Creator baselines and backfill

`creatorBreakout` needs at least five prior samples before it will call
anything a breakout, because a ratio against the median of two numbers is not
evidence. Open discovery cannot supply them: it finds one item per channel.

The backfill job closes that gap by fetching a creator's recent posts through
whatever cheap route the source offers — for YouTube the public channel feed,
which costs no API quota at all. Ten uploads per creator, comfortably above the
five needed, and few enough that a batch of channels still fits one pricing
call.

Selection is by the best score anything of theirs reached, so a finite budget
goes where a breakout would actually matter. A creator is rested for a week
after being looked at, whether or not anything came back — a deleted or silent
channel must not be re-asked every run.

The samples land in `creator_history`, deliberately **not** in `content`:

- never scored, refreshed, clustered, or shown as a trend
- unioned into `creatorSamples()` alongside genuinely tracked items
- keyed `(creator_id, external_id)`, so re-fetching updates rather than
  inflating a baseline with duplicates of the same post

Measured effect on one database: 55 → 115 judgeable YouTube creators from a
single 60-creator run.

## Semantic merging

Optional, off by default, and additive by construction.

The lexical pass runs first and unchanged. Afterwards, if vectors are present,
clusters whose semantic centroids are close are merged. Operating on cluster
centroids rather than items makes it quadratic in the number of clusters — a
few thousand comparisons, not a few million — and means the pass can only ever
join what the lexical pass built, never split it.

Union-find, so merging is transitive: the same story in English, Persian and
Arabic becomes one topic rather than three pairs.

**The model is verified before it is trusted.** `ai/probe.ts` asks it, in each
configured language, to separate two sentences meaning the same thing from one
that does not, and requires a gap of at least 0.15. This is not defensive
decoration — it caught a real failure. A model can load, answer in
milliseconds, return well-formed vectors of the right dimension, and still have
no useful representation of a script, scoring *unrelated* Persian sentences at
0.98. It would have merged every Persian topic into one while looking perfectly
healthy from every angle except this one.

Measured separations, same probe, three models:

```text
paraphrase-multilingual  562 MB   en 0.87   fa 0.99   ← default
bge-m3                   1.2 GB   en 0.61   fa 0.62
qwen3-embedding:0.6b     639 MB   en 0.59   fa 0.57
```

Vectors are L2-normalised at write time, so every comparison is a dot product
rather than a cosine with a division. They are cached in `content_embeddings`
keyed by `(content_id, model)`: vectors from different models are not
comparable, and silently mixing them would corrupt every similarity in the
system without failing anywhere visible. Changing `EMBED_MODEL` clears the old
ones rather than blending them.

Embedding runs as its own scheduled job, never inside `analyze`. Analysis is
synchronous and must finish; an HTTP call to a local model is neither. So the
job writes vectors and analysis only reads what is already there — a stopped
Ollama cannot slow or fail an analyse run, it just means fewer merges.

## Reproducibility

Every stored score carries `scoring_version`. Change a weight or a formula, bump
`config.scoring.version`, and old scores remain interpretable as products of the
model that produced them. Weights themselves are configuration
(`W_VELOCITY`, `W_ACCELERATION`, …), not constants in code.
