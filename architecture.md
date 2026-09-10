# Architecture

TanitJobs → GitHub Actions → Firestore → Anthropic → Telegram.

The whole system is a change detector wearing a job-board costume. Everything
interesting is in *how it decides something is new* and *how it is allowed to
tell you*.

---

## 1. Topology

The awkward fact up front: **Playwright and "no server to maintain" pull in
different directions.** A browser needs somewhere to run, and the obvious
answer — an always-on box you own — is itself an ongoing maintenance cost
(patching, disk space, "why did the process die at 3am") for a single-user
tool. Given the choice, don't own hardware for this.

The resolution went through two revisions. The first used a **Cloud Run
Job** on a Cloud Scheduler trigger — that solved the hardware problem but
turned out to have a harder gate behind it: Cloud Run, Cloud Scheduler, and
Artifact Registry are all exclusive to GCP's Blaze (pay-as-you-go) plan.
`gcloud services enable` fails on them with `FAILED_PRECONDITION` the moment
no billing account is linked — not a soft limit, not something that degrades
gracefully, a hard block regardless of how little you'd actually use. Given
the choice to stay on Firebase's free Spark plan (Firestore included), the
collector's *compute* moved off GCP entirely. Firestore itself stays on
Firebase/GCP throughout — Spark covers it completely at this volume; only
the scheduler and the machine running Playwright moved:

```
   ┌──────────────────────────────────────────────────────────────┐
   │ GITHUB ACTIONS — scheduled workflow, cron-triggered, ≥15 min  │
   │ .github/workflows/collect.yml, ubuntu-latest runner            │
   │                                                                │
   │   collector ── Playwright ── storageState ⇄ Firebase Storage  │
   │   parser · prefilter · classifier · scorer · Telegram send    │
   └───────────────────────────┬──────────────────────────────────┘
                               │ Firestore SDK (service account,
                               │ via GitHub Actions encrypted secret)
                               ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ FIRESTORE   jobs · classifications · outbox · state · stats  │
   │ (Firebase Spark plan — free)                                  │
   └──────────────────────────────────────────────────────────────┘
                               │
                               ▼
                          TELEGRAM BOT API
                  (direct call — no public webhook needed for v1)
```

What this costs, honestly, versus both earlier options:

- **A well-known, publicly-documented CI-runner egress IP.** This is arguably
  worse for WAF risk than the Cloud Run revision's Google datacenter IP —
  GitHub Actions IP ranges are extensively fingerprinted precisely because
  they're such a common scraping/bot source. No mitigation exists for this
  short of a self-hosted runner, which reintroduces the always-on box this
  whole design avoids. The response if TanitJobs starts challenging stays
  the same as ever: slow down, or ask for feed access — never stealth.
- **No persistent disk, same as Cloud Run Jobs.** Each workflow run is a
  fresh VM. Playwright `storageState` (cookies + localStorage, not a full
  profile directory) round-trips through a small object in **Firebase
  Storage** — Spark-plan free, and reachable with the same service account
  already used for Firestore.
- **Best-effort scheduling.** GitHub's `schedule: cron` trigger is
  documented as best-effort and can slip by several minutes during platform
  load, especially for public repos. Treat that slack as free jitter on top
  of the jitter already built into the collector, not a bug to fight.
- **Genuinely $0, not "should stay near $0."** Actions minutes are free on a
  public repo with no metered edge the way Blaze's pay-as-you-go billing has
  one — nothing to accidentally exceed.

Telegram delivery (§4) needs no public HTTPS endpoint, unlike the WhatsApp
webhook an earlier revision of this design required — so there is no
publicly-reachable service anywhere in this picture. If one becomes necessary
later (inbound Telegram commands), it is small, separate, and never folded
into the scheduled workflow.

---

## 2. Change detection on Firestore

Postgres would answer *"of these 40 ids, which are unknown?"* with one indexed
`= ANY(...)`. Firestore has no set-difference primitive, and the naive
translation — 40 `get()` calls per cycle, 96 cycles a day — is 3,840 reads a day
to learn almost nothing.

Two Firestore-native mechanisms replace it, and they are better than what they
replace:

### 2a. Deterministic document IDs

`jobs/tanitjobs_487774`. Insert with `create()`, not `set()`. `create()` fails
with `ALREADY_EXISTS` when the doc is there — so the write **is** the novelty
check. Atomic, one operation, no read, no race between two cycles overlapping.

This is strictly better than the SQL version, which needs a `RETURNING xmax = 0`
trick to tell insert from update.

### 2b. The watermark document

`sources/tanitjobs/state/watermark`:

```jsonc
{
  "maxId": 487774,
  "recentIds": [487774, 487770, 487768, /* ... last ~500 */],
  "updatedAt": "..."
}
```

One read at the start of a cycle tells you which of the ~40 ids on the listing
page are worth a detail fetch. Steady state:

| Operation | Count per cycle |
|---|---|
| Read watermark | 1 |
| Read source config | 1 |
| Read profile (cached in memory, refreshed hourly) | ~0 |
| Write watermark | 1 |
| Write new job docs | 0–3 typical |

Roughly 3 reads and 2 writes per cycle. At 96 cycles a day that is far inside
the free tier and stays there forever.

**Why `recentIds` and not just `maxId`:** ids are assigned at submission but
appear after moderation, so a lower id can surface *after* a higher one. A
watermark alone silently drops those. The recent-id set is the safety net.

**Reconciliation:** once a day, ignore the watermark and check every id on page
one with `create()`. Cheap, and it self-heals anything the fast path missed.

### 2c. What you give up

Be honest about this rather than discovering it in month three:

- **No aggregate queries.** "Postings per company per month", "score
  distribution over time", "is the bot healthy or is the market dead" — Firestore
  will not answer these without scanning. Mitigation: increment
  `stats/daily_{YYYYMMDD}` counters at write time. It costs one write you were
  already making and covers 90% of what you would actually ask.
- **No full-text search.** Denormalize `stack` into a map field
  (`{react: true, node: true}`) so equality filters work. Anything richer needs
  an external index; for one user, do not.
- **Composite indexes must be declared up front** in `firestore.indexes.json`.
  A query that works against the emulator can fail in production.

None of this is fatal for a single-user tool. All of it is annoying if you learn
it late.

---

## 3. The AI layer

Two independent decisions that people usually collapse into one:

**Classification** — *what is this job?* — costs an API call, so it is cached by
`sha256(title + company + location + description)`. Re-crawling unchanged text
costs nothing. The hash is the document ID in `classifications/`, so the cache
lookup is the same `create()`-or-exists pattern used everywhere else.

**Scoring** — *do I want this job?* — is a pure function of the classification
and `config/profile`. No IO. Change your mind about what you want, re-score the
entire collection in seconds, pay nothing.

Collapsing these means every preference change is a re-classification bill. Keep
them apart.

Cost control, in order of how much they save:

1. `prefilter.ts` regex — removes ~90% before any call.
2. Content-hash cache — removes every re-crawl.
3. Per-cycle budget cap — bounds the worst case when the board dumps 200 posts.
4. Description truncation at ~6k chars.

Use structured outputs (`output_config.format` with a JSON schema) so the
response is schema-constrained by construction — no JSON-repair path, no retry
loop, no "the model wrapped it in a code fence" bug. Every object needs
`additionalProperties: false`.

Prompt rule that matters more than the model choice: **an unstated field must
come back `null` or `"unknown"`.** A hallucinated "remote: true" costs you an
application; an under-filled field costs you nothing.

---

## 4. Delivery: Telegram

An earlier revision of this design used WhatsApp Cloud API, and WhatsApp's
24-hour customer-service window reshaped the entire outbox into a two-mode
state machine — free-form inside the window, pre-approved templates outside
it. That complexity bought WhatsApp's reach and a "real business" feel.
Neither matters when the user and the business are the same person, so this
revision drops WhatsApp and the whole problem class it created:

- **No rolling window.** WhatsApp's window reopens only when *you* message the
  business, and closes again in 24h. Telegram's equivalent is a single
  one-time `/start` — after that, free-form messages work indefinitely. No
  batching-vs-template branch to design around.
- **No template approval cycle.** Wording changes ship the moment you deploy.
- **No business verification.** Setup is `@BotFather` → `/newbot` → copy the
  token → message the bot once → read `chat.id` off `getUpdates`. Minutes, not
  an afternoon.

What still matters, because it was never actually WhatsApp-specific:

```
outbox/{jobId}
  state: pending | sent | expired | failed
  score, snapshot{title, company, url}, createdAt, sentAt
```

```
  match found
      │
      ▼
   pending ──► send (individual, or batched if ≥ DIGEST_THRESHOLD this cycle) ──► sent
      │
      └── older than OUTBOX_TTL_HOURS ─────────────────────────────────────────► expired
```

- **The outbox is still claimed before it's sent.** `create()`, not a boolean
  flipped after the fact — a restart mid-delivery still must not produce a
  duplicate storm, regardless of which chat API is behind it.
- **Outbox entries still expire.** `OUTBOX_TTL_HOURS` still exists so a bug
  that pauses delivery for four days doesn't dump stale matches once it
  resumes.
- **Batch above a threshold, not by default.** With no window forcing
  digest-only delivery, the failure mode flips from under- to
  over-delivering: five separate pings for five matches in one cycle reads as
  spam even to yourself. `DIGEST_THRESHOLD` matches per cycle collapse into
  one message; below it, send individually — a direct job link is more
  useful than a digest line when there's only one or two.
- **A per-cycle send cap is a bug backstop, not a quota.** Meta grades a
  WhatsApp business number's "quality rating" and throttles low-engagement
  senders; Telegram does nothing equivalent to a personal bot at this volume.
  The cap exists so a scoring regression can't page you forty times in a row.
- **No public webhook for v1.** Outbound-only delivery needs nothing publicly
  reachable — the GitHub Actions workflow run calls the Bot API directly. A webhook (or
  long-polling) only becomes necessary for inbound commands (`/mute company`,
  "mark applied" buttons) — deliberately deferred, see §6.

Rate limits worth knowing, not designing elaborate machinery around: Telegram
asks bots to stay near one message/second to the same chat, and warns against
sustained bursts above roughly 20/minute to one user. At single-user,
few-matches-a-day volume this is not a constraint you will ever feel —
mentioned so nobody "fixes" a non-problem later.

Dead end, named so nobody rediscovers it: unofficial WhatsApp libraries
(Baileys, whatsapp-web.js) were the tempting shortcut in the old design and
remain irrelevant now — Telegram's official Bot API needs none of that
friction in the first place.

---

## 5. Failure modes and what covers them

| Failure | Detected by | Response |
|---|---|---|
| Site puts up an interstitial | `challenge.ts` | Circuit breaker 5m → 6h, notify me, **do not push through** |
| Selectors silently break | `stats/daily_*` shows detail-parse failures | Alert if 0 new jobs for 48h |
| Board dumps 200 posts at once | `maxDetailsPerCycle`, LLM budget | Spread over cycles; nothing lost, just slower |
| Anthropic API down | classify() returns null | Job still stored, scored without classification, retried next cycle |
| Process crashes mid-delivery | outbox doc already `create()`d | At most one lost message, never a duplicate storm |
| Telegram API rejects a send | outbox `failed` + error code | 429 → backoff, retry next cycle; 403 (bot blocked / chat not found) → surface loudly, this means alerts have gone silent |
| Firestore write fails | exception | Cycle aborts, watermark not advanced, next cycle redoes it |

The last row is the reason the watermark is written **after** the job docs, not
before. An interrupted cycle must re-process, never skip.

---

## 6. What I would deliberately not build

- Multi-source adapters, until TanitJobs has run cleanly for a month. The
  `JobSource` interface exists so this is a one-file change later; building the
  second adapter now is speculative work on an unproven pipeline.
- A web dashboard. Firestore console plus `stats/daily_*` answers everything for
  one user.
- Auto-apply / cover-letter generation. Different problem, different risk
  profile, and it corrupts the metric — you want *fewer, better* applications.
- Retry-until-it-works against a WAF. Covered in CLAUDE.md; repeating because it
  is the tempting shortcut every time this breaks.
- A public inbound endpoint (webhook or Cloud Function), until an actual
  inbound feature (`/mute`, "mark applied") needs one. Outbound-only Telegram
  delivery doesn't require it — building it speculatively is exactly the kind
  of premature infra this section exists to veto.
