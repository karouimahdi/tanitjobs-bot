// Daily reconciliation: ignore the watermark, attempt create() for every id
// found on listing page one. architecture.md §2b: ids are assigned at
// submission but appear after moderation, so a lower id can surface after a
// higher one has already advanced the watermark past it — and if it also
// fell out of the watermark's recentIds window (RECENT_IDS_CAP) before
// resurfacing, the fast path in watermark.ts will never re-check it. This
// is the self-heal for exactly that gap, not a replacement for the fast
// path — it runs once a day precisely because it's a blunt, ignore-the-
// watermark instrument, not because it needs to run more often.
//
// Re-upserting an id already in Firestore just costs a redundant create()
// attempt — upsertJob already treats "already_exists" as a normal outcome,
// so reconciliation needs no dedup logic of its own beyond that.

import type { UpsertDeps, UpsertResult } from "./upsert.js";
import { upsertNewJobs } from "./upsert.js";

// Pure — comparing UTC calendar days (not a rolling 24h window) means a
// slow-running or delayed cycle can't push reconciliation later and later
// across a midnight boundary. Matches the ticket's "once a UTC day" wording
// exactly, and is testable without a clock-mocking library.
export function shouldRunReconciliation(lastReconciledAt: Date | null, now: Date): boolean {
  if (!lastReconciledAt) return true;
  return toUtcDateString(lastReconciledAt) !== toUtcDateString(now);
}

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function reconcile(pageOneIds: number[], deps: UpsertDeps): Promise<UpsertResult[]> {
  return upsertNewJobs(pageOneIds, deps);
}
