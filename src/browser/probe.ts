// Render the TanitJobs listing page and report HTTP status, cf-ray
// presence, JobPosting JSON-LD presence, observed JSON endpoints, and the
// shape of /job/<id> links. Writes raw/probe.html + raw/probe.png.
// See CLAUDE.md — "ALWAYS run before touching selectors. Never guess."

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { SOURCE_URL, USER_AGENT } from "../config.js";

const rawDir = path.join(process.cwd(), "raw");
await mkdir(rawDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ userAgent: USER_AGENT });
const page = await context.newPage();

const jsonEndpoints = new Set<string>();
page.on("response", (response) => {
  const contentType = response.headers()["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    jsonEndpoints.add(response.url());
  }
});

// "networkidle" never fires on a Cloudflare challenge page — its own JS
// keeps polling in the background — so wait for DOM content instead and
// give the slow sandbox network real headroom.
const response = await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
if (!response) {
  throw new Error(`probe: no response loading ${SOURCE_URL}`);
}

const status = response.status();
const cfRay = response.headers()["cf-ray"];

// A Cloudflare "Just a moment..." interstitial is not necessarily a hard
// block — it's Cloudflare's normal managed-challenge JS check, which a real
// browser passes automatically a few seconds after the initial DOM load and
// then gets redirected to the real page. Reading page.content() immediately
// after domcontentloaded — the previous version of this script — captures
// the interstitial itself, not the outcome. Give it a real chance to clear
// before deciding this is actually a block.
const initialTitle = await page.title();
const sawInterstitial = /just a moment/i.test(initialTitle);
let clearedAfterMs: number | null = null;

if (sawInterstitial) {
  const clearStart = Date.now();
  try {
    // Cast rather than adding "DOM" to tsconfig's lib — this project is
    // Node-only outside evaluate() callbacks, and pulling in the full DOM
    // lib globally would let browser globals leak into pipeline code by
    // accident. `document` here runs in the page, not this process.
    await page.waitForFunction(
      () => !/just a moment/i.test((globalThis as unknown as { document: { title: string } }).document.title),
      undefined,
      { timeout: 20000, polling: 500 },
    );
    clearedAfterMs = Date.now() - clearStart;
  } catch {
    // Didn't clear within the window — still a challenge, report as such.
  }
}

const html = await page.content();
await writeFile(path.join(rawDir, "probe.html"), html, "utf8");
await page.screenshot({ path: path.join(rawDir, "probe.png"), fullPage: true });

const jsonLdBlocks = await page.$$eval('script[type="application/ld+json"]', (nodes) =>
  nodes.map((node) => node.textContent ?? ""),
);

const jsonLdTypes: string[] = [];
for (const block of jsonLdBlocks) {
  try {
    const parsed: unknown = JSON.parse(block);
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const type = (item as { ["@type"]?: unknown })?.["@type"];
      if (type) jsonLdTypes.push(String(type));

      // Listing pages often wrap postings in an ItemList — the real type
      // (JobPosting) is one level down, inside itemListElement.
      const itemListElement = (item as { itemListElement?: unknown })?.itemListElement;
      if (Array.isArray(itemListElement)) {
        for (const element of itemListElement) {
          const nestedType =
            (element as { item?: { ["@type"]?: unknown } })?.item?.["@type"] ??
            (element as { ["@type"]?: unknown })?.["@type"];
          if (nestedType) jsonLdTypes.push(String(nestedType));
        }
      }
    }
  } catch {
    // Malformed JSON-LD still counts as "a block is present" for reporting.
  }
}

const jobHrefs = await page.$$eval('a[href*="/job/"]', (nodes) =>
  nodes.map((node) => node.getAttribute("href") ?? "").filter((href) => href.length > 0),
);
const uniqueJobHrefs = [...new Set(jobHrefs)];
const idPattern = /\/job\/(\d+)/;
const sampleIds = uniqueJobHrefs
  .map((href) => href.match(idPattern)?.[1])
  .filter((id): id is string => id !== undefined)
  .slice(0, 10);

await browser.close();

console.log("probe report");
console.log("============");
console.log(`url:                      ${SOURCE_URL}`);
console.log(`http status:              ${status}`);
console.log(`cf-ray present:           ${cfRay ? `yes (${cfRay})` : "no"}`);
console.log(
  `cf interstitial seen:     ${sawInterstitial ? (clearedAfterMs !== null ? `yes, cleared after ${clearedAfterMs}ms` : "yes, did NOT clear within 20s") : "no"}`,
);
console.log(`json-ld blocks found:     ${jsonLdBlocks.length}`);
console.log(`json-ld @types seen:      ${jsonLdTypes.length > 0 ? jsonLdTypes.join(", ") : "(none)"}`);
console.log(
  `has JobPosting JSON-LD:   ${jsonLdTypes.some((t) => t.includes("JobPosting")) ? "yes" : "no"}`,
);
console.log(`json endpoints observed:  ${jsonEndpoints.size}`);
for (const url of jsonEndpoints) console.log(`  - ${url}`);
console.log(`/job/<id> links found:    ${uniqueJobHrefs.length}`);
console.log(`sample hrefs:             ${uniqueJobHrefs.slice(0, 5).join(", ") || "(none)"}`);
console.log(`sample numeric ids:       ${sampleIds.join(", ") || "(none)"}`);
console.log(`wrote raw/probe.html and raw/probe.png`);
