// The circuit breaker. Detects interstitials/CAPTCHA pages and 403/429/503
// responses, then trips exponential backoff (5 min → 6 h) persisted in
// Firestore (sources/tanitjobs), because a GitHub Actions runner remembers
// nothing from the last execution — the *only* place this state can live is
// the database, never memory.
//
// Hard invariant (CLAUDE.md #5): no CAPTCHA solving, no stealth plugins, no
// fingerprint spoofing, no proxy rotation, ever. This file's entire job is
// to make stopping the default reaction to a challenge, not an afterthought.

import { Timestamp } from "firebase-admin/firestore";
import { getSourceState, updateSourceState } from "../db/repo.js";
import type { CircuitBreakerState } from "../db/repo.js";

// Errors that should stop the whole source, per CLAUDE.md code conventions.
// once.ts (TKT-029) catches this class specifically to abort the cycle
// without crashing it — everything else logs and the cycle continues.
export class ChallengeError extends Error {
  constructor(reason: string) {
    super(`challenge detected: ${reason}`);
    this.name = "ChallengeError";
  }
}

const CHALLENGE_STATUS_CODES = new Set([403, 429, 503]);

// Cloudflare's actual JS-challenge/Turnstile markup — seen firsthand hitting
// tanitjobs.com with a plain request: header `cf-mitigated: challenge` plus
// a "Just a moment..." interstitial body. Kept as a list of independent
// signals rather than one regex so any single one is enough to trip.
const CHALLENGE_BODY_MARKERS = [
  /just a moment/i,
  /checking your browser/i,
  /attention required/i,
  /cf-chl/i,
  /challenges\.cloudflare\.com/i,
  /captcha/i,
];

export interface ResponseSignal {
  status: number;
  headers: Record<string, string>;
  bodySnippet?: string;
}

export function isChallengeResponse(signal: ResponseSignal): boolean {
  if (CHALLENGE_STATUS_CODES.has(signal.status)) return true;
  if (signal.headers["cf-mitigated"]) return true;

  const body = signal.bodySnippet ?? "";
  return CHALLENGE_BODY_MARKERS.some((marker) => marker.test(body));
}

// exponential 5 min → 6 h, doubling each trip.
const BASE_BACKOFF_SECONDS = 5 * 60;
const MAX_BACKOFF_SECONDS = 6 * 60 * 60;

export function nextBackoffSeconds(currentBackoffSeconds: number): number {
  if (currentBackoffSeconds <= 0) return BASE_BACKOFF_SECONDS;
  return Math.min(currentBackoffSeconds * 2, MAX_BACKOFF_SECONDS);
}

export interface BreakerCheck {
  isOpen: boolean;
  nextRetryAt: Date | null;
}

// Read-only check — call this *before* touching the site at all. Firestore
// is the only source of truth here; there is no in-memory fallback.
export async function checkBreaker(): Promise<BreakerCheck> {
  const { circuitBreaker } = await getSourceState();
  if (!circuitBreaker || circuitBreaker.status === "closed") {
    return { isOpen: false, nextRetryAt: null };
  }

  const nextRetryAt = circuitBreaker.nextRetryAt?.toDate() ?? null;
  const stillOpen = nextRetryAt !== null && Date.now() < nextRetryAt.getTime();
  return { isOpen: stillOpen, nextRetryAt };
}

export async function tripBreaker(reason: string): Promise<void> {
  const { circuitBreaker } = await getSourceState();
  const backoffSeconds = nextBackoffSeconds(circuitBreaker?.backoffSeconds ?? 0);
  const now = new Date();

  const next: CircuitBreakerState = {
    status: "open",
    trippedAt: Timestamp.fromDate(now),
    nextRetryAt: Timestamp.fromDate(new Date(now.getTime() + backoffSeconds * 1000)),
    backoffSeconds,
    reason,
  };

  await updateSourceState({ circuitBreaker: next });
}

// Call after a cycle that touched the site without hitting a challenge.
// A no-op (no write) if the breaker was already closed, so a healthy steady
// state doesn't spend a write on this every cycle.
export async function resetBreaker(): Promise<void> {
  const { circuitBreaker } = await getSourceState();
  if (!circuitBreaker || circuitBreaker.status === "closed") return;

  const closed: CircuitBreakerState = {
    status: "closed",
    trippedAt: null,
    nextRetryAt: null,
    backoffSeconds: 0,
    reason: null,
  };
  await updateSourceState({ circuitBreaker: closed });
}
