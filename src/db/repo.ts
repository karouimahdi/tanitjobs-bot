// The only module allowed to call getFirestore() (CLAUDE.md code
// convention). Every Firestore read/write the pipeline needs lives here so
// the create()-vs-set() invariant is enforced in one place instead of
// trusted everywhere: job docs and outbox docs are dedup/claim checks
// disguised as writes, so they use create() and treat ALREADY_EXISTS as a
// normal outcome, not an error. Everything else here is a plain value doc
// and uses set()/merge.

import { FieldValue, getFirestore, GrpcStatus, Timestamp } from "firebase-admin/firestore";
import type { DocumentData } from "firebase-admin/firestore";
import { ensureFirebaseApp } from "../firebase-app.js";

function db() {
  ensureFirebaseApp();
  return getFirestore();
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === GrpcStatus.ALREADY_EXISTS
  );
}

export type CreateOutcome = "created" | "already_exists";

// ---------------------------------------------------------------------------
// Watermark — sources/tanitjobs/state/watermark. 1 read + 1 write per cycle.
// ---------------------------------------------------------------------------

export interface Watermark {
  maxId: number;
  recentIds: number[];
  updatedAt: Timestamp | null;
}

const EMPTY_WATERMARK: Watermark = { maxId: 0, recentIds: [], updatedAt: null };

function watermarkRef() {
  return db().collection("sources").doc("tanitjobs").collection("state").doc("watermark");
}

export async function getWatermark(): Promise<Watermark> {
  const snapshot = await watermarkRef().get();
  if (!snapshot.exists) return EMPTY_WATERMARK;

  const data = snapshot.data() ?? {};
  const maxId = data["maxId"];
  const recentIds = data["recentIds"];
  const updatedAt = data["updatedAt"];
  return {
    maxId: typeof maxId === "number" ? maxId : 0,
    recentIds: Array.isArray(recentIds) ? (recentIds as number[]) : [],
    updatedAt: updatedAt instanceof Timestamp ? updatedAt : null,
  };
}

// A plain set(), not create() — the watermark is a rolling summary doc, not
// a novelty check, so overwriting it every cycle is exactly right.
export async function setWatermark(watermark: Pick<Watermark, "maxId" | "recentIds">): Promise<void> {
  await watermarkRef().set({
    maxId: watermark.maxId,
    recentIds: watermark.recentIds,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// Source state — sources/tanitjobs (circuit breaker + robots cache).
// 1 read + at most 1 write per cycle, same doc for both concerns.
// ---------------------------------------------------------------------------

export interface CircuitBreakerState {
  status: "closed" | "open";
  trippedAt: Timestamp | null;
  nextRetryAt: Timestamp | null;
  backoffSeconds: number;
  reason: string | null;
}

export interface RobotsCache {
  fetchedAt: Timestamp | null;
  disallow: string[];
}

export interface SourceState {
  circuitBreaker: CircuitBreakerState | null;
  robots: RobotsCache | null;
  // Backs collector/reconcile.ts's "once per UTC day" gate. Lives here, not
  // in memory, for the same reason the circuit breaker does — a GitHub
  // Actions runner remembers nothing between executions.
  lastReconciledAt: Timestamp | null;
}

function sourceRef() {
  return db().collection("sources").doc("tanitjobs");
}

export async function getSourceState(): Promise<SourceState> {
  const snapshot = await sourceRef().get();
  const data = snapshot.data() ?? {};
  return {
    circuitBreaker: (data["circuitBreaker"] as CircuitBreakerState | undefined) ?? null,
    robots: (data["robots"] as RobotsCache | undefined) ?? null,
    lastReconciledAt: (data["lastReconciledAt"] as Timestamp | undefined) ?? null,
  };
}

export async function updateSourceState(patch: Partial<SourceState>): Promise<void> {
  await sourceRef().set(patch, { merge: true });
}

// ---------------------------------------------------------------------------
// Jobs — jobs/tanitjobs_<numericId>. Doc ID is the identity (invariant #1).
// ---------------------------------------------------------------------------

export function jobDocId(numericId: number): string {
  return `tanitjobs_${numericId}`;
}

export async function createJob(numericId: number, data: Record<string, unknown>): Promise<CreateOutcome> {
  try {
    await db()
      .collection("jobs")
      .doc(jobDocId(numericId))
      .create({ ...data, numericId, createdAt: FieldValue.serverTimestamp() });
    return "created";
  } catch (error) {
    if (isAlreadyExists(error)) return "already_exists";
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Classifications — classifications/{contentHash}, cached AI output.
// ---------------------------------------------------------------------------

export async function getClassification(contentHash: string): Promise<DocumentData | null> {
  const snapshot = await db().collection("classifications").doc(contentHash).get();
  return snapshot.exists ? (snapshot.data() ?? null) : null;
}

export async function createClassification(
  contentHash: string,
  data: Record<string, unknown>,
): Promise<CreateOutcome> {
  try {
    await db()
      .collection("classifications")
      .doc(contentHash)
      .create({ ...data, createdAt: FieldValue.serverTimestamp() });
    return "created";
  } catch (error) {
    if (isAlreadyExists(error)) return "already_exists";
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Outbox — outbox/{jobId}. Claimed with create(), not a boolean flipped
// after sending (CLAUDE.md invariant #4).
// ---------------------------------------------------------------------------

export type OutboxState = "pending" | "sent" | "expired" | "failed";

export interface OutboxSnapshot {
  title: string;
  company: string;
  url: string;
}

export async function claimOutbox(
  jobId: string,
  score: number,
  snapshot: OutboxSnapshot,
): Promise<CreateOutcome> {
  try {
    await db()
      .collection("outbox")
      .doc(jobId)
      .create({
        state: "pending",
        score,
        snapshot,
        createdAt: FieldValue.serverTimestamp(),
      });
    return "created";
  } catch (error) {
    if (isAlreadyExists(error)) return "already_exists";
    throw error;
  }
}

export async function updateOutboxState(
  jobId: string,
  state: OutboxState,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db()
    .collection("outbox")
    .doc(jobId)
    .set({ state, ...extra }, { merge: true });
}

// ---------------------------------------------------------------------------
// Stats — stats/daily_YYYYMMDD, incremented in-cycle (architecture.md §2c).
// ---------------------------------------------------------------------------

function dailyStatsDocId(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `daily_${y}${m}${d}`;
}

export async function incrementDailyStats(counters: Record<string, number>): Promise<void> {
  const increments = Object.fromEntries(
    Object.entries(counters).map(([key, value]) => [key, FieldValue.increment(value)]),
  );
  await db().collection("stats").doc(dailyStatsDocId(new Date())).set(increments, { merge: true });
}

// ---------------------------------------------------------------------------
// Profile — config/profile, scoring weights editable without redeploy.
// ---------------------------------------------------------------------------

export async function getProfile(): Promise<DocumentData | null> {
  const snapshot = await db().collection("config").doc("profile").get();
  return snapshot.exists ? (snapshot.data() ?? null) : null;
}

// ---------------------------------------------------------------------------
// Run telemetry — runs/{autoId}. `expiresAt` backs a Firestore TTL policy
// (set on the `expiresAt` field via the console/gcloud — not something
// application code enforces) for the documented 30-day retention.
// ---------------------------------------------------------------------------

const RUN_TTL_DAYS = 30;

export async function writeRun(data: Record<string, unknown>): Promise<string> {
  const expiresAt = Timestamp.fromMillis(Date.now() + RUN_TTL_DAYS * 24 * 60 * 60 * 1000);
  const ref = await db()
    .collection("runs")
    .add({ ...data, createdAt: FieldValue.serverTimestamp(), expiresAt });
  return ref.id;
}
