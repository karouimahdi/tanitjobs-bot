// Phase 1: sweep the listing page(s) for /job/<id> ids only — no detail
// fetch happens here. This is what keeps steady-state traffic at ~3
// requests per cycle instead of ~40: CLAUDE.md — "most scrapers get blocked
// for volume, not detection."

import type { Page } from "playwright";
import type { Watermark } from "../db/repo.js";
import { isNewId } from "./watermark.js";

const JOB_HREF_PATTERN = /\/job\/(\d+)/;

// Pure — pulls numeric ids out of already-fetched hrefs. Testable without a
// browser, and shared with probe.ts's own id-shape reporting.
export function extractJobIds(hrefs: string[]): number[] {
  const ids = hrefs
    .map((href) => href.match(JOB_HREF_PATTERN)?.[1])
    .filter((id): id is string => id !== undefined)
    .map(Number);
  return [...new Set(ids)];
}

// Loads one listing page and returns every job id found on it. Caller owns
// the Page (and therefore the storageState / UA / throttling around it) —
// this function only knows how to read one page.
export async function sweepListingPage(page: Page, url: string): Promise<number[]> {
  await page.goto(url, { waitUntil: "networkidle" });
  const hrefs = await page.$$eval('a[href*="/job/"]', (nodes) =>
    nodes.map((node) => node.getAttribute("href") ?? "").filter((href) => href.length > 0),
  );
  return extractJobIds(hrefs);
}

// Diffs swept ids against the watermark — only these are worth a detail
// fetch (TKT-015+). This is the entire point of the two-phase design.
export function newIdsSince(watermark: Watermark, sweptIds: number[]): number[] {
  return sweptIds.filter((id) => isNewId(watermark, id));
}
