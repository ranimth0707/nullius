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

const run = promisify(execFile);

/** Pending intents, minted on a clear preflight and burned on use. */
const intents = new Map();
const TTL_MS = 5 * 60_000;

/**
 * Record an approved deposit and return the nonce that unlocks it.
 * Called only after `preflight` returns GO.
 */
export function stage({ investmentId, tokenAddress, amount, chainId = "56", label, ownerId }) {
  const nonce = randomBytes(9).toString("base64url");
  intents.set(nonce, {
    investmentId, tokenAddress, amount, chainId, label, ownerId,
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

  const argv = ["defi", "deposit",
    "--investmentId", intent.investmentId,
    "--tokenAddress", intent.tokenAddress,
    "--amount", String(intent.amount),
    "--binanceChainId", String(intent.chainId),
    "--json"];

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
  return parsed.success
    ? { ok: true, data: parsed.data, intent }
    : { ok: false, error: parsed.error ?? { name: "UNKNOWN" }, intent };
}
