import { test } from "node:test";
import assert from "node:assert/strict";
import type { Watermark } from "../db/repo.js";
import { extractJobIds, newIdsSince } from "./sweep.js";

test("sweep: extracts numeric ids from various /job/<id> href shapes", () => {
  const hrefs = [
    "/job/487774",
    "/job/487774-senior-developer-tunis",
    "/job/487770?ref=home",
    "https://www.tanitjobs.com/job/487768",
    "/job/487774", // duplicate on the page — should collapse
    "/not-a-job/123",
    "/job/not-numeric",
  ];
  assert.deepEqual(extractJobIds(hrefs), [487774, 487770, 487768]);
});

test("sweep: newIdsSince only keeps ids the watermark doesn't already know", () => {
  const watermark: Watermark = { maxId: 487770, recentIds: [487770, 487768], updatedAt: null };
  const swept = [487774, 487770, 487768, 487760];
  // 487774 > maxId => new. 487760 < maxId and not in recentIds => could be
  // a moderation-delayed new post => also treated as new.
  assert.deepEqual(newIdsSince(watermark, swept), [487774, 487760]);
});
