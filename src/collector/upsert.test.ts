import { test } from "node:test";
import assert from "node:assert/strict";
import type { CreateOutcome } from "../db/repo.js";
import type { UpsertDeps } from "./upsert.js";
import { upsertJob, upsertNewJobs } from "./upsert.js";

const VALID_HTML = `<!doctype html><html><head>
  <script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title: "Ingénieur DevOps",
    description: "Une belle description.",
    hiringOrganization: { name: "Acme Tunisie" },
  })}</script>
</head><body></body></html>`;

// Stands in for db/repo.ts's real createJob: an in-memory set of "job docs"
// that already exist, mirroring exactly what the real function returns
// after catching ALREADY_EXISTS — never throwing for a duplicate.
function fakeJobStore() {
  const existingIds = new Set<number>();
  const created: { id: number; data: Record<string, unknown> }[] = [];
  const createJob = async (id: number, data: Record<string, unknown>): Promise<CreateOutcome> => {
    if (existingIds.has(id)) return "already_exists";
    existingIds.add(id);
    created.push({ id, data });
    return "created";
  };
  return { createJob, created };
}

function deps(overrides: Partial<UpsertDeps> = {}): UpsertDeps {
  const { createJob } = fakeJobStore();
  return {
    fetchDetailHtml: async () => VALID_HTML,
    createJob,
    jobUrl: (id) => `https://www.tanitjobs.com/job/${id}`,
    ...overrides,
  };
}

test("upsert: a valid detail page is parsed and created", async () => {
  const result = await upsertJob(487774, deps());
  assert.equal(result.outcome, "created");
  assert.equal(result.detail?.title, "Ingénieur DevOps");
});

test("upsert: re-processing the same id comes back already_exists, never throws", async () => {
  const { createJob } = fakeJobStore();
  const d = deps({ createJob });
  const first = await upsertJob(487774, d);
  const second = await upsertJob(487774, d);
  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "already_exists");
});

test("upsert: a fetch failure is reported, not thrown", async () => {
  const d = deps({
    fetchDetailHtml: async () => {
      throw new Error("network blip");
    },
  });
  const result = await upsertJob(487774, d);
  assert.equal(result.outcome, "fetch_failed");
});

test("upsert: a page missing required JSON-LD fields is reported as parse_failed, not thrown", async () => {
  const d = deps({ fetchDetailHtml: async () => "<html><body>Just a moment...</body></html>" });
  const result = await upsertJob(487774, d);
  assert.equal(result.outcome, "parse_failed");
});

test("upsert: the job doc is created with jobUrl merged in, no .set() involved", async () => {
  const { createJob, created } = fakeJobStore();
  await upsertJob(487774, deps({ createJob }));
  assert.equal(created.length, 1);
  assert.equal(created[0]?.data["url"], "https://www.tanitjobs.com/job/487774");
});

test("upsert: one failing id in a batch never affects the next id's outcome", async () => {
  const { createJob } = fakeJobStore();
  const d = deps({
    createJob,
    fetchDetailHtml: async (id) => {
      if (id === 1) throw new Error("network blip");
      return VALID_HTML;
    },
  });
  const results = await upsertNewJobs([1, 2], d);
  assert.deepEqual(
    results.map((r) => r.outcome),
    ["fetch_failed", "created"],
  );
});
