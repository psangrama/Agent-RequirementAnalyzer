// Pure helpers for the web server: run titles, model guidance with rough cost/time estimates, item history.

export { friendlyTitle, runDate } from '../src/runs.js';

// USD per million tokens (input/output) from Anthropic's published list prices, and an assumed output
// speed. The speeds are rough planning numbers, not guarantees; the page labels everything "rough".
const TIERS = [
  { family: 'fable', label: 'Fable', inUsd: 10, outUsd: 50, tps: 40, speed: 'slowest', pick: 'Hardest or most ambiguous documents' },
  { family: 'opus', label: 'Opus', inUsd: 4, outUsd: 20, tps: 60, speed: 'slow', pick: 'Long or complex documents' },
  { family: 'sonnet', label: 'Sonnet', inUsd: 2, outUsd: 10, tps: 90, speed: 'medium', pick: 'Best balance for most documents' },
  { family: 'haiku', label: 'Haiku', inUsd: 1, outUsd: 5, tps: 150, speed: 'fastest', pick: 'Short, clear documents; quickest and cheapest' },
];
// Haiku 5.5 is cheaper than Haiku 4.5, so it needs its own prices.
const HAIKU_55 = { inUsd: 0.1, outUsd: 0.5, tps: 200 };

export function tierFor(id) {
  const tier = TIERS.find((t) => id.includes(t.family));
  if (!tier) return null;
  return /haiku-5/.test(id) ? { ...tier, ...HAIKU_55 } : tier;
}

/**
 * The few models worth recommending, in order, picked from what the key can use.
 * `available` is the list from the Models API (or the built-in list when offline).
 */
export function recommended(available) {
  const out = [];
  for (const t of TIERS) {
    const m = available.find((x) => x.id.includes(t.family));
    if (!m) continue;
    const tier = tierFor(m.id);
    out.push({ id: m.id, name: m.display_name || m.id, family: t.family, speed: tier.speed, pick: t.pick, inUsd: tier.inUsd, outUsd: tier.outUsd });
  }
  // Best balance first, then the others by capability.
  const order = ['sonnet', 'opus', 'haiku', 'fable'];
  return out.sort((a, b) => order.indexOf(a.family) - order.indexOf(b.family));
}

/** Rough cost and time for turning a document of `bytes` into a backlog. Always a range. */
export function estimate({ bytes, ext, maxTokens = 32000 }, models) {
  const textual = ['.md', '.html', '.htm'].includes(ext);
  const inTokens = Math.round((textual ? bytes / 4 : bytes / 12) + 1500); // PDFs/Word files are mostly not text
  const outTokens = Math.min(maxTokens, Math.max(3000, Math.round(inTokens * 0.9)));
  return models.map((m) => {
    const tier = tierFor(m.id);
    const cost = (i, o) => (i * tier.inUsd + o * tier.outUsd) / 1e6;
    const lo = cost(inTokens, outTokens * 0.6), hi = cost(inTokens, Math.min(maxTokens, outTokens * 1.6));
    return {
      id: m.id,
      costLow: lo, costHigh: hi,
      secsLow: Math.round((outTokens * 0.6) / tier.tps) + 5, secsHigh: Math.round((Math.min(maxTokens, outTokens * 1.6)) / tier.tps) + 10,
    };
  });
}

/** Versions of one item, oldest first, keeping only the versions where that item actually changed. */
export function itemTimeline(versions, id, canon) {
  const out = [];
  let prev;
  for (const v of versions) {
    const item = v.items.find((i) => i.id === id);
    if (!item) continue;
    const key = canon(item);
    if (key !== prev) out.push({ version: v.version, item });
    prev = key;
  }
  return out;
}
