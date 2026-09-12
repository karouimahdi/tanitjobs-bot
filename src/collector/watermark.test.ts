import { test } from "node:test";
import assert from "node:assert/strict";
import type { Watermark } from "../db/repo.js";
import { RECENT_IDS_CAP, advanceWatermark, isNewId, writeNewJobs } from "./watermark.js";

// Stands in for the real Firestore-backed `createJob` in db/repo.ts: an
// in-memory set of "job docs" that already exist, throwing nothing and
// instead returning "already_exists" — exactly what repo.ts does after
// catching the real ALREADY_EXISTS error.
function fakeJobStore() {
  const existingIds = new Set<number>();
  return async function createJob(id: number): Promise<"created" | "already_exists"> {
    if (existingIds.has(id)) return "already_exists";
    existingIds.add(id);
    return "created";
  };
}

test("watermark: crash between job-write and watermark-write is recovered, not thrown", async () => {
  const createJob = fakeJobStore();
  let watermark: Watermark = { maxId: 0, recentIds: [], updatedAt: null };

  // Cycle A: job doc for 487774 is written successfully, but the process
  // crashes before setWatermark() runs — so `watermark` here is never
  // updated with the result, simulating exactly that crash.
  const cycleAResults = await writeNewJobs([487774], createJob);
  assert.deepEqual(cycleAResults, [{ id: 487774, outcome: "created" }]);
  // (intentionally not calling advanceWatermark here — the "crash")

  // Cycle B: watermark is still {maxId: 0, recentIds: []}, so the sweep
  // still thinks 487774 is new and hands it to writeNewJobs again.
  assert.equal(isNewId(watermark, 487774), true);
  await assert.doesNotReject(async () => {
    const cycleBResults = await writeNewJobs([487774], createJob);
    assert.deepEqual(cycleBResults, [{ id: 487774, outcome: "already_exists" }]);
    watermark = advanceWatermark(watermark, cycleBResults);
  });

  assert.equal(watermark.maxId, 487774);
  assert.deepEqual(watermark.recentIds, [487774]);

  // Cycle C: watermark now reflects 487774 — it's no longer new.
  assert.equal(isNewId(watermark, 487774), false);
});

test("watermark: recentIds never grows past the cap", () => {
  const initial: Watermark = { maxId: 0, recentIds: [], updatedAt: null };
  const firstBatch = Array.from({ length: RECENT_IDS_CAP + 50 }, (_, i) => ({
    id: i + 1,
    outcome: "created" as const,
  }));

  const afterFirstBatch = advanceWatermark(initial, firstBatch);
  assert.equal(afterFirstBatch.recentIds.length, RECENT_IDS_CAP);

  const nextResults = [{ id: RECENT_IDS_CAP + 51, outcome: "created" as const }];
  const afterNextCycle = advanceWatermark(afterFirstBatch, nextResults);
  assert.equal(afterNextCycle.recentIds.length, RECENT_IDS_CAP);
  assert.equal(afterNextCycle.maxId, RECENT_IDS_CAP + 51);
  assert.ok(afterNextCycle.recentIds.includes(RECENT_IDS_CAP + 51));
});

test("watermark: isNewId catches moderation-delayed lower ids via recentIds", () => {
  const watermark: Watermark = { maxId: 500, recentIds: [500, 498, 495], updatedAt: null };
  // 496 is below maxId and not in recentIds — a lower id that surfaced late.
  assert.equal(isNewId(watermark, 496), true);
  // 498 is below maxId but already tracked.
  assert.equal(isNewId(watermark, 498), false);
  // 501 exceeds maxId — always new, regardless of recentIds.
  assert.equal(isNewId(watermark, 501), true);
});
