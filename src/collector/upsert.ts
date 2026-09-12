// Phase 3: for one candidate id, fetch its detail page, parse it, and
// insert exactly once. Both hard invariants CLAUDE.md leads with live here —
// "job identity is tanitjobs_<numericId>, never the URL" is `jobDocId` in
// db/repo.ts, and "use create(), not set()" is enforced there too; this file
// only calls it, never reimplements it.
//
// A detail-fetch failure or a parse failure must not kill the cycle
// (CLAUDE.md: "one bad posting must never kill a run") — both come back as
// an `UpsertResult` outcome for telemetry.ts to count, never a thrown error.
//
// Fetching and creating are injected rather than imported directly so this
// stays testable without Playwright or Firestore — same shape as
// watermark.ts's `writeNewJobs`.

import type { CreateOutcome } from "../db/repo.js";
import { DetailParseError, parseJobDetail } from "../parse/detail.js";
import type { JobDetail } from "../parse/detail.js";

export type UpsertOutcome = CreateOutcome | "fetch_failed" | "parse_failed";

export interface UpsertResult {
  id: number;
  outcome: UpsertOutcome;
  detail?: JobDetail;
}

export interface UpsertDeps {
  fetchDetailHtml: (id: number) => Promise<string>;
  createJob: (id: number, data: Record<string, unknown>) => Promise<CreateOutcome>;
  jobUrl: (id: number) => string;
}

export async function upsertJob(id: number, deps: UpsertDeps): Promise<UpsertResult> {
  let html: string;
  try {
    html = await deps.fetchDetailHtml(id);
  } catch {
    return { id, outcome: "fetch_failed" };
  }

  let detail: JobDetail;
  try {
    detail = parseJobDetail(html);
  } catch (error) {
    if (error instanceof DetailParseError) return { id, outcome: "parse_failed" };
    throw error;
  }

  const outcome = await deps.createJob(id, { ...detail, url: deps.jobUrl(id) });
  return { id, outcome, detail };
}

// One id at a time, deliberately — a slow or failing id must not affect the
// next one's outcome, same reasoning as watermark.ts's writeNewJobs.
export async function upsertNewJobs(ids: number[], deps: UpsertDeps): Promise<UpsertResult[]> {
  const results: UpsertResult[] = [];
  for (const id of ids) {
    results.push(await upsertJob(id, deps));
  }
  return results;
}
