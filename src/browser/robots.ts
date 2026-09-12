// robots.txt fetch, cache, and enforcement. Cached inside the same
// sources/tanitjobs doc already read once per cycle for the circuit breaker
// (db/repo.ts), so honoring robots.txt costs zero extra reads in the
// steady-state budget.

import { Timestamp } from "firebase-admin/firestore";
import { RESPECT_ROBOTS, SOURCE_URL, USER_AGENT } from "../config.js";
import { getSourceState, updateSourceState } from "../db/repo.js";

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The bare product token ("tanitjobs-bot") — robots.txt User-agent lines
// match against this, not the full UA string with the contact address.
const PRODUCT_TOKEN = (USER_AGENT.split("/")[0] ?? "*").toLowerCase();

interface RobotsGroup {
  agents: string[];
  disallow: string[];
  sawDirective: boolean;
}

// Standard robots.txt grouping: consecutive `User-agent:` lines share one
// group until the first real directive (Disallow/Allow/etc) closes it: the
// next User-agent line after that starts a new group.
export function parseRobotsTxt(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.split("#")[0]?.trim() ?? "")
    .filter((line) => line.length > 0);

  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;

  for (const line of lines) {
    const sepIndex = line.indexOf(":");
    if (sepIndex === -1) continue;
    const key = line.slice(0, sepIndex).trim().toLowerCase();
    const value = line.slice(sepIndex + 1).trim();

    if (key === "user-agent") {
      if (!current || current.sawDirective) {
        current = { agents: [], disallow: [], sawDirective: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === "disallow" && current) {
      current.sawDirective = true;
      if (value) current.disallow.push(value);
    } else if (current) {
      current.sawDirective = true; // Allow, Crawl-delay, Sitemap, etc.
    }
  }

  const matching = groups.filter((g) => g.agents.includes(PRODUCT_TOKEN));
  const wildcard = groups.filter((g) => g.agents.includes("*"));
  const chosen = matching.length > 0 ? matching : wildcard;

  return chosen.flatMap((g) => g.disallow);
}

// Google's robots.txt extensions: `*` is a wildcard, a trailing `$` anchors
// the end of the URL. Everything else in a rule is a literal path prefix.
export function isPathDisallowed(disallowRules: string[], path: string): boolean {
  return disallowRules.some((rule) => matchesRule(rule, path));
}

function matchesRule(rule: string, path: string): boolean {
  const endAnchored = rule.endsWith("$");
  const body = endAnchored ? rule.slice(0, -1) : rule;
  const escaped = body.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`));
  const pattern = new RegExp(`^${escaped}${endAnchored ? "$" : ""}`);
  return pattern.test(path);
}

async function fetchAndParse(baseUrl: string): Promise<string[]> {
  const robotsUrl = new URL("/robots.txt", baseUrl).toString();
  const response = await fetch(robotsUrl, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) return []; // no robots.txt at all => nothing disallowed
  return parseRobotsTxt(await response.text());
}

// The one function collector code should call. Returns [] (nothing
// disallowed) when RESPECT_ROBOTS=false — that env var exists for local
// one-off probing only; CLAUDE.md hard invariant keeps it true in production.
export async function getDisallowRules(): Promise<string[]> {
  if (!RESPECT_ROBOTS) return [];

  const { robots } = await getSourceState();
  const fetchedAt = robots?.fetchedAt;
  const isFresh = fetchedAt !== null && fetchedAt !== undefined && Date.now() - fetchedAt.toMillis() < CACHE_MAX_AGE_MS;
  if (robots && isFresh) return robots.disallow;

  const disallow = await fetchAndParse(SOURCE_URL);
  await updateSourceState({ robots: { fetchedAt: Timestamp.now(), disallow } });
  return disallow;
}

export function isAllowed(disallowRules: string[], path: string): boolean {
  return !isPathDisallowed(disallowRules, path);
}
