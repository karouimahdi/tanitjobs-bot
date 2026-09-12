// One runs/{autoId} doc per cycle. This is the only place "selectors
// silently broke" or "0 new jobs for 48h" become visible — architecture.md's
// failure-mode table depends on this doc existing, not on someone noticing
// the bot went quiet. repo.ts's writeRun owns the TTL field; this module
// only owns shaping the doc.
//
// `buildRunDoc` is pure and separate from `recordRun`'s Firestore write for
// the same reason watermark.ts and upsert.ts split logic from IO: a cycle
// summary should be checkable in a unit test without a database.

import { writeRun } from "../db/repo.js";
import type { CircuitBreakerState } from "../db/repo.js";
import type { UpsertResult } from "./upsert.js";

export interface RunSummary {
  startedAt: Date;
  endedAt: Date;
  sweptIds: number[];
  newIds: number[];
  upsertResults: UpsertResult[];
  breakerState: CircuitBreakerState | null;
  outcome: "ok" | "challenged" | "error";
  errorMessage?: string;
}

export function buildRunDoc(summary: RunSummary): Record<string, unknown> {
  const createdCount = summary.upsertResults.filter((r) => r.outcome === "created").length;
  const alreadyExistsCount = summary.upsertResults.filter((r) => r.outcome === "already_exists").length;
  const fetchFailures = summary.upsertResults.filter((r) => r.outcome === "fetch_failed").length;
  // Named to match the acceptance criterion directly — "a failing detail-
  // parse increments a counter visible in the run doc, not just a console
  // log" — rather than folding it into a generic "failures" bucket that
  // would hide whether the problem is the network or a broken selector.
  const detailParseFailures = summary.upsertResults.filter((r) => r.outcome === "parse_failed").length;

  return {
    startedAt: summary.startedAt.toISOString(),
    endedAt: summary.endedAt.toISOString(),
    durationMs: summary.endedAt.getTime() - summary.startedAt.getTime(),
    sweptCount: summary.sweptIds.length,
    newCount: summary.newIds.length,
    createdCount,
    alreadyExistsCount,
    fetchFailures,
    detailParseFailures,
    breakerStatus: summary.breakerState?.status ?? "closed",
    outcome: summary.outcome,
    errorMessage: summary.errorMessage ?? null,
  };
}

export async function recordRun(summary: RunSummary): Promise<string> {
  return writeRun(buildRunDoc(summary));
}
