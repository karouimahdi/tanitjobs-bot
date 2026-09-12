import { test } from "node:test";
import assert from "node:assert/strict";
import { DetailParseError, parseJobDetail } from "./detail.js";

// Synthetic fixture, NOT a captured TanitJobs page. The 2026-09-12
// `npm run probe` run against a real /job/<id> page returned a Cloudflare
// interstitial (raw/probe.html), so there is no clean capture to test
// against yet — see detail.ts's file header. This fixture instead exercises
// the parser against the public schema.org JobPosting shape it's actually
// written against, which is a documented spec, not a guess about TanitJobs'
// markup. Swap in a real capture once `npm run probe` gets past Cloudflare.
function fixtureHtml(jsonLd: Record<string, unknown>): string {
  return `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  </head><body><h1>${String(jsonLd["title"] ?? "")}</h1></body></html>`;
}

const VALID_JOB_POSTING = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Développeur Full Stack",
  description: "<p>Nous recherchons un <b>développeur</b>&nbsp;expérimenté.</p>",
  datePosted: "2026-09-10",
  hiringOrganization: { "@type": "Organization", name: "Acme Tunisie" },
  jobLocation: {
    "@type": "Place",
    address: {
      "@type": "PostalAddress",
      addressLocality: "Tunis",
      addressCountry: "TN",
    },
  },
};

test("detail: parses a full JobPosting JSON-LD block into a typed JobDetail", () => {
  const detail = parseJobDetail(fixtureHtml(VALID_JOB_POSTING));
  assert.deepEqual(detail, {
    title: "Développeur Full Stack",
    company: "Acme Tunisie",
    location: "Tunis, TN",
    description: "Nous recherchons un développeur expérimenté.",
    postedAt: "2026-09-10",
  });
});

test("detail: missing jobLocation yields a null location, not a thrown error", () => {
  const { jobLocation: _jobLocation, ...withoutLocation } = VALID_JOB_POSTING;
  const detail = parseJobDetail(fixtureHtml(withoutLocation));
  assert.equal(detail.location, null);
});

test("detail: missing datePosted yields a null postedAt, not a thrown error", () => {
  const { datePosted: _datePosted, ...withoutDate } = VALID_JOB_POSTING;
  const detail = parseJobDetail(fixtureHtml(withoutDate));
  assert.equal(detail.postedAt, null);
});

test("detail: a JobPosting missing required fields throws DetailParseError naming them", () => {
  const sparse = { "@context": "https://schema.org", "@type": "JobPosting", title: "Only a title" };
  assert.throws(
    () => parseJobDetail(fixtureHtml(sparse)),
    (error: unknown) => {
      assert.ok(error instanceof DetailParseError);
      assert.deepEqual(error.missingFields, ["company", "description"]);
      return true;
    },
  );
});

test("detail: no JobPosting JSON-LD at all throws, listing all required fields missing", () => {
  const html = "<!doctype html><html><body><h1>Just a moment...</h1></body></html>";
  assert.throws(
    () => parseJobDetail(html),
    (error: unknown) => {
      assert.ok(error instanceof DetailParseError);
      assert.deepEqual(error.missingFields, ["title", "company", "description"]);
      return true;
    },
  );
});

test("detail: a malformed JSON-LD script tag is skipped, not a thrown SyntaxError", () => {
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">{ not valid json </script>
    <script type="application/ld+json">${JSON.stringify(VALID_JOB_POSTING)}</script>
  </head><body></body></html>`;
  const detail = parseJobDetail(html);
  assert.equal(detail.title, "Développeur Full Stack");
});

test("detail: an ItemList-wrapped JobPosting (listing-page shape) is still found", () => {
  const wrapped = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: [{ "@type": "ListItem", position: 1, item: VALID_JOB_POSTING }],
  };
  const detail = parseJobDetail(fixtureHtml(wrapped));
  assert.equal(detail.title, "Développeur Full Stack");
});
