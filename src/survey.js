#!/usr/bin/env node
// Sweep every product the DeFi surface exposes and record who can change the
// code behind each one.
//
// A single product's answer is a check. Every product's answer is a measurement
// of the platform, and that is a different kind of claim.

import { writeFileSync, mkdirSync } from "node:fs";
import { listInvestments, investmentInfo, previewDeposit } from "./baw.js";
import { mutability, controlChain, identify } from "./chain.js";

const CHAIN = "56";
const OUT = new URL("../data/", import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function surveyType(type, cap) {
  const list = await listInvestments(type, CHAIN, 100);
  if (!list.ok) {
    console.error(`${type}: ${list.error?.name}`);
    return [];
  }
  const items = list.data.list.slice(0, cap);
  const rows = [];

  for (const [n, inv] of items.entries()) {
    process.stderr.write(`\r  ${type} ${n + 1}/${items.length}   `);
    try {
      const info = await investmentInfo(inv.investmentId);
      let pool = info.ok ? info.data.poolAddress : null;
      let via = pool ? "listing" : null;

      // Lending products return poolAddress: null, so the only route to their
      // contract is a simulation, and a simulation needs the asset in hand. The
      // ones that resolve here are the ones this wallet happens to hold.
      if (!pool && info.ok) {
        const asset = info.data.assetTokenList?.[0]?.tokenAddress;
        if (asset) {
          const p = await previewDeposit(inv.investmentId, asset, 0.005, CHAIN);
          if (p.ok) {
            pool = p.data?.feeAndContract?.interactWith?.address ?? null;
            via = pool ? "simulation" : null;
          }
        }
      }
      const row = {
        type,
        protocol: inv.protocolName,
        asset: inv.investmentName,
        rate: Number(inv.apyBps) / 100,
        rateType: info.ok ? info.data.apyType : null,
        tvl: Number(inv.tvl),
        investable: info.ok ? info.data.investable : null,
        pool, via,
      };
      if (pool) {
        // Chain reads throw rather than returning a default, on purpose: a read
        // that failed is not an observation. But it must not take the listing
        // data down with it. Nine pools were recorded as publishing no address
        // when they publish one, because a transport error here discarded the
        // whole row and the summary then counted it as an absence.
        try {
          const m = await mutability(pool);
          row.isProxy = m.isProxy;
          row.implementation = m.implementation;
          const who = m.admin ?? m.beacon ?? m.owner;
          if (m.isProxy && who) {
            const c = await controlChain(who);
            row.controlEndsAt = c.endsAt?.address ?? null;
            row.controlKind = c.endsAt?.kind ?? null;
            row.controlHops = c.hops.length;
          } else if (m.isProxy) {
            row.controlKind = "unknown";
          }
        } catch (err) {
          row.chainError = err.message;
        }
      }
      rows.push(row);
    } catch (err) {
      // Keep what the listing already gave us. A row that could not be
      // completed is marked, so the summary can exclude it instead of
      // counting it as a negative finding.
      rows.push({
        type, protocol: inv.protocolName, asset: inv.investmentName,
        rate: Number(inv.apyBps) / 100, tvl: Number(inv.tvl),
        pool: null, via: null, error: err.message,
      });
    }
    await sleep(60);
  }
  process.stderr.write("\r");
  return rows;
}

const cap = Number(process.argv[2] ?? 100);
const rows = [
  ...await surveyType("Earn", cap),
  ...await surveyType("LiquidityPool", cap),
];

mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString();
writeFileSync(new URL("survey-latest.json", OUT),
  JSON.stringify({ generatedAt: stamp, chain: CHAIN, rows }, null, 2), "utf8");

// ---------------------------------------------------------------- summary

const complete = rows.filter((r) => !r.error);
const withPool = complete.filter((r) => r.pool);
const proxies = withPool.filter((r) => r.isProxy);
const byKind = (k) => proxies.filter((r) => r.controlKind === k);

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");
const usd = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
const tvlOf = (rs) => rs.reduce((s, r) => s + (r.tvl || 0), 0);

const byVia = (v) => withPool.filter((r) => r.via === v);
const lending = rows.filter((r) => r.type === "Earn");
const pools = rows.filter((r) => r.type === "LiquidityPool");

const failed = rows.length - complete.length;
const chainless = complete.filter((r) => r.chainError).length;

console.log(`\nSurveyed ${rows.length} products on chain ${CHAIN} at ${stamp}`);
console.log(`  ${lending.length} lending, ${pools.length} liquidity pools`);
// Stated rather than absorbed. A row that could not be read is not a row that
// read as no, and the difference has to survive into the summary.
if (failed) console.log(`  ${failed} could not be read at all and are excluded below`);
if (chainless) console.log(`  ${chainless} resolved an address but the chain read failed`);
console.log("");

console.log(`  contract address reachable   ${withPool.length}`);
console.log(`    from the listing           ${byVia("listing").length}  (all liquidity pools)`);
console.log(`    only via simulation        ${byVia("simulation").length}  (lending, needs the asset in hand)`);
console.log(`  of those, upgradeable        ${proxies.length}  (${pct(proxies.length, withPool.length)})`);
for (const t of ["LiquidityPool", "Earn"]) {
  const g = withPool.filter((r) => r.type === t);
  const p = g.filter((r) => r.isProxy);
  if (g.length) console.log(`    ${t.padEnd(14)} ${p.length}/${g.length} upgradeable (${pct(p.length, g.length)})`);
}
console.log(`  upgrade authority ends at:`);
for (const k of ["eoa", "timelock", "multisig", "contract", "unknown"]) {
  const rs = byKind(k);
  if (rs.length) console.log(`    ${k.padEnd(9)} ${String(rs.length).padStart(4)}   TVL ${usd(tvlOf(rs))}`);
}
const eoa = byKind("eoa");
if (eoa.length) {
  console.log(`\n  Single-key upgrade authority, largest first:`);
  for (const r of eoa.sort((a, b) => b.tvl - a.tvl).slice(0, 10)) {
    console.log(`    ${r.protocol} ${r.asset}  ${r.rate.toFixed(2)}%  TVL ${usd(r.tvl)}  key ${r.controlEndsAt}`);
  }
}
console.log(`\n  written to data/survey-latest.json`);
