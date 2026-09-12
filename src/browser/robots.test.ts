import { test } from "node:test";
import assert from "node:assert/strict";
import { isPathDisallowed, parseRobotsTxt } from "./robots.js";

test("robots: wildcard group applies when no product-specific group exists", () => {
  const disallow = parseRobotsTxt(`
    User-agent: *
    Disallow: /admin/
    Disallow: /search
  `);
  assert.deepEqual(disallow, ["/admin/", "/search"]);
});

test("robots: a matching product-specific group overrides the wildcard group", () => {
  const disallow = parseRobotsTxt(`
    User-agent: *
    Disallow: /everything

    User-agent: tanitjobs-bot
    Disallow: /only-this
  `);
  assert.deepEqual(disallow, ["/only-this"]);
});

test("robots: consecutive User-agent lines share one group", () => {
  const disallow = parseRobotsTxt(`
    User-agent: googlebot
    User-agent: *
    Disallow: /shared
  `);
  assert.deepEqual(disallow, ["/shared"]);
});

test("robots: path matching honors prefix rules, wildcards, and end-anchors", () => {
  assert.equal(isPathDisallowed(["/admin/"], "/admin/users"), true);
  assert.equal(isPathDisallowed(["/admin/"], "/administrator"), false);
  assert.equal(isPathDisallowed(["/search*"], "/search?q=x"), true);
  assert.equal(isPathDisallowed(["/job/*.pdf$"], "/job/487774.pdf"), true);
  assert.equal(isPathDisallowed(["/job/*.pdf$"], "/job/487774.pdf?utm=1"), false);
  assert.equal(isPathDisallowed(["/private"], "/job/487774"), false);
});
