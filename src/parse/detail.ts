// Detail-page parser. JSON-LD first, CSS selectors only as fallback —
// CLAUDE.md: "Boards maintain JSON-LD for Google Jobs indexing far more
// carefully than their markup."
//
// The CSS fallback below is deliberately unimplemented, not guessed. The
// last `npm run probe` capture of a real page (raw/probe.html, 2026-09-12)
// is a Cloudflare interstitial, not TanitJobs markup — CLAUDE.md is explicit
// that selectors come from reading a real probe capture, "never guess."
// Until a clean capture exists, a JSON-LD gap is a parse failure, not a
// guessed-selector value that could be silently wrong forever. Replace
// `cssFallback` from a real raw/probe.html once one exists; don't fill it in
// from assumptions about how TanitJobs' markup "probably" looks.
//
// The schema.org JobPosting shape itself is not a guess — it's the public
// spec boards use for Google Jobs indexing, independent of any one site's
// markup, so parsing against it here is safe.

export interface JobDetail {
  title: string;
  company: string;
  location: string | null;
  description: string;
  postedAt: string | null;
}

const REQUIRED_FIELDS = ["title", "company", "description"] as const;

export class DetailParseError extends Error {
  readonly missingFields: string[];

  constructor(missingFields: string[]) {
    super(`detail parse failed: missing ${missingFields.join(", ")}`);
    this.name = "DetailParseError";
    this.missingFields = missingFields;
  }
}

interface PartialJobDetail {
  title?: string;
  company?: string;
  location?: string | null;
  description?: string;
  postedAt?: string | null;
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

interface JsonLdAddress {
  addressLocality?: unknown;
  addressRegion?: unknown;
  addressCountry?: unknown;
}

function joinLocation(address: JsonLdAddress | undefined): string | null {
  if (!address) return null;
  const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
    .map((part) => (typeof part === "object" && part !== null ? (part as { name?: unknown }).name : part))
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

function extractJsonLdBlocks(html: string): unknown[] {
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks: unknown[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(match[1] ?? ""));
    } catch {
      // Malformed block — one bad script tag shouldn't fail the whole parse.
    }
  }
  return blocks;
}

function findJobPosting(blocks: unknown[]): Record<string, unknown> | null {
  for (const block of blocks) {
    for (const item of Array.isArray(block) ? block : [block]) {
      const record = item as Record<string, unknown>;
      if (record?.["@type"] === "JobPosting") return record;

      // Listing-page-style ItemList wrapping, in case a detail page ever
      // nests it the same way probe.ts found on the listing page.
      const itemListElement = record?.["itemListElement"];
      if (Array.isArray(itemListElement)) {
        for (const element of itemListElement) {
          const nested = (element as Record<string, unknown>)?.["item"] as
            | Record<string, unknown>
            | undefined;
          if (nested?.["@type"] === "JobPosting") return nested;
        }
      }
    }
  }
  return null;
}

function fromJsonLd(html: string): PartialJobDetail {
  const posting = findJobPosting(extractJsonLdBlocks(html));
  if (!posting) return {};

  const hiringOrganization = posting["hiringOrganization"] as Record<string, unknown> | undefined;
  const jobLocation = posting["jobLocation"] as Record<string, unknown> | undefined;
  const address = jobLocation?.["address"] as JsonLdAddress | undefined;
  const description = asString(posting["description"]);

  return {
    title: asString(posting["title"]),
    company: asString(hiringOrganization?.["name"]),
    location: joinLocation(address) ?? undefined,
    description: description ? stripHtml(description) : undefined,
    postedAt: asString(posting["datePosted"]) ?? undefined,
  };
}

// Placeholder on purpose — see file header. Returns nothing until a real
// probe capture exists to write real selectors against.
function cssFallback(_html: string): PartialJobDetail {
  return {};
}

export function parseJobDetail(html: string): JobDetail {
  const fromLd = fromJsonLd(html);
  const fallback = cssFallback(html);
  const merged: PartialJobDetail = { ...fallback, ...fromLd };

  const missingFields = REQUIRED_FIELDS.filter((field) => merged[field] === undefined);
  if (missingFields.length > 0) throw new DetailParseError(missingFields);

  return {
    title: merged.title as string,
    company: merged.company as string,
    location: merged.location ?? null,
    description: merged.description as string,
    postedAt: merged.postedAt ?? null,
  };
}
