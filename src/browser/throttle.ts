// Jitter for the inter-request delay. The cycle-interval floor (never
// faster than every 5 minutes, default ~15) is enforced by
// .github/workflows/collect.yml's cron plus its `concurrency` guard, not
// here — this file only jitters the pause *between* requests inside one
// cycle's ~3-request budget.

const DEFAULT_BASE_DELAY_MS = 1500;
const DEFAULT_JITTER_RATIO = 0.4;

export function jitteredDelayMs(
  baseMs: number = Number(process.env["REQUEST_DELAY_MS"] ?? DEFAULT_BASE_DELAY_MS),
  jitterRatio = DEFAULT_JITTER_RATIO,
): number {
  const spread = baseMs * jitterRatio;
  const offset = (Math.random() * 2 - 1) * spread; // uniform in [-spread, +spread]
  return Math.max(0, Math.round(baseMs + offset));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function throttledPause(): Promise<void> {
  await sleep(jitteredDelayMs());
}
