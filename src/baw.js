// Thin wrapper around the official Binance Agentic Wallet CLI (`baw`).
// Every call is read-only or a non-broadcasting preview. Nothing here signs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const READ_ONLY = new Set([
  "wallet", "defi", "approvals", "cli-check", "skill-check",
]);

/**
 * Invoke `baw` and parse its JSON envelope.
 * Returns { ok, data } on success or { ok:false, error:{code,name,message} }.
 * `baw` exits non-zero on API errors but still writes a JSON envelope to stdout,
 * so a thrown ExecFileError is not necessarily a transport failure.
 */
export async function baw(args, { timeoutMs = 60_000 } = {}) {
  if (!READ_ONLY.has(args[0])) {
    throw new Error(`refusing to run non-read-only baw command: ${args[0]}`);
  }
  const argv = [...args, "--json"];
  let stdout;
  try {
    ({ stdout } = await run("baw", argv, { timeout: timeoutMs }));
  } catch (err) {
    stdout = err?.stdout ?? "";
    if (!stdout) {
      return { ok: false, error: { name: "CLI_FAILURE", message: err?.message ?? String(err) } };
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: { name: "BAD_JSON", message: stdout.slice(0, 300) } };
  }
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: parsed.error ?? { name: "UNKNOWN" } };
}

export const walletStatus = () => baw(["wallet", "status"]);
export const walletSettings = () => baw(["wallet", "settings"]);

/** The surface exposes exactly two types; `Loan` is documented in --help but rejected. */
export const INVEST_TYPES = ["Earn", "LiquidityPool"];

export const listInvestments = (investType = "Earn", chainId = "56", size = 100) =>
  baw(["defi", "investment-list", "--investType", investType,
       "--binanceChainId", String(chainId), "--size", String(size)]);

export const listEarn = (chainId = "56", size = 100) =>
  listInvestments("Earn", chainId, size);

export const investmentInfo = (investmentId) =>
  baw(["defi", "investment-info", "--investmentId", investmentId]);

/**
 * Protocol detail: security score, six dimension scores, team, funding, FAQ.
 *
 * None of this appears in the investment listing, which is where a rate gets
 * chosen. Binance scores every protocol it lists and then shows the rate on its
 * own, so the score is a separate call nobody makes.
 *
 * Cached, because it is asked per product and answered per protocol. Screening
 * 48 products means 48 of these calls against 10 distinct protocols, at about a
 * second each, and the answer does not change between them.
 */
const protocolCache = new Map();

export function protocolInfo(defiProtocolId) {
  if (!protocolCache.has(defiProtocolId)) {
    const p = baw(["defi", "protocol-info", "--defiProtocolId", defiProtocolId])
      // A failed lookup must not be remembered as the answer forever.
      .then((r) => { if (!r.ok) protocolCache.delete(defiProtocolId); return r; })
      .catch((e) => { protocolCache.delete(defiProtocolId); throw e; });
    protocolCache.set(defiProtocolId, p);
  }
  return protocolCache.get(defiProtocolId);
}

/** Simulate a deposit. Does NOT broadcast — this is what reveals `interactWith`. */
export const previewDeposit = (investmentId, tokenAddress, amount, chainId = "56") =>
  baw(["defi", "preview", "--action", "deposit",
       "--investmentId", investmentId, "--tokenAddress", tokenAddress,
       "--amount", String(amount), "--binanceChainId", String(chainId)]);

/** Simulate a full exit. Used only to probe whether the exit path exists. */
export const previewRedeem = (investmentId, tokenAddress, chainId = "56") =>
  baw(["defi", "preview", "--action", "redeem",
       "--investmentId", investmentId, "--tokenAddress", tokenAddress,
       "--ratio", "1", "--binanceChainId", String(chainId)]);

/**
 * Simulate adding liquidity.
 *
 * `lp-add` takes one token and one amount, but the wallet debits BOTH pool
 * tokens — it does not swap the input into the pair. The second requirement is
 * never stated up front; attempting the simulation is what discloses it.
 */
export const previewLpAdd = (investmentId, tokenAddress, amount, priceRangePct = 5, chainId = "56") =>
  baw(["defi", "preview", "--action", "lp-add",
       "--investmentId", investmentId, "--tokenAddress", tokenAddress,
       "--amount", String(amount), "--priceRange", String(priceRangePct),
       "--binanceChainId", String(chainId)]);
