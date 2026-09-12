import { test } from "node:test";
import assert from "node:assert/strict";
import { isChallengeResponse, nextBackoffSeconds } from "./challenge.js";

test("challenge: 403/429/503 are always a challenge, regardless of body", () => {
  for (const status of [403, 429, 503]) {
    assert.equal(isChallengeResponse({ status, headers: {} }), true);
  }
  assert.equal(isChallengeResponse({ status: 200, headers: {} }), false);
});

test("challenge: cf-mitigated header trips even on a 200", () => {
  assert.equal(
    isChallengeResponse({ status: 200, headers: { "cf-mitigated": "challenge" } }),
    true,
  );
});

test("challenge: known interstitial body markers trip on a 200", () => {
  assert.equal(
    isChallengeResponse({ status: 200, headers: {}, bodySnippet: "<title>Just a moment...</title>" }),
    true,
  );
  assert.equal(
    isChallengeResponse({ status: 200, headers: {}, bodySnippet: "<h1>Normal job listing</h1>" }),
    false,
  );
});

test("challenge: backoff doubles from 5min up to a 6h cap", () => {
  const FIVE_MIN = 5 * 60;
  const SIX_HOURS = 6 * 60 * 60;

  let backoff = 0;
  const progression = [backoff];
  for (let i = 0; i < 10; i++) {
    backoff = nextBackoffSeconds(backoff);
    progression.push(backoff);
  }

  assert.equal(progression[1], FIVE_MIN);
  assert.equal(progression[2], FIVE_MIN * 2);
  assert.equal(Math.max(...progression), SIX_HOURS);
  assert.equal(nextBackoffSeconds(SIX_HOURS), SIX_HOURS);
});
