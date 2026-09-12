import { test } from "node:test";
import assert from "node:assert/strict";

// Not a real feature test — just proof the scaffold's build + test pipeline
// works end to end. Modules with real logic now have their own *.test.ts;
// this just guards the still-unimplemented ones against import-time throws.
test("scaffold: every placeholder module imports without throwing", async () => {
  await import("./enrich/classifier.js");
  await import("./match/score.js");
  await import("./notify/send.js");
  assert.ok(true);
});
