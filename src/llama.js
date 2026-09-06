// Independent yield history from DefiLlama.
//
// Used for one question only: is today's advertised APY normal for THIS pool,
// or is it an outlier against the pool's own multi-year record? A rate far above
// a pool's own history is the classic bait pattern — it is usually a temporary
// incentive, a thin market, or a depeg in progress.

const POOLS_URL = "https://yields.llama.fi/pools";
const CHART_URL = (id) => `https://yields.llama.fi/chart/${id}`;

// Binance `defiProtocolId` -> DefiLlama `project` prefixes.
// Verified against the live DefiLlama BSC project list.
const PROTOCOL_MAP = {
  aave3: ["aave-v3"],
  helio: ["lista-"],           // Binance still uses Lista's former name internally
  venus: ["venus-core", "venus-flux"],
  venusflux: ["venus-flux", "venus-core"],
  solv: ["solv-"],
  astherus: ["aster"],         // not present on DefiLlama BSC at time of writing
};

/**
 * The two sources spell the same asset differently. Left unnormalised, this
 * silently produces "no independent record exists", which is a far more
 * alarming conclusion than the truth (a naming difference).
 */
export function normaliseSymbol(sym) {
  if (!sym) return "";
  let s = String(sym).toUpperCase().replace(/^BSC_/, "");
  const alias = { BNB: "WBNB", BTC: "BTCB" };
  return alias[s] ?? s;
}

let poolCache = null;

export async function loadPools({ chain = "BSC", timeoutMs = 30_000 } = {}) {
  if (!poolCache) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(POOLS_URL, { signal: ac.signal });
      poolCache = (await res.json()).data ?? [];
    } finally {
      clearTimeout(t);
    }
  }
  return poolCache.filter((p) => p.chain === chain);
}

/**
 * Resolve a Binance investment to its DefiLlama counterpart.
 *
 * Matching is on APY agreement only. TVL is deliberately NOT used: the two
 * sources define it differently, and many entries agree on APY to three decimal
 * places while differing 40-80% on TVL.
 *
 * The 0.10pp tolerance is not a guess. The distribution of best-match APY error
 * is bimodal — a tight cluster at <=0.042pp, a gap, then a spread from 0.130pp.
 * Any threshold inside that gap yields an identical result.
 */
export const APY_TOLERANCE_PP = 0.10;

export async function matchPool(investment, { chain = "BSC" } = {}) {
  const pools = await loadPools({ chain });
  const wantSym = normaliseSymbol(investment.investmentName);
  const keys = PROTOCOL_MAP[investment.defiProtocolId] ?? [investment.defiProtocolId];
  const apy = Number(investment.apyBps) / 100;

  const candidates = pools.filter(
    (p) =>
      normaliseSymbol(p.symbol) === wantSym &&
      keys.some((k) => (p.project ?? "").includes(k)),
  );
  if (candidates.length === 0) {
    return { status: "no_record", candidates: 0 };
  }
  let best = null;
  for (const p of candidates) {
    const err = Math.abs((p.apy ?? 0) - apy);
    if (!best || err < best.err) best = { err, pool: p };
  }
  return best.err <= APY_TOLERANCE_PP
    ? { status: "matched", pool: best.pool, err: best.err, candidates: candidates.length }
    : { status: "ambiguous", err: best.err, candidates: candidates.length };
}

/** Where today's APY sits inside this pool's own historical distribution. */
export async function apyHistory(poolId, currentApy, { timeoutMs = 30_000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let rows;
  try {
    const res = await fetch(CHART_URL(poolId), { signal: ac.signal });
    rows = (await res.json()).data ?? [];
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
  const series = rows.map((r) => r.apy).filter((v) => typeof v === "number");
  if (series.length < 30) return null;

  const sorted = [...series].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const below = sorted.filter((v) => v <= currentApy).length;

  return {
    samples: series.length,
    from: rows[0]?.timestamp?.slice(0, 10) ?? null,
    median: at(0.5),
    p90: at(0.9),
    max: sorted[sorted.length - 1],
    percentile: below / sorted.length,
    ratioToMedian: at(0.5) > 0 ? currentApy / at(0.5) : null,
  };
}
