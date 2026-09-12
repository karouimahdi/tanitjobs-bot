// Watermark read/update logic (see db/repo.ts for the Firestore doc itself).
// Deliberately pure/testable: takes a Watermark value and this cycle's job
// creation results, returns the next Watermark value. The caller decides
// when to persist it — and per architecture.md §5's failure-mode table,
// that persist must happen strictly after job docs are confirmed written,
// never before, so a crash mid-cycle re-processes instead of silently
// skipping.

import type { Watermark } from "../db/repo.js";

// architecture.md §2b: "the last ~500" — bounds the doc size, not a
// precision guarantee. An id older than this window simply won't reappear
// on today's listing page anyway.
export const RECENT_IDS_CAP = 500;

// Used by the phase-1 sweep (TKT-010) to decide which listing-page ids are
// worth a detail fetch. `id > maxId` is a fast path that skips the array
// scan for the common case (new listings all have higher ids); the
// recentIds check is the safety net for moderation-delayed lower ids
// (architecture.md §2b).
export function isNewId(watermark: Watermark, id: number): boolean {
  if (id > watermark.maxId) return true;
  return !watermark.recentIds.includes(id);
}

export interface JobWriteResult {
  id: number;
  outcome: "created" | "already_exists";
}

// Runs job creation for each candidate id, one at a time, and never lets one
// id's outcome affect another's — a straggler from a half-finished previous
// cycle (outcome "already_exists") is not an error, it's exactly the
// crash-recovery path this ticket exists to cover.
export async function writeNewJobs(
  candidateIds: number[],
  createJob: (id: number) => Promise<"created" | "already_exists">,
): Promise<JobWriteResult[]> {
  const results: JobWriteResult[] = [];
  for (const id of candidateIds) {
    const outcome = await createJob(id);
    results.push({ id, outcome });
  }
  return results;
}

// Folds this cycle's write results into the watermark. Both outcomes count
// as "this id is now accounted for": "created" is the normal case, and
// "already_exists" is a previous cycle's job doc whose watermark write never
// happened (crash between the two) — this cycle rediscovers the id, hits
// ALREADY_EXISTS instead of throwing, and must still advance the watermark
// past it or it would be retried forever.
export function advanceWatermark(watermark: Watermark, results: JobWriteResult[]): Watermark {
  if (results.length === 0) return watermark;

  const seenIds = results.map((result) => result.id);
  const recentIds = [...new Set([...seenIds, ...watermark.recentIds])].slice(0, RECENT_IDS_CAP);
  const maxId = Math.max(watermark.maxId, ...seenIds);

  return { maxId, recentIds, updatedAt: watermark.updatedAt };
}
