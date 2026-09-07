#!/usr/bin/env node
// The watchtower.
//
// Detecting that a contract is upgradeable says a deposit could go wrong. It
// does not say anything went wrong. Wasabi Protocol lost $5m on 30 April 2026
// not because its vaults sat behind proxies, which hundreds of protocols do
// safely, but because the implementation behind those proxies was replaced at a
// particular moment. The proxy addresses never changed, so everything checking
// by address kept reporting that all was well.
//
// This records what each address currently forwards to and shouts when that
// moves. It needs no wallet and no Binance account: once the watchlist exists,
// the check is a public RPC read, which is why it can run anywhere, including in
// CI on a schedule.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { mutability, controlChain } from "./chain.js";

const DIR = new URL("../data/", import.meta.url);
const WATCHLIST = new URL("watchlist.json", DIR);
const STATE = new URL("implementations.json", DIR);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lower = (s) => (s ? String(s).toLowerCase() : null);

/** Build the watchlist from a survey run. Needs baw; done once, then committed. */
export function buildWatchlist(surveyPath = new URL("survey-latest.json", DIR)) {
  const survey = JSON.parse(readFileSync(surveyPath, "utf8"));
  // Keyed on the address, because that is the thing being watched. Protocol and
  // asset are not unique: Lista runs two separate BNB lending products at
  // different rates and different contracts, and keying on their names made each
  // overwrite the other and report a change on every pass.
  const seen = new Map();
  for (const r of survey.rows) {
    if (!r.pool) continue;
    const address = lower(r.pool);
    if (!seen.has(address)) {
      seen.set(address, {
        id: address, address,
        protocol: r.protocol, asset: r.asset, type: r.type, via: r.via,
      });
    }
  }
  // A stable order keeps the diff about the chain rather than about ordering.
  const entries = [...seen.values()].sort((a, b) => a.address.localeCompare(b.address));

  mkdirSync(DIR, { recursive: true });
  writeFileSync(WATCHLIST, JSON.stringify({ chain: "56", entries }, null, 2) + "\n", "utf8");
  return entries;
}

/** Current implementation and upgrade authority for one address, RPC only. */
async function look(address) {
  const m = await mutability(address);
  const out = {
    isProxy: m.isProxy,
    implementation: lower(m.implementation),
    admin: lower(m.admin ?? m.beacon ?? m.owner),
  };
  if (m.isProxy && out.admin) {
    // No catch. If the chain of authority cannot be read, this whole observation
    // is discarded upstream and the previous one carried forward, rather than
    // recording a gap that will look like a change on the next pass.
    const c = await controlChain(out.admin);
    out.controlEndsAt = lower(c?.endsAt?.address);
    out.controlKind = c?.endsAt?.kind ?? null;
  }
  return out;
}

export async function run({ quiet = false } = {}) {
  if (!existsSync(WATCHLIST)) {
    console.error("No watchlist. Run `npm run survey` first, then `node src/watch.js --build`.");
    process.exit(2);
  }
  const { entries } = JSON.parse(readFileSync(WATCHLIST, "utf8"));
  const before = existsSync(STATE)
    ? JSON.parse(readFileSync(STATE, "utf8"))
    : { observations: {} };

  const observations = {};
  const changes = [];

  for (const [n, e] of entries.entries()) {
    if (!quiet) process.stderr.write(`\r  ${n + 1}/${entries.length}   `);
    let now;
    try {
      now = await look(e.address);
    } catch {
      // A read that failed is not an observation. Carry the last known state
      // forward rather than recording a change that did not happen.
      if (before.observations[e.id]) observations[e.id] = before.observations[e.id];
      continue;
    }
    observations[e.id] = { address: e.address, ...now };

    const was = before.observations[e.id];
    if (!was) continue;
    for (const field of ["implementation", "admin", "controlEndsAt", "isProxy"]) {
      if (was[field] !== now[field] && (was[field] ?? null) !== (now[field] ?? null)) {
        changes.push({ id: e.id, protocol: e.protocol, asset: e.asset,
                       field, from: was[field] ?? null, to: now[field] ?? null });
      }
    }
    await sleep(40);
  }
  if (!quiet) process.stderr.write("\r");

  // No timestamp in here on purpose. A "last checked at" field changes on every
  // pass, so the file would differ every time and the scheduled job would commit
  // a new time every four hours whether or not anything happened. Then a real
  // change is one commit among hundreds of empty ones. The commit date already
  // records when it was checked; this file records only what was seen, so a diff
  // here means something actually moved.
  const state = { chain: "56", watching: entries.length, observations };
  writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n", "utf8");

  return { changes, watching: entries.length, firstRun: !existsSync(STATE) || !Object.keys(before.observations).length };
}

// ---------------------------------------------------------------- cli

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--build")) {
    const e = buildWatchlist();
    console.log(`Watchlist written: ${e.length} addresses.`);
    process.exit(0);
  }
  const { changes, watching, firstRun } = await run();

  if (firstRun) {
    console.log(`\nBaseline recorded for ${watching} addresses. Nothing to compare against yet.\n`);
    process.exit(0);
  }
  if (!changes.length) {
    console.log(`\nWatching ${watching} addresses. Nothing moved.\n`);
    process.exit(0);
  }
  console.log(`\n${changes.length} change(s) across ${watching} watched addresses:\n`);
  for (const c of changes) {
    console.log(`  ${c.protocol} ${c.asset}`);
    console.log(`    ${c.field}: ${c.from ?? "none"}`);
    console.log(`             -> ${c.to ?? "none"}`);
  }
  console.log(`\nThe address did not change. What runs behind it did.\n`);
  // Non-zero so a scheduled run is visibly red rather than quietly green.
  process.exit(1);
}
