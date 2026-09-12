import { test } from "node:test";
import assert from "node:assert/strict";
import { jitteredDelayMs } from "./throttle.js";

test("throttle: jitter stays within the configured spread and never goes negative", () => {
  const base = 1000;
  const ratio = 0.4;
  for (let i = 0; i < 200; i++) {
    const delay = jitteredDelayMs(base, ratio);
    assert.ok(delay >= base * (1 - ratio));
    assert.ok(delay <= base * (1 + ratio));
    assert.ok(delay >= 0);
  }
});

test("throttle: zero base delay never goes negative", () => {
  assert.equal(jitteredDelayMs(0, 0.4), 0);
});
