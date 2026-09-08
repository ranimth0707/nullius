// The only path in this codebase that can move money.
//
// It is deliberately not in baw.js. That wrapper refuses anything outside a
// read-only allowlist, and everything the model can reach goes through it. This
// file is reachable only by presenting a nonce that was minted server-side after
// a preflight came back clear. The model never sees a nonce and cannot produce
// one, so "the model decided to deposit" is not a state this program has.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const run = promisify(execFile);

const LEDGER = new URL("../data/deposits.json", import.meta.url);

/**
 * Everything this program has actually sent.
 *
 * Returns cannot be worked out from the position alone: it reports what is there
 * now, not what went in. Since this file is the only place a deposit can be made
 * from, it is also the only place that knows the cost basis, so it writes one
 * down.
 */
export function ledger() {
  if (!existsSync(LEDGER)) return [];
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8"));
  } catch {
    return [];
  }
}

function record(entry) {
  const all = ledger();
  all.push(entry);
  mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(all, null, 2) + "\n", "utf8");
}

/** Pending intents, minted on a clear preflight and burned on use. */
const intents = new Map();
const TTL_MS = 5 * 60_000;

/**
 * Record an approved deposit and return the nonce that unlocks it.
 * Called only after `preflight` returns GO.
 */
export function stage({ investmentId, tokenAddress, amount, chainId = "56", label, ownerId,
                        action = "deposit", ratio }) {
  const nonce = randomBytes(9).toString("base64url");
  intents.set(nonce, {
    action, investmentId, tokenAddress, amount, ratio, chainId, label, ownerId,
    at: Date.now(),
  });
  return nonce;
}

export function peek(nonce) {
  const i = intents.get(nonce);
  if (!i) return null;
  if (Date.now() - i.at > TTL_MS) { intents.delete(nonce); return null; }
  return i;
}

/**
 * Execute a staged deposit. Broadcasts.
 *
 * `ownerId` must match whoever staged it, so a nonce leaked into a group chat
 * is useless to anyone else. The intent is burned before the call goes out, so a
 * double tap cannot deposit twice.
 */
export async function commit(nonce, ownerId) {
  const intent = peek(nonce);
  if (!intent) return { ok: false, error: { name: "EXPIRED", message: "Nothing staged, or it expired." } };
  if (String(intent.ownerId) !== String(ownerId)) {
    return { ok: false, error: { name: "NOT_YOURS", message: "That confirmation is not yours." } };
  }
  intents.delete(nonce);

  // Withdrawing takes a ratio of the position rather than an amount of the asset.
  const argv = intent.action === "redeem"
    ? ["defi", "redeem",
       "--investmentId", intent.investmentId,
       "--tokenAddress", intent.tokenAddress,
       "--ratio", String(intent.ratio ?? 1),
       "--binanceChainId", String(intent.chainId), "--json"]
    : ["defi", "deposit",
       "--investmentId", intent.investmentId,
       "--tokenAddress", intent.tokenAddress,
       "--amount", String(intent.amount),
       "--binanceChainId", String(intent.chainId), "--json"];

  let stdout;
  try {
    ({ stdout } = await run("baw", argv, { timeout: 120_000 }));
  } catch (err) {
    stdout = err?.stdout ?? "";
    if (!stdout) return { ok: false, error: { name: "CLI_FAILURE", message: err?.message ?? String(err) } };
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: { name: "BAD_JSON", message: stdout.slice(0, 300) } };
  }
  if (!parsed.success) return { ok: false, error: parsed.error ?? { name: "UNKNOWN" }, intent };

  record({
    at: new Date().toISOString(),
    action: intent.action,
    investmentId: intent.investmentId,
    label: intent.label,
    amount: intent.action === "redeem" ? null : Number(intent.amount),
    ratio: intent.action === "redeem" ? Number(intent.ratio ?? 1) : null,
    txHash: parsed.data?.txHash ?? null,
    // Only redeem carries this, and only for protocols that queue redemptions.
    // An empty array means the funds land as soon as the tx confirms; anything
    // else means a second step later, which the caller has to be told about.
    redeemDelayDays: parsed.data?.redeemDelayDays ?? null,
  });
  return { ok: true, data: parsed.data, intent };
}
