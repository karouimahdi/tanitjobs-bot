# TanitJobs bot

A personal job-alert bot: sweep **TanitJobs** on a schedule, notice what is
genuinely new, let a small model normalize the messy French/Arabic/English
descriptions, score each posting against your own profile, and ping you on
**Telegram** only for the ones worth opening.

Single user, single source, no hardware to own. The collector runs as a
scheduled **Cloud Run Job** — not a Raspberry Pi, not a VPS you SSH into at
2am. See `architecture.md` for the full reasoning; this file is the
day-to-day version.

```
        ┌───────────────────────────────────────────────┐
        │ Cloud Scheduler — cron, jittered, ≥15 min       │
        └────────────────────────┬────────────────────────┘
                                 │ invokes
        ┌────────────────────────▼────────────────────────┐
        │ Cloud Run Job (ephemeral, one execution/cycle)    │
        │                                                   │
        │  PHASE 1 · sweep list pages     ids only          │
        │    robots check → throttle → render → /job/<id>   │
        │                        │ ids                      │
        │  PHASE 2 · diff against watermark doc             │
        │    "which of these are unknown?" — 1 Firestore read│
        │                        │ new ids only             │
        │  PHASE 3 · fetch + parse detail                    │
        │    JSON-LD first, CSS fallback                     │
        │                        │ JobDetail                 │
        │  create() into jobs/tanitjobs_<id>  →  new? done.  │
        │                        │                           │
        │       regex prefilter │ ~90% dropped for free      │
        │                        ▼                           │
        │  classify() · Anthropic + structured output        │
        │    cached by content_hash                          │
        │                        │ Classification             │
        │  score(job, classification, profile) → 0..100      │
        │    pure, no IO, re-runnable                         │
        │                        │ ≥ NOTIFY_MIN_SCORE          │
        │  claim outbox doc (create, unique) → send → sent    │
        └───────────────────────────────────────────────────┘
```

---

## The decisions that actually matter

Most of this project is unremarkable plumbing. These parts are where a job
watcher either works for a year or dies in a week.

**1. Identity is the numeric id, never the URL.**
TanitJobs postings live at `/job/487774`. Slugs and query params change; the
id doesn't. The Firestore doc ID *is* `tanitjobs_487774`. Key on the URL and
your "new job" detector fires on the same posting twice after any redesign.

**2. Two-phase collection.**
List pages give ids. Only ids the watermark doc doesn't already know earn a
detail fetch. That's roughly 3 requests per cycle in steady state instead of
300 — better for TanitJobs, and the single biggest thing keeping you off a
rate limit in the first place. Most scrapers get blocked because they're
loud, not because they were detected as bots.

**3. New-job detection is a write, not a read.**
`jobs/tanitjobs_<id>` inserted with `create()`. Firestore throws
`ALREADY_EXISTS` if the doc is already there — that exception *is* the "have
I seen this?" check. Atomic, one write, zero reads, no race between
overlapping cycles. The same pattern claims an outbox row before sending: a
`sent` boolean written *after* the send is how you get 200 duplicate pings at
4am when the process restarts mid-delivery.

**4. Classification is cached by content hash, scoring is not cached at all.**
`classify()` is keyed on `sha256(title + company + location + description)`,
so re-crawling unchanged text costs nothing. `score()` is a pure function of
your preferences in `config/profile` — change your mind about what you want,
re-score the entire collection in seconds, pay nothing. Keeping "what the job
is" separate from "what I want" is what lets you iterate on your filters
daily instead of re-paying for every preference tweak.

**5. A challenge is a stop signal, not an obstacle.**
`src/browser/challenge.ts` detects interstitials and 403/429/503, then trips
an exponential circuit breaker (5 min → 6 h) and messages you on Telegram.
There is deliberately no CAPTCHA solving, no stealth plugin, no proxy
rotation in this codebase, and you should not add any — it's against the
site's terms, and a bot that grinds against a WAF converts a soft temporary
block into a hard permanent ban on your account, which ends the project. If
you keep getting challenged, slow down, or email TanitJobs and ask for a
feed. Small national boards say yes to that more often than you'd expect.

---

## Setup

```bash
cp .env.example .env             # fill in ANTHROPIC_API_KEY + Telegram + GCP
npm install
npx playwright install chromium
npm run emulate                  # firebase emulators, in another terminal

npm run probe                    # ← do this before touching any selector
npm run once                     # one full cycle, verbose, against the emulator
```

Going to production means deploying the Cloud Run Job + Cloud Scheduler
trigger (`npm run deploy:job`) instead of leaving a process running — see
`architecture.md` §1 for why there's no `npm start`-forever command here.

### The probe step is not optional

`npm run probe` renders a listing page and reports: the HTTP status and
whether a `cf-ray` header is even present, whether the board emits schema.org
`JobPosting` JSON-LD, every JSON response the page fetched, and the shape of
the job links. It writes `raw/probe.html` and `raw/probe.png`.

Read that output before writing selectors. Three things it often reveals:

- **JSON-LD is present.** Then `parseDetail` is nearly done — job boards emit
  it for Google Jobs indexing and they maintain it far more carefully than
  their CSS. Selectors become a fallback rather than the plan.
- **A JSON endpoint is doing the work.** If the listing hydrates from
  something like `/api/jobs?page=1`, you may not need a browser at all for
  phase 1 — a plain `fetch` with your normal User-Agent is lighter on their
  server and on yours. Still throttle it.
- **No `cf-ray` on the routes you need.** The anti-bot layer is often only on
  login and search-POST, not on public listing pages. Worth knowing before
  you architect around a problem you don't have.

### Telegram in two minutes

Message `@BotFather` → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
Then message your new bot once, open
`https://api.telegram.org/bot<TOKEN>/getUpdates`, and copy `message.chat.id`
into `TELEGRAM_CHAT_ID`. Run `npm run tg:check` to confirm a test message
arrives.

---

## Why Firestore, and what it costs

The core operation here is *"of these ~40 ids, which have I never seen?"* — a
set-difference question Firestore has no native primitive for. The naive
translation (40 `get()` calls per cycle, 96 cycles a day) is thousands of
reads a day to learn almost nothing. Two Firestore-native mechanisms replace
it instead: deterministic doc IDs + `create()` for the dedup check itself,
and a single `sources/tanitjobs/state/watermark` doc read once per cycle to
know which ids are even worth checking. Steady state lands around 3 reads and
2 writes per cycle — inside the free tier, indefinitely.

What you give up: no aggregate queries (`stats/daily_*` counters, written at
insert time, cover the questions you'd actually ask), and no full-text search
(`stack` is denormalized as a map for equality filters only). Full rationale,
including the reconciliation sweep that self-heals what the watermark misses,
is in `architecture.md` §2.

---

## Adding a second board

Deliberately not done yet, and not a near-term goal — see `architecture.md`
§6. This is a single-source tool by design until TanitJobs itself has run
cleanly for a month; building a second adapter on an unproven pipeline is
speculative work. When it does happen, it's meant to be a one-file change:
implement `JobSource`, add it to the source array, and dedup / AI / scoring /
notification / backoff / observability all come along unchanged, since none
of them learn which board a row came from beyond its key.

---

## Operating it

Firestore doesn't do ad-hoc analytics, so "is it healthy" and "what's it
finding" are answered from the collections that were written *for* that
purpose, not by scanning `jobs`:

- **Is it healthy, or has it quietly found nothing for a week?** Read
  `runs/{autoId}` docs, newest first, in the Firestore console — each one has
  the cycle's outcome, ids swept, and any detail-parse failures. Zero new
  jobs for 48h is the alert threshold (see `architecture.md` §5).
- **What's it actually finding?** `stats/daily_{YYYYMMDD}` has the
  seen/new/classified/scored/sent counters per day, incremented as the
  pipeline runs — no query needed, just read the doc.
- **What has the AI layer cost you?** `classifications/` docs carry token
  counts per cached classification; since it's cached by content hash, the
  count of docs is also the count of Anthropic calls you've ever made for
  this board.

Tune `NOTIFY_MIN_SCORE` from real data rather than intuition: run for a week
with it low (or sending disabled), look at the score distribution you
actually got, then raise it. Everything is stored regardless of whether it
pinged you, so adjusting the bar retroactively is just reading a collection,
never a re-crawl.

---

## Legal / ToS

Read TanitJobs' terms of use before you run this against them, and keep
`RESPECT_ROBOTS=true`. Personal-use monitoring at ~3 requests every 15
minutes, identified by an honest User-Agent, is about as defensible as
scraping gets — but it's still their site, their call. The circuit breaker
and the honest User-Agent exist so that if they ever want to stop you, they
trivially can.
