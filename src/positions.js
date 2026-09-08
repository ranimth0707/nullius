// What is held, and what it has earned.
//
// The position endpoint reports what is there now. It says nothing about what
// went in, so on its own it cannot answer the only question anyone actually
// asks. The deposit ledger supplies the other half: this program is the only
// thing that can move money here, so it is the only thing that knows the cost
// basis, and it writes one down every time it sends.

import { baw, INVEST_TYPES } from "./baw.js";
import { ledger } from "./execute.js";

/**
 * The set of investment IDs that transactions can actually be built against.
 *
 * Position queries cover more protocols than the transaction API does. A
 * position from one of the display-only protocols still comes back carrying
 * `investmentIds`, and those IDs are not usable — a build against them fails.
 * The docs are explicit that looking them up is the only way to tell the
 * difference (products/defi-api/supported-chains.md, "Position Coverage"), so
 * offering a withdraw button without doing that lookup is offering one that
 * breaks on press.
 */
async function tradableIds(chainId) {
  const ids = new Set();
  for (const t of INVEST_TYPES) {
    const r = await baw(["defi", "investment-list", "--investType", t,
                         "--binanceChainId", String(chainId), "--size", "100"]);
    if (!r.ok) return null; // Unknown is not the same as empty; say so upstream.
    for (const p of r.data?.list ?? []) ids.add(p.investmentId);
  }
  return ids;
}

/** Flatten the four-level position response into something reportable. */
export async function positions(chainId = "56") {
  const r = await baw(["defi", "position", "--binanceChainId", String(chainId)]);
  if (!r.ok) return { ok: false, error: r.error };
  const tradable = await tradableIds(chainId);

  const spent = new Map();   // investmentId -> units deposited
  const sent = new Map();    // investmentId -> number of deposits
  for (const e of ledger()) {
    if (e.action === "redeem" || !e.amount) continue;
    spent.set(e.investmentId, (spent.get(e.investmentId) ?? 0) + e.amount);
    sent.set(e.investmentId, (sent.get(e.investmentId) ?? 0) + 1);
  }

  const held = [];
  for (const p of r.data?.deFiProtocolVOList ?? []) {
    for (const pool of p.poolList ?? []) {
      for (const coll of pool.positionCollectionList ?? []) {
        for (const pos of coll.positionList ?? []) {
          const supply = pos.tokenList?.supply?.[0];
          if (!supply) continue;
          const investmentId = pos.investmentIds?.[0] ?? null;
          const now = Number(supply.tokenAmount);
          const basis = investmentId ? spent.get(investmentId) : undefined;

          held.push({
            protocol: p.protocolName,
            asset: supply.tokenSymbol ?? pos.underlyingAssetName,
            investmentId,
            tokenAddress: supply.tokenAddress,
            amount: now,
            price: Number(supply.tokenPrice ?? 0),
            valueUsd: now * Number(supply.tokenPrice ?? 0),
            poolType: pool.poolType,
            // Only claimed when this program made the deposits. A position opened
            // elsewhere has no basis here and saying otherwise would be a guess.
            basis: basis ?? null,
            deposits: investmentId ? (sent.get(investmentId) ?? 0) : 0,
            earned: basis !== undefined ? now - basis : null,
            // null means the lookup itself failed, which is not the same as
            // "not withdrawable" and must not be shown as either.
            withdrawable: tradable === null
              ? null
              : Boolean(investmentId && tradable.has(investmentId)),
          });
        }
      }
    }
  }
  return { ok: true, totalUsd: Number(r.data?.deFiTotalValue ?? 0), held };
}

/** Small numbers need many decimals before they stop reading as zero. */
export function formatEarned(earned, asset, price) {
  if (earned === null) return "no cost basis recorded";
  const usd = earned * (price || 0);
  const units = Math.abs(earned) < 1e-6 ? earned.toExponential(2) : earned.toFixed(9);
  const sign = earned >= 0 ? "+" : "";
  return `${sign}${units} ${asset} (${sign}$${Math.abs(usd) < 0.01 ? usd.toFixed(6) : usd.toFixed(2)})`;
}
