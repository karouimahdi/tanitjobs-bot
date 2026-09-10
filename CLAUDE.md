# CLAUDE.md

Personal job-alert bot. Watches **TanitJobs** (Tunisian local jobs), detects newly
posted listings, uses a small model to normalize French/Arabic/English
descriptions, scores them against my profile, and delivers matches over
**Telegram**.

Single user. Single source. No hardware to own or maintain, and no billing
account either — the collector runs as a scheduled **GitHub Actions
workflow**, not a Pi, a VPS, or a paid GCP compute product. Optimizing for
*reliability over months*, not scale.

Stack: TypeScript · Node 20 · Playwright · Firebase (Firestore, Spark/free
plan) · GitHub Actions (scheduled workflow) · Anthropic API · Telegram Bot
API.

Note on this choice: the original revision of this plan used Cloud Run Jobs +
Cloud Scheduler. Those are GCP-billing-exclusive products — enabling them is
hard-blocked without a linked billing account, full stop, regardless of
actual usage volume. Staying on Firebase's free Spark plan meant moving the
collector's compute off GCP entirely. Firestore itself stayed on GCP/Firebase
throughout — only the *scheduler and compute* moved.

---

## Commands

```bash
npm run probe             # inspect a live page; ALWAYS run before touching selectors
npm run once               # one full collection cycle, no scheduler — this is what the GitHub Actions workflow runs
npm run collect            # local-only dev loop; production scheduling is the GitHub Actions cron trigger, not this process
npm run emulate             # firebase emulators (firestore)
npm run deploy:job          # placeholder — deployment is `git push`; .github/workflows/collect.yml is the schedule (TKT-006)
npm run tg:check            # send a test message to confirm the bot token + chat id work
npm test
```

---

## Hard invariants

Break any of these and the bot fails silently or spams me. They are not style
preferences.

1. **Job identity is `tanitjobs_<numericId>`, never the URL.**
   TanitJobs postings live at `/job/487774`. Slugs and query params change; the
   numeric id does not. Firestore doc ID *is* that string.

2. **Use `create()`, not `set()`, to insert a job.**
   A deterministic doc ID plus `create()` throws `ALREADY_EXISTS`, and that
   exception *is* the "is this new?" check — atomic, one write, zero reads.
   `set()` silently overwrites and destroys new-job detection. This is the
   single most important line in the codebase.

3. **All outbound goes through `notify/send.ts` — never call the Telegram API
   directly from anywhere else.**
   Telegram has no 24-hour window restriction the way WhatsApp did: once I've
   sent the bot a single `/start`, free-form messages work anytime. `send.ts`
   still earns its keep — it owns 429 backoff, MarkdownV2 escaping (an
   unescaped `_`, `*`, `.`, or `(` in a job title breaks formatting and can
   drop the whole message), and is the one place that knows the chat id. A
   stray `fetch()` to the Bot API from pipeline code is always wrong.

4. **Claim the outbox doc before sending, not after.**
   `outbox/{jobId}` with `create()`. If it already exists, someone already
   handled it. A "sent" boolean written *after* the send produces duplicate
   message storms on restart. This has nothing to do with which chat API is
   behind it — it is a crash-safety invariant, not a WhatsApp-specific one.

5. **Anti-bot challenges are a stop signal.**
   `browser/challenge.ts` detects interstitials and 403/429/503 and trips the
   circuit breaker. **Never add CAPTCHA solving, stealth plugins, fingerprint
   spoofing, or proxy rotation.** Running the collector on GitHub Actions
   trades a residential-shaped IP for a shared, publicly-documented
   GitHub-runner IP range — arguably a *bigger* red flag to a WAF than a
   Google datacenter IP would have been, since those ranges are widely known
   and already show up on some blocklists. There is no static-IP mitigation
   available here the way there would be on a VPC-connected compute product —
   a self-hosted runner would fix that, but that's an always-on box again,
   exactly what this design avoids. If challenges recur, the only fix is to
   slow the poll interval further or ask TanitJobs for feed access. Beyond
   the ToS problem, grinding against a WAF turns a soft block into a
   permanent ban and ends the project.

6. **The model never sees a posting that `prefilter.ts` rejected.**
   Regex kills ~90% of rows (call-centre, comptabilité, commercial) for free.

7. **`score()` stays pure.** No IO, no model call, no Firestore. It must be
   re-runnable over the whole collection in seconds when I change my mind about
   what I want — which happens weekly.

---

## Firestore layout

```
sources/tanitjobs                 config, circuit-breaker state, robots cache
sources/tanitjobs/state/watermark { maxId, recentIds[] }  ← 1 read per cycle
jobs/tanitjobs_487774             the posting + score
classifications/{contentHash}     AI output, cached by text hash
outbox/{jobId}                    delivery queue (pending | sent | expired | failed)
config/profile                    scoring weights, editable without redeploy
runs/{autoId}                     crawl telemetry, TTL 30d
stats/daily_{YYYYMMDD}            counters, incremented in-cycle
```

**Reads are the currency.** A steady-state cycle must stay around 3 reads and
2 writes. If a change makes the cycle read per-job, it is wrong — rework it
through the watermark doc.

**Firestore cannot answer analytical questions.** Do not write queries that scan
`jobs`. Anything aggregate goes into `stats/daily_*` at write time.

**No full-text search.** `stack` is denormalized as a map (`{react: true}`) for
equality filters. Do not add a search feature without saying so out loud first.

---

## Delivery: Telegram

Telegram removes the entire problem class that made WhatsApp's delivery layer
the hardest part of this project: there is no rolling 24-hour window, no
pre-approved templates, and no business verification. Once I've sent the bot
one `/start`, free-form messages work indefinitely, richly formatted, with no
re-approval cycle for wording changes.

That does **not** mean delivery needs no design:

- **The outbox is still claimed before it's sent.** `outbox/{jobId}` via
  `create()`, state `pending → sent | expired | failed`. A boolean flipped
  *after* a successful send is still how a restart mid-delivery produces a
  duplicate storm — that failure mode was never actually about WhatsApp.
- **Outbox entries still expire.** A match older than `OUTBOX_TTL_HOURS` is
  marked `expired`, not delivered. A four-day-old posting is already filled.
- **Batch above a threshold, not by default.** With no window forcing
  digest-only delivery, the failure mode flips from under- to
  over-delivering. More than `DIGEST_THRESHOLD` matches found in one cycle
  collapse into a single digest message; below it, send individually —
  individual messages are more useful (a direct job link) when there are only
  one or two.
- **A per-cycle send cap exists as a bug backstop, not a quota.** Meta grades
  a WhatsApp business number's "quality rating" and throttles low-engagement
  senders; Telegram does nothing equivalent to a personal bot at this volume.
  The cap exists so a scoring regression can't page me forty times in a row,
  not to conserve a budget.
- **No public webhook for v1.** Outbound-only delivery needs nothing
  publicly reachable — the GitHub Actions workflow run calls the Bot API
  directly. A webhook (or long-polling) only becomes necessary for inbound commands
  (`/mute company`, "mark applied" buttons) — deliberately deferred.

Note: Telegram asks bots to stay near one message/second to the same chat and
warns against sustained bursts above ~20/minute to one user. At single-user,
few-matches-a-day volume this is not a real constraint — noted so nobody
"fixes" it later.

---

## Collector rules

- Two-phase always. Sweep list pages for ids only; fetch a detail page **only**
  for an id the watermark says is unknown. Steady state is ~3 requests per
  cycle, not ~300. Most scrapers get blocked for volume, not detection.
- Parse **schema.org JSON-LD first**, CSS selectors only as fallback. Boards
  maintain JSON-LD for Google Jobs indexing far more carefully than their markup.
- Honest `User-Agent` with a contact address. Keep `RESPECT_ROBOTS=true`.
- One browser *session*, reused across ephemeral runs. GitHub Actions runners
  are a fresh VM every time — nothing local persists between them — so
  Playwright `storageState` (cookies + localStorage) round-trips through a
  small object in **Firebase Storage** (Spark plan, free) at the start and
  end of every run. Same "returning visitor" shape as a persistent profile,
  just serialized between executions instead of left on disk.
- Jitter both the inter-request delay and the cycle interval. Default the
  workflow's `schedule: cron` cadence to **every 15 minutes**, not 5 — a
  fresh-VM cold start plus a well-known shared CI-runner egress IP is already
  a heavier signal than a home connection was; there is no reason to also
  make it a frequent one. GitHub's own cron scheduler is best-effort and can
  slip by several minutes under load — treat that slack as free jitter, not
  a bug.
- Never poll faster than every 5 minutes, full stop.

---

## Hosting: no hardware to own, no billing account either

The collector runs as a **GitHub Actions scheduled workflow**
(`.github/workflows/collect.yml`, cron-triggered) on a GitHub-hosted
`ubuntu-latest` runner. It boots, does one cycle (sweep → dedup → detail
fetch → classify → score → notify), and exits. Nothing stays running between
cycles; nothing needs a systemd unit, SSH access, OS patching, a Docker
image, or a linked payment method — Actions minutes are free on a public
repo.

The trade against Cloud Run Jobs (the previous revision of this plan): no
container to build or push, no Artifact Registry, and genuinely $0/month
instead of "should stay near $0" — but also no VPC, so no static-IP
mitigation if TanitJobs starts issuing challenges (see hard invariant #5),
and GitHub's cron timing is best-effort rather than precise. The trade
against a self-hosted box: zero physical or virtual hardware to maintain,
ever, same as the Cloud Run revision. If a change seems to need "the machine
it runs on" to persist state in memory across cycles, that's a sign the
state belongs in Firestore instead, not a sign to bring back an always-on
box.

Secrets (Anthropic key, Telegram token, the Firebase service account key)
live in GitHub's encrypted repo secrets, injected as env vars at workflow
run time — never committed, never printed (GitHub masks known secret values
in logs automatically).

If a public HTTPS endpoint is ever genuinely needed (inbound Telegram
commands), it is a small, separate service — never folded into the scheduled
workflow, which has no listener to begin with.

---

## Code conventions

- ESM, `strict: true`, `noUncheckedIndexedAccess: true`. No `any` outside the
  documented SDK-typing gap in `enrich/classifier.ts`.
- All Firestore access behind `db/repo.ts`. No `getFirestore()` in pipeline code.
- All Telegram access behind `notify/send.ts`.
- Errors that should stop a source subclass `ChallengeError`. Everything else
  logs and lets the cycle continue — one bad posting must never kill a run.
- Comments explain *why*, especially where the code looks over-engineered.
  Every invariant above exists because the obvious version is broken.

---

## When you are unsure

- **Selectors** → run `npm run probe` and read `raw/probe.html`. Never guess.
- **Anything Telegram** → route it through `notify/send.ts`; check MarkdownV2
  escaping before writing a send.
- **Adding a dependency** → ask. This is a long-lived personal tool; every
  package is something I maintain at 2am in eight months.
- **A change that adds Firestore reads per job** → ask. That is the cost model.
- **A change that implies something needs to stay running between cycles** →
  ask before adding a server. The whole point of this revision was not
  needing one.

Deeper rationale lives in `docs/architecture.md` and `docs/decisions.md`.
Keep this file short enough that it is always worth reading.
