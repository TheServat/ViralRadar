# Known limitations

Stated plainly, because a tool that overstates what it knows is worse than one
that knows less.

## Cold start

Growth cannot be measured from one observation. The first collection pass
produces a snapshot; every item is `NEW` and scores cluster around 40. Velocity
appears after the second pass, acceleration after the third.

Per-source percentile baselines need a few hours before they are meaningful.
Per-hour-of-day baselines need at least 20 samples per hour, so about a day.
Creator baselines need at least three prior posts from that account, and a
breakout needs five.

Nothing is broken during this period. There is simply not enough evidence yet,
and `confidence` says so.

## Coverage

**TikTok, X and Instagram are not covered.** They are the three platforms where
short-form virality is most visible, and none of them offers a lawful, free,
unattended read path. They appear in the dashboard with the exact reason and the
exact step that would change it. See [sources.md](sources.md).

The practical consequence: this system sees what is spreading on YouTube,
Reddit, Telegram, Mastodon, Bluesky, Imgur, Twitch, GitHub, Hacker News, in the
news, on the music, film and game charts, in Wikipedia's reading habits and in
Google search. That is a substantial view of the internet, but it is not all of
it, and **short-form vertical video specifically remains underrepresented**
relative to its real importance, because the three platforms that dominate it
are the three that cannot be read.

**Reddit needs credentials on most networks.** Anonymous public JSON returns 403
from most consumer and datacenter IP ranges. The fix is a free script app and
two minutes.

**YouTube publishes no trending chart for every country.** There are 111
supported regions and Iran is not one of them, so `regionCode=IR` is a hard 400
rather than an empty list. Open search does accept those region codes, so those
audiences are still covered — but through a different, quota-limited path, and
without a ready-made "what is trending here" ranking to lean on.

## Metric quality

Not all sources are equal, and reliability scores reflect that:

| Source | Reliability | Why |
| --- | --- | --- |
| YouTube | 1.00 | exact counters from the official API |
| GitHub, Twitch | 0.95 | exact counters from the official API |
| Hacker News | 0.95 | exact counters from the official API |
| Imgur, Reddit, Product Hunt | 0.90 | exact, but rate limits interrupt series |
| Wikipedia | 0.90 | exact, but daily totals published in arrears |
| Mastodon, Bluesky, TMDB | 0.85 | exact counts; TMDB's figure is relative, not a count |
| Telegram, Charts | 0.80 | views rounded to 3 significant figures; charts give rank |
| Google Trends | 0.75 | traffic is a band ("20K+"), not a count |
| Google News | 0.70 | no metrics at all; corroboration only |
| RSS, Giphy | 0.60 | no metrics at all, or rank only |

Google Trends bands mean its velocity is coarse: a topic can sit at "20K+" for
hours and then jump. Telegram's rounding has the same effect at small numbers.

**Rank-based sources cannot tell you size.** Spotify, Apple, Giphy and Steam's
ordering give a position, not a count. Rank movement is a real signal, but "how
many people" is a question these sources simply do not answer, and the system
does not pretend otherwise — the number stored is a rank score and nothing else.

**Chart sources move slowly.** A weekly music chart changes once a week, so its
velocity is zero for six days out of seven. That is accurate rather than broken,
but it means those items rarely reach the top of a ranking built around growth.

## Detection

**Cross-source clusters lag by one analysis pass** for a story appearing on a
new platform for the first time. Items that gain corroboration are re-scored
immediately within the same pass, so this only affects the very first item of a
brand-new cluster.

**Clustering is lexical, not semantic.** Two posts about the same event that
share no vocabulary — different languages, or one describing what the other
shows — will not be grouped. The optional embedding seam exists; nothing
implements it yet.

**The stemmer is English-only.** Latin-script suffix stripping helps English
substantially, other European languages somewhat, and does nothing for Persian,
Arabic, CJK or Cyrillic. Clustering in those languages relies on exact token
overlap and SimHash, which is weaker.

**Language detection is heuristic.** Script detection plus exclusive-stopword
profiling.
It is reliable for the scripts and the ten Latin languages it knows, and it
returns `null` rather than guessing when it cannot tell. Short titles — under
about eight characters of real text — are frequently unclassifiable.

**Country is mostly unknown, and says so.** Only Google Trends gives a real
country. YouTube's region parameter says where a video is *trending*, not where
it is from, and is stored at confidence 0.5. The language fallback covers a
short list of effectively single-country languages at confidence 0.35. Anything
else is `NULL`. Do not filter by country and expect completeness.

## Deduplication

Text near-duplicates are caught by SimHash and token overlap. **Image and video
perceptual hashing is not implemented**: it would require downloading and
decoding media from every source, which multiplies bandwidth, storage and
processing for a personal instance.

The consequence: the same video reuploaded with a completely different title
across two platforms may not be recognised as one item. The same *story* usually
still clusters, because titles rarely diverge that far.

## Scale

Comfortable to roughly a million content rows and a few million metric snapshots
on ordinary hardware — months of continuous collection at the default settings.
Beyond that, the analysis pass slows because it scores every item in the window
each time.

This is deliberate. A design that handled a hundred times more data would cost
more to run, understand and repair, every day, to serve a workload that will not
arrive.

## Scheduling

Jobs are timer-driven and run one at a time. A slow discovery pass delays the
analysis behind it. In practice a full cycle takes tens of seconds and the
analysis takes milliseconds, so this has never mattered — but it is a real
serialisation, not a queue with parallelism.

There is also no persistence of scheduler state: on restart, timers begin again
from zero. `RUN_ON_START=true` compensates.

## Thumbnails are measured with their padding

YouTube serves every thumbnail at 320x180, so a 9:16 short arrives with black
bars down both sides and those bars are measured along with the picture. The
comparison is corrected for it — every measure is centred within its own
content type, and the spread removed is shown above the charts — but the
absolute numbers are not. A short reported as `dim` may be a bright picture in
a dark frame.

Fixing the numbers means detecting and cropping the bars before measuring, and
re-measuring every thumbnail already stored: a corpus half measured one way and
half the other would be worse than one consistently biased, because the bands
would stop meaning the same thing across it.

## Things this deliberately does not do

- No CAPTCHA solving, authentication bypass, or rate-limit evasion.
- No IP rotation. A 429 is a cooldown, not a routing problem.
- No prediction. It reports what is happening, not what will.
- No sentiment, toxicity or quality judgement. Growth is measured; worth is not.
- No account actions. It reads public data and nothing else.
