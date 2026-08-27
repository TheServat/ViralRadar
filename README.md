# Trend Radar

A local program that answers one question, without you typing a topic:

> **What is exploding on the internet right now — and what should I make today?**

It watches public sources, measures how fast each post is growing, compares that
growth with what is *normal for that platform and that creator*, groups the same
story across platforms, and ranks what it finds. No topic input. No AI required.

```
┌─ 🔥 VIRAL NOW ─────────┐ ┌─ 🚨 BREAKING OUT ──────┐ ┌─ 🌎 CROSS-PLATFORM ────┐
│ big and still growing  │ │ 240× this creator's    │ │ the same story on 4    │
│                        │ │ normal reach           │ │ platforms in 2h 17m    │
└────────────────────────┘ └────────────────────────┘ └────────────────────────┘
```

---

## راه‌اندازی سریع (فارسی)

این برنامه فقط روی سیستم خودت اجرا می‌شود. نه سرور می‌خواهد، نه داکر، نه دیتابیس جدا.

```bash
npm install          # فقط ابزار توسعه؛ خود برنامه هیچ وابستگی‌ای ندارد
cp .env.example .env # همه مقادیر پیش‌فرض کار می‌کنند
npm start            # داشبورد: http://127.0.0.1:7788
```

بدون هیچ کلیدی، سه منبع فوراً کار می‌کنند: **Google Trends** (مردم الان دنبال چه
می‌گردند)، **Hacker News** و **RSS**.

برای دیدن ویدیوهایی که واقعاً بازدید می‌گیرند، یک کلید رایگان یوتیوب بگیر
(دو دقیقه) و در `.env` بگذار:

```
YOUTUBE_API_KEY=...
REGIONS=US,IR          # کشورهایی که برایشان محتوا می‌سازی
```

نکته مهم: سیستم برای محاسبهٔ **سرعت رشد** به حداقل دو اندازه‌گیری نیاز دارد.
پس بعد از اجرا، حدود ۲۰ تا ۳۰ دقیقه صبر کن تا ستون‌های «Viral / Emerging» پر شوند.
اجرای اول فقط عکس لحظه‌ای می‌گیرد.

بهترین بخش برای کار تو: **Cross-platform topics**. اگر یک موضوع همزمان در چند
پلتفرم بالا آمده باشد، یعنی همان روز ارزش ساختن دارد.

---

## Quick start

```bash
npm install            # dev tooling only — the app itself has zero runtime dependencies
cp .env.example .env   # every default works as-is
npm start              # dashboard on http://127.0.0.1:7788
```

Requires **Node.js 24 or newer** and nothing else. No database server, no Docker,
no build step, no npm packages at runtime.

Give it two collection cycles (~20–40 minutes) before judging the results:
growth cannot be measured from a single observation, and the first pass is only
a snapshot.

## What it actually measures

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

## Sources

| Source | Needs | Gives | Notes |
| --- | --- | --- | --- |
| **Google Trends** | nothing | search topics + traffic band | what people are *searching* today, per country |
| **Hacker News** | nothing | points, comments | official API; `top` and `new` both watched |
| **RSS / Atom** | nothing | headlines only | no metrics — used for corroboration |
| **YouTube** | free API key (2 min) | **real view counts**, likes, comments, subscriber counts | open discovery: any channel, nothing named in advance |
| **Reddit** | free "script" app | upvotes, comments, crossposts | anonymous JSON is blocked on many networks |
| **Telegram** | channel list | **per-post view counts** | public channel previews only |
| TikTok / X / Instagram | — | — | registered, and honest about why they cannot run |

TikTok, X and Instagram appear in the dashboard with the exact reason they are
unavailable and the exact step that would change that. They return no data
rather than fake data. See [docs/sources.md](docs/sources.md).

## Commands

```bash
npm start                    # dashboard + background scheduler
node src/main.ts collect     # one discovery pass, all sources
node src/main.ts collect youtube
node src/main.ts refresh HOT # re-read metrics for fast movers
node src/main.ts analyze     # recompute scores, clusters, baselines
node src/main.ts top 20      # current leaderboard in the terminal
node src/main.ts sources     # what is configured and what is not
node src/main.ts doctor      # config + database + connectivity check
node src/main.ts cleanup     # apply the retention policy now
node src/main.ts reclassify  # re-run language/keyword detection over stored items
npm test                     # 102 tests
npm run typecheck
```

## Configuration

Everything lives in `.env`; see [.env.example](.env.example) for the annotated
list. The settings that matter most:

```bash
REGIONS=US,IR          # which countries Google Trends and YouTube are asked about
LANGUAGES=             # empty = keep every language (the default)
YOUTUBE_API_KEY=       # unlocks real view counts
HOT_REFRESH_MIN=5      # how often fast movers are re-measured
MAX_AGE_HOURS=72       # anything older stops counting as "now"
NETWORK_MODE=DIRECT    # or HTTP_PROXY with PROXY_URL
AI_PROVIDER=           # empty = AI_DISABLED, which is fully supported
```

Filters — language, country, platform, type, state, minimum score, creator,
hashtag, free text — are applied **after** detection, never before. The default
is all sources, all languages, all countries, all topics.

## Documentation

| | |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | layers, module boundaries, data flow |
| [docs/trend-engine.md](docs/trend-engine.md) | the scoring model, in detail |
| [docs/sources.md](docs/sources.md) | every adapter and the plugin contract |
| [docs/database.md](docs/database.md) | schema and query patterns |
| [docs/security.md](docs/security.md) | threat model and controls |
| [docs/operations.md](docs/operations.md) | running it, tuning it, fixing it |
| [docs/decisions.md](docs/decisions.md) | architecture decision records |
| [docs/limitations.md](docs/limitations.md) | what this cannot do, and why |

## What this is not

It is not a hyperscale system, and it does not pretend to be one. It is a
single-process program that comfortably handles a serious personal research
workload on one machine.

It also does not bypass anything: no CAPTCHA solving, no rate-limit evasion, no
authentication bypass, no IP rotation. A 429 is obeyed. A challenge page becomes
a **manual intervention** card that asks *you* to decide. See
[docs/security.md](docs/security.md).
