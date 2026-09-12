// Shared, hosting-agnostic config read from env. Values here are not
// secrets — the actual secrets (tokens, keys) stay in .env / GitHub repo
// secrets and are read directly where they're used (db/repo.ts, notify/send.ts).

export const SOURCE_URL = process.env["TANITJOBS_URL"] ?? "https://www.tanitjobs.com/";

// Honest UA with a contact address — CLAUDE.md "Collector rules". Anyone
// operating TanitJobs who wants this traffic gone can just email me.
export const USER_AGENT =
  process.env["USER_AGENT"] ??
  "tanitjobs-bot/0.1 (+personal job-alert monitor; contact: karouimahdi08@gmail.com)";

// Never flip this off in code — CLAUDE.md hard invariant. The env var exists
// only so a local one-off probe run can be told to skip robots caching, not
// so the collector can ignore robots.txt in production.
export const RESPECT_ROBOTS = process.env["RESPECT_ROBOTS"] !== "false";
