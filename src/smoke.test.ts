import { test } from "node:test";
import assert from "node:assert/strict";

// Not a real feature test — just proof the scaffold's build + test pipeline
// works end to end before any real logic lands in these modules.
test("scaffold: every placeholder module imports without throwing", async () => {
  await import("./collector/sweep.js");
  await import("./parse/detail.js");
  await import("./enrich/classifier.js");
  await import("./match/score.js");
  await import("./db/repo.js");
  await import("./notify/send.js");
  assert.ok(true);
});
