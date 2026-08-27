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

## Reproducibility

Every stored score carries `scoring_version`. Change a weight or a formula, bump
`config.scoring.version`, and old scores remain interpretable as products of the
model that produced them. Weights themselves are configuration
(`W_VELOCITY`, `W_ACCELERATION`, …), not constants in code.
