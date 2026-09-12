import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import type { UpsertResult } from "./upsert.js";
import { buildRunDoc } from "./telemetry.js";

const RESULTS: UpsertResult[] = [
  { id: 1, outcome: "created" },
  { id: 2, outcome: "created" },
  { id: 3, outcome: "already_exists" },
  { id: 4, outcome: "fetch_failed" },
  { id: 5, outcome: "parse_failed" },
];

test("telemetry: counts each upsert outcome into its own field", () => {
  const doc = buildRunDoc({
    startedAt: new Date("2026-09-12T10:00:00.000Z"),
    endedAt: new Date("2026-09-12T10:00:05.000Z"),
    sweptIds: [1, 2, 3, 4, 5, 6],
    newIds: [1, 2, 3, 4, 5],
    upsertResults: RESULTS,
    breakerState: null,
    outcome: "ok",
  });

  assert.equal(doc["sweptCount"], 6);
  assert.equal(doc["newCount"], 5);
  assert.equal(doc["createdCount"], 2);
  assert.equal(doc["alreadyExistsCount"], 1);
  assert.equal(doc["fetchFailures"], 1);
  assert.equal(doc["detailParseFailures"], 1);
  assert.equal(doc["durationMs"], 5000);
  assert.equal(doc["breakerStatus"], "closed");
});

test("telemetry: a failing detail-parse is visible as its own counter, not folded into a generic total", () => {
  const doc = buildRunDoc({
    startedAt: new Date(),
    endedAt: new Date(),
    sweptIds: [],
    newIds: [],
    upsertResults: [
      { id: 1, outcome: "parse_failed" },
      { id: 2, outcome: "parse_failed" },
    ],
    breakerState: null,
    outcome: "ok",
  });
  assert.equal(doc["detailParseFailures"], 2);
  assert.equal(doc["fetchFailures"], 0);
  assert.equal(doc["createdCount"], 0);
});

test("telemetry: reflects an open breaker's status", () => {
  const doc = buildRunDoc({
    startedAt: new Date(),
    endedAt: new Date(),
    sweptIds: [],
    newIds: [],
    upsertResults: [],
    breakerState: {
      status: "open",
      trippedAt: Timestamp.now(),
      nextRetryAt: Timestamp.now(),
      backoffSeconds: 300,
      reason: "403",
    },
    outcome: "challenged",
  });
  assert.equal(doc["breakerStatus"], "open");
  assert.equal(doc["outcome"], "challenged");
});

test("telemetry: errorMessage defaults to null when the cycle didn't error", () => {
  const doc = buildRunDoc({
    startedAt: new Date(),
    endedAt: new Date(),
    sweptIds: [],
    newIds: [],
    upsertResults: [],
    breakerState: null,
    outcome: "ok",
  });
  assert.equal(doc["errorMessage"], null);
});
