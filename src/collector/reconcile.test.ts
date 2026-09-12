import { test } from "node:test";
import assert from "node:assert/strict";
import type { CreateOutcome } from "../db/repo.js";
import type { UpsertDeps } from "./upsert.js";
import { reconcile, shouldRunReconciliation } from "./reconcile.js";

test("reconcile: never ran before always runs", () => {
  assert.equal(shouldRunReconciliation(null, new Date("2026-09-12T00:05:00.000Z")), true);
});

test("reconcile: already ran earlier today does not run again", () => {
  const lastReconciledAt = new Date("2026-09-12T00:05:00.000Z");
  const now = new Date("2026-09-12T23:55:00.000Z");
  assert.equal(shouldRunReconciliation(lastReconciledAt, now), false);
});

test("reconcile: crossing a UTC midnight boundary runs again, regardless of elapsed hours", () => {
  const lastReconciledAt = new Date("2026-09-12T23:59:00.000Z");
  const now = new Date("2026-09-13T00:01:00.000Z");
  assert.equal(shouldRunReconciliation(lastReconciledAt, now), true);
});

const VALID_HTML = `<!doctype html><html><head>
  <script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title: "Comptable",
    description: "Description complète.",
    hiringOrganization: { name: "Acme Tunisie" },
  })}</script>
</head><body></body></html>`;

function fakeDeps(existingIds: number[]): UpsertDeps {
  const existing = new Set(existingIds);
  const createJob = async (id: number): Promise<CreateOutcome> => {
    if (existing.has(id)) return "already_exists";
    existing.add(id);
    return "created";
  };
  return {
    fetchDetailHtml: async () => VALID_HTML,
    createJob,
    jobUrl: (id) => `https://www.tanitjobs.com/job/${id}`,
  };
}

test("reconcile: ignores the watermark entirely — every page-one id is attempted", async () => {
  const deps = fakeDeps([]);
  const results = await reconcile([100, 101, 102], deps);
  assert.deepEqual(
    results.map((r) => r.outcome),
    ["created", "created", "created"],
  );
});

test("reconcile: an id already in Firestore is a no-op create() attempt, not an error", async () => {
  const deps = fakeDeps([100]);
  const results = await reconcile([100, 101], deps);
  assert.deepEqual(
    results.map((r) => r.outcome),
    ["already_exists", "created"],
  );
});
