// The preflight itself.
//
// Design rule: FAIL CLOSED. A check that cannot be completed is never treated as
// permission. "We could not verify this" and "this is fine" are different answers,
// and only one of them lets a deposit through.

import { investmentInfo, protocolInfo, previewDeposit, previewRedeem, previewLpAdd } from "./baw.js";
import { identify, poolPair, mutability, controlChain } from "./chain.js";
import { matchPool, apyHistory, normaliseSymbol } from "./llama.js";
import { classify, FINDING } from "./refusal.js";

export const BLOCK = "BLOCK";
export const WARN = "WARN";
export const PASS = "PASS";
/**
 * Distinct from BLOCK on purpose. UNTESTED means the check never ran — most often
 * because the wallet does not hold the asset, so no simulation is possible. That
 * still prevents a GO (fail closed), but calling it a failure of the product
 * would be a lie about what was observed.
 */
export const UNTESTED = "UNTESTED";

/**
 * `consequence` is the check in the reader's terms: what could actually happen
 * to their money if this finding matters. The rest of a result explains what
 * was observed, which turns out not to be the same thing as explaining what it
 * means. A report can be entirely accurate and still leave someone unable to
 * answer the only question they came with.
 *
 * It comes in two lengths because a report nobody finishes reading protects
 * nobody. `brief` is one line and is what gets shown; `full` is there for
 * anyone who asks for it.
 */
const result = (id, level, title, detail, evidence = null, consequence = null) =>
  ({ id, level, title, detail, evidence, consequence });

/** Pair a one-line consequence with the long form behind it. */
const risk = (brief, full) => ({ brief, full });

const alnum = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** 1st, 2nd, 3rd, 4th. Everything in this report is read by a person. */
export function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** Distinctive word from a protocol name, used to look for it on-chain. */
function protocolToken(protocolName) {
  const first = String(protocolName ?? "").trim().split(/\s+/)[0] ?? "";
  return alnum(first);
}

// ---------------------------------------------------------------- checks

/** 1. Is the product still open for deposits, or has it been delisted? */
export async function checkListing(investmentId) {
  const r = await investmentInfo(investmentId);
  if (!r.ok) {
    return result("listing", BLOCK, "Cannot read product status",
      `investment-info failed: ${r.error?.name ?? "unknown"}`, r.error);
  }
  const { investable, protocolName, investmentName, apyDisplay, tvl } = r.data;
  if (investable === false) {
    // defi.md already requires this: on investable:false an agent "MUST refuse
    // new deposit / lp-add requests". The rule exists; nothing enforces it.
    return result("listing", BLOCK, "Product is delisted",
      `${protocolName} ${investmentName} still appears in the listing at ${apyDisplay}, ` +
      `but no longer accepts deposits.`, r.data);
  }
  if (investable !== true) {
    return result("listing", BLOCK, "Deposit status unknown",
      "The API did not state whether this product accepts deposits.", r.data);
  }
  return result("listing", PASS, "Product accepts deposits",
    `${protocolName} ${investmentName} — ${apyDisplay}, reported TVL $${Number(tvl).toLocaleString("en-US")}`,
    r.data);
}

/** 2. Simulate without broadcasting. This is what reveals the real contract. */
export async function checkSimulation(investmentId, tokenAddress, amount, chainId) {
  const r = await previewDeposit(investmentId, tokenAddress, amount, chainId);
  if (!r.ok) {
    // A refused preview is not automatically a finding. Most refusals are about
    // the wallet, not the product; only a genuine rejection of the deposit is
    // evidence against it. See refusal.js for how that line was drawn.
    const c = classify(r.error);
    const level = c.kind === FINDING ? BLOCK : UNTESTED;
    return { ...result("simulate", level, c.title, c.detail, r.error), minimum: c.minimum ?? null };
  }
  const target = r.data?.feeAndContract?.interactWith?.address ?? null;
  if (!target) {
    return result("simulate", BLOCK, "Simulation revealed no contract",
      "The preview succeeded but named no contract to interact with, so there is " +
      "nothing to verify against the chain.", r.data);
  }
  const fee = r.data?.feeAndContract?.estimatedNetworkFee;
  // defi.md: "Surface ALL warnings to the user before they confirm." The field
  // was empty in all six previews that succeeded during the survey, so this path
  // is untested against real data — but a warning that arrives and is dropped is
  // worse than one that never comes.
  const warned = r.data?.warnings ?? [];
  if (warned.length) {
    return result("simulate", WARN, "Simulated, with warnings from the wallet",
      `Would interact with ${target}. The wallet attached ${warned.length} warning` +
      `${warned.length > 1 ? "s" : ""}: ` +
      warned.map((w) => (typeof w === "string" ? w : (w?.message ?? JSON.stringify(w)))).join("; "),
      r.data);
  }
  return result("simulate", PASS, "Simulated without broadcasting",
    `Would interact with ${target} — network fee ≈ $${Number(fee?.valueUsd ?? 0).toFixed(4)}`,
    r.data);
}

/**
 * 12. What does Binance itself think of this protocol?
 *
 * `protocol-info` carries a security score and a six-dimension breakdown, and
 * none of it is anywhere near the screen where a rate gets picked. It is a
 * second opinion from the venue that is listing the product, which is worth
 * having precisely because it is not our opinion.
 *
 * A missing score is not a low one, and is not reported as though it were —
 * but a protocol the venue has not scored is a different proposition from one
 * it has scored well, and the difference should not be invisible.
 */
export async function checkProtocolScore(investment, info) {
  const id = info?.defiProtocolId ?? investment?.defiProtocolId ?? null;
  if (!id) return result("score", UNTESTED, "No protocol to look up",
    "The product did not name a protocol, so no score could be fetched.");

  const r = await protocolInfo(id);
  if (!r.ok) {
    const c = classify(r.error);
    return result("score", UNTESTED, "Protocol score unavailable", c.detail, r.error);
  }
  const score = r.data?.securityScore;
  const name = r.data?.protocolName ?? id;
  if (score === null || score === undefined) {
    return result("score", WARN, "Binance publishes no security score for this protocol",
      `${name} is listed and investable, but carries no security score — while the other ` +
      `protocols in the same list do. Nothing here says it is unsafe; it says the venue has ` +
      `not published a judgement, and the listing looks identical either way.`, r.data,
      risk("Binance has not published a security judgement on this protocol.",
        "Every other protocol in the same list carries a score. This one does not, and the " +
        "listing looks identical either way. That is an absence of judgement, not a bad one."));
  }
  const dims = r.data?.dimensionScores ?? {};
  const weakest = Object.entries(dims)
    .map(([k, v]) => [k, Number(v)])
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => a[1] - b[1])[0];
  const readable = weakest
    ? `${weakest[0].replace(/([A-Z])/g, " $1").toLowerCase().trim()} ${weakest[1].toFixed(0)}`
    : null;

  if (Number(score) < 70) {
    return result("score", WARN, `Binance scores this protocol ${Number(score).toFixed(2)}`,
      `${name} sits below 70 on Binance's own security score` +
      (readable ? `, weakest on ${readable}` : "") + `.`, r.data,
      risk(`Binance's own score for this protocol is below the bar the others clear.`,
        `${name} scores ${Number(score).toFixed(2)} where the rest of the list sits in the 80s ` +
        `and 90s` + (readable ? `, and its weakest dimension is ${readable}` : "") + `.`));
  }
  return result("score", PASS, `Binance scores this protocol ${Number(score).toFixed(2)}`,
    `${name} is scored ${Number(score).toFixed(2)} by the venue listing it` +
    (readable ? `; its lowest dimension is ${readable}` : "") + `.`, r.data);
}

/**
 * 11. Can the money come back out on demand?
 *
 * A rate is only half a product; the other half is how long it takes to leave.
 * Some protocols hold a redemption for days before it can be claimed, and the
 * listing shows the same shape of row either way — one number, no mention of a
 * queue. The delay is only reported on the redeem build response, which cannot
 * be reached before there is a position to redeem, so at deposit time the
 * documented set is the only source there is.
 *
 * Named in products/defi-api/supported-chains.md, "Current Limitations".
 */
const DELAYED_EXIT = new Set(["helio", "astherus"]);

export function checkExitDelay(investment, info, observed = null) {
  const id = info?.defiProtocolId ?? investment?.defiProtocolId ?? null;
  const name = info?.protocolName ?? investment?.protocolName ?? "This protocol";
  if (!id) {
    return result("exitdelay", UNTESTED, "Exit speed unknown",
      "The product did not report which protocol it belongs to, so the withdrawal delay " +
      "could not be looked up.");
  }

  // Having withdrawn from this product before beats anything that can be
  // inferred about the protocol it belongs to.
  if (observed) {
    const days = observed.days.filter(Boolean);
    const when = String(observed.at).slice(0, 10);
    if (!days.length) {
      return result("exitdelay", PASS, "Withdrawal is immediate",
        `A withdrawal from this product on ${when} reported no waiting period, so the funds ` +
        `land as soon as the transaction confirms.`, { observed: observed.days });
    }
    const span = days[0] === days[days.length - 1] ? `${days[0]} days` : `${days[0]} to ${days[days.length - 1]} days`;
    return result("exitdelay", WARN, `Withdrawal takes ${span}`,
      `A withdrawal from this product on ${when} reported a waiting period of ${span}. The ` +
      `redemption is submitted first and the money is claimed after the wait.`,
      { observed: observed.days },
      risk(`Your money takes ${span} to come back, not minutes.`,
        `Withdrawing is two steps. If the market turns, or you simply need the cash, you are ` +
        `committed for ${span} from the moment you ask to leave.`));
  }

  if (DELAYED_EXIT.has(id)) {
    // Deliberately weaker than it used to be. Binance names this protocol as one
    // that can queue redemptions, and the old wording turned that into a claim
    // that this product does. A Lista USDT withdrawal came back instant, so the
    // claim was simply wrong, and warning on every product under a protocol is
    // the fastest way to teach someone to ignore the warnings.
    return result("exitdelay", WARN, "Withdrawal might be queued",
      `Binance names ${name} among the protocols that can hold a redemption before the funds ` +
      `are claimable. Whether this particular product does is not published anywhere, and it ` +
      `is only reported on the withdrawal itself, which cannot be simulated without already ` +
      `holding a position. Some products under ${name} pay out instantly.`,
      { defiProtocolId: id, certain: false },
      risk("Might not pay out the same day, and there is no way to know until you withdraw.",
        `${name} is named by Binance as a protocol that can queue redemptions, but the delay ` +
        `belongs to the product rather than the protocol and is only reported when you ` +
        `actually withdraw. I will show you the number the moment it comes back, and ` +
        `remember it for next time.`));
  }
  return result("exitdelay", PASS, "Withdrawal is immediate",
    `${name} credits redeemed funds as soon as the transaction confirms, with no waiting period.`,
    { defiProtocolId: id });
}

/** 3. Ask the chain what that contract actually is. */
export async function checkIdentity(target, claim) {
  let onchain;
  try {
    onchain = await identify(target);
  } catch (err) {
    return result("identity", BLOCK, "Chain unreachable",
      `Could not verify the contract independently: ${err.message}`);
  }
  if (!onchain.isContract) {
    return result("identity", BLOCK, "Target holds no code",
      `${target} is not a deployed contract on this chain.`, onchain);
  }
  // A pool names no name(), but it does say which two tokens it holds. Check the
  // advertised pair against what the pool actually contains.
  if (!onchain.name && !onchain.symbol) {
    const pair = await poolPair(target);
    if (pair) {
      const want = String(claim.investmentName ?? "").toUpperCase().split(/[-\/]/)
        .map((s) => alnum(s.replace(/^BSC_/, ""))).filter(Boolean);
      const got = [pair.token0, pair.token1].map((t) => alnum(t.symbol ?? ""));
      const seen = `${pair.token0.symbol ?? "?"} and ${pair.token1.symbol ?? "?"}`;
      const matched = want.filter((w) =>
        got.some((g) => g === w || g === `W${w}` || w === `W${g}` || g.includes(w)));
      if (matched.length === want.length && want.length > 0) {
        return result("identity", PASS, "Pool contents confirmed on-chain",
          `The pool at ${target} holds ${seen}, which is the pair the listing advertises.`, pair);
      }
      return result("identity", BLOCK, "Pool holds different tokens",
        `The listing advertises ${claim.investmentName}, but the pool at ${target} holds ` +
        `${seen}.`, pair);
    }
  }
  if (!onchain.name && !onchain.symbol) {
    return result("identity", UNTESTED, "Contract does not name itself",
      `${target} holds code but exposes no name() or symbol(), so its identity could not be ` +
      `confirmed this way. It was not shown to be wrong — it could not be read.`, onchain);
  }
  const hay = alnum(`${onchain.name ?? ""}${onchain.symbol ?? ""}`);
  const wantProto = protocolToken(claim.protocolName);
  // Deliberately the raw asset name: the WBNB/BTCB aliasing exists to match a
  // third-party index, and applying it here would fail a correct vBNB contract.
  const wantAsset = alnum(String(claim.investmentName ?? "").replace(/^BSC_/i, ""));

  const protoOk = wantProto.length >= 3 && hay.includes(wantProto);
  const assetOk = wantAsset.length >= 2 && hay.includes(wantAsset);

  const seen = `"${onchain.name ?? "?"}" (${onchain.symbol ?? "?"})`;

  // The asset is the part that must match. Being handed a different token than
  // the one advertised is a straight mismatch and nothing explains it away.
  if (!assetOk && !protoOk) {
    return result("identity", BLOCK, "Contract holds a different asset",
      `The listing advertises ${claim.protocolName} ${claim.investmentName}, but the contract ` +
      `the deposit would enter calls itself ${seen}, which matches neither.`, onchain);
  }

  // A different protocol name usually means a curated vault: the listing names
  // whoever provides the lending infrastructure, while the contract names
  // whoever actually manages the risk. Four products listed as Lista resolve to
  // RockawayX, Gauntlet and Pangolins vaults. That is worth knowing and is not
  // in itself wrong, so it is surfaced rather than refused. Refusing it while
  // letting through contracts that say nothing at all had it backwards: this one
  // tells us exactly what we are entering.
  if (!protoOk) {
    return result("identity", WARN, "Run by someone other than the listed protocol",
      `The listing says ${claim.protocolName}. The contract calls itself ${seen}. That is the ` +
      `pattern of a curated vault, where the listing names the lending protocol and the contract ` +
      `names the curator who actually sets the risk policy. Your money answers to the second one, ` +
      `and the listing never mentions them.`, onchain,
      risk(`${seen.split(" (")[0].replace(/"/g, "")} decides what your money is lent against, not ${claim.protocolName}.`,
        `Your deposit does not sit still. It is lent out, and someone decides what it may be lent ` +
        `against, at what ratio, and priced by which oracle. Here that someone is the curator, not ` +
        `${claim.protocolName}. If those limits are set loosely and borrowers default while their ` +
        `collateral is falling, the vault takes the loss and your deposit does not come back whole. ` +
        `Any score or reputation you are relying on belongs to ${claim.protocolName}, and does not ` +
        `cover the curator's decisions.`));
  }
  if (!assetOk) {
    return result("identity", WARN, "Asset naming differs on-chain",
      `Protocol confirmed as ${claim.protocolName}, but the contract calls the asset ${seen} ` +
      `rather than ${claim.investmentName}. Wrapper naming often differs; worth an eye.`, onchain);
  }
  return result("identity", PASS, "Contract confirmed on-chain",
    `Chain reports ${seen} — consistent with ${claim.protocolName} ${claim.investmentName}.`,
    onchain);
}

/**
 * 4. Can the code be swapped after it has been checked?
 *
 * Confirming what a contract calls itself is worth little on its own. If it sits
 * behind a proxy, the bytecode verified at deposit time is not necessarily the
 * bytecode running at withdrawal time, and whoever holds the admin key decides
 * that. This is the difference between a contract that cannot change and one that
 * merely has not changed yet, and it is a far better reason to hesitate than a
 * missing name().
 */
export async function checkMutability(target) {
  let m;
  try {
    m = await mutability(target);
  } catch (err) {
    return result("mutability", UNTESTED, "Could not read the contract's storage",
      `The chain did not answer: ${err.message}`);
  }
  if (!m.isProxy) {
    return result("mutability", PASS, "Code cannot be swapped",
      `${target} holds its own logic. What was verified here is what runs, and nobody can ` +
      `replace it.`, m);
  }
  const who = m.admin ?? m.beacon ?? m.owner;
  const chain = who ? await controlChain(who).catch(() => null) : null;
  const end = chain?.endsAt;

  const trail = chain?.hops?.length
    ? ` Upgrade authority runs ${chain.hops.map((h) => `${h.address} (${h.kind})`).join(" → ")}.`
    : "";

  // One private key at the end of the chain is the shape that took $5m out of
  // Wasabi Protocol in April 2026 and $285m out of Drift, in both cases without
  // the proxy address ever changing.
  if (end?.kind === "eoa") {
    return result("mutability", BLOCK, "One key can replace this code",
      `${target} is a proxy, and upgrade authority ends at ${end.address}, an ordinary wallet ` +
      `rather than a timelock or multisig. Whoever holds that key can swap the code behind this ` +
      `address without the address changing.${trail}`, { ...m, chain });
  }
  if (end?.kind === "timelock") {
    return result("mutability", WARN, "Code can be replaced, but not instantly",
      `${target} is a proxy. Upgrade authority ends at a timelock with a ` +
      `${end.minDelaySeconds}s delay, so a change is visible before it takes effect.${trail}`,
      { ...m, chain },
      risk("The code can still be replaced, but you get warning first.",
        "The code holding your money can still be replaced, but not without warning. The delay is " +
        "the window in which you could get out first, and it only helps if someone is watching."));
  }
  return result("mutability", WARN, "Code can be replaced",
    `${target} forwards to ${m.implementation ?? "a beacon-supplied implementation"}, and that ` +
    `target can be changed. What was confirmed above is what runs today, not necessarily what ` +
    `runs when the money comes back out.${trail}`, { ...m, chain },
    risk("One keyholder can swap the code holding your money, without warning.",
      "Whoever holds that key can swap the code holding your money, without asking and without " +
      "warning, including for code that moves it somewhere else. Nothing here says they will. " +
      "It says your deposit is protected by trust in that keyholder rather than by the code " +
      "just verified, and that this is the mechanism behind several of the largest losses in DeFi."));
}

/** 5. Does the simulated swap of value conserve value? */
export function checkValue(preview) {
  const changes = preview?.balanceChange ?? [];
  if (changes.length < 2) {
    return result("value", WARN, "Value change not comparable",
      "The simulation did not return both sides of the balance change.");
  }
  const out = changes.filter((c) => Number(c.amount) < 0)
    .reduce((s, c) => s + Number(c.valueUsd ?? 0), 0);
  const into = changes.filter((c) => Number(c.amount) > 0)
    .reduce((s, c) => s + Number(c.valueUsd ?? 0), 0);
  if (out <= 0) {
    return result("value", WARN, "No outgoing value found", "Could not measure value leakage.");
  }
  const slipPct = ((out - into) / out) * 100;
  if (slipPct > 1) {
    return result("value", BLOCK, "Value lost in the simulated deposit",
      `Sending $${out.toFixed(2)} would return a position worth $${into.toFixed(2)} ` +
      `(${slipPct.toFixed(2)}% lost before fees).`);
  }
  return result("value", PASS, "Value is conserved",
    `$${out.toFixed(2)} in → $${into.toFixed(2)} of position (${slipPct >= 0 ? "" : "+"}` +
    `${(-slipPct).toFixed(2)}% difference).`);
}

/**
 * 5. Can the money get back out?
 *
 * Probed by simulating a full exit. With no position open, a supported product
 * answers INVESTMENT_NO_POSITION — it reached the position check, which means the
 * exit path itself is wired up. This is a structural check, not a guarantee that
 * a future exit will succeed under all market conditions.
 */
export async function checkExit(investmentId, tokenAddress, chainId) {
  const r = await previewRedeem(investmentId, tokenAddress, chainId);
  if (r.ok) {
    return result("exit", PASS, "Exit path is open", "A full exit simulated cleanly.");
  }
  if (r.error?.name === "INVESTMENT_NO_POSITION") {
    return result("exit", PASS, "Exit path exists",
      "Exit reached the position check (no position held yet), so the withdraw path is wired up.",
      r.error);
  }
  // A withdrawal that never got an answer is not a withdrawal that failed.
  const c = classify(r.error);
  return result("exit", c.kind === FINDING ? BLOCK : UNTESTED,
    c.kind === FINDING ? "Exit path could not be confirmed" : "Exit path not confirmed",
    c.detail, r.error);
}

/**
 * 6. Is today's rate normal for this pool, or bait?
 *
 * A rate far above a pool's own multi-year record is the classic trap: a
 * temporary incentive, a thin market, or a depeg already underway.
 */
export async function checkHistory(investment) {
  const m = await matchPool(investment);
  const apy = Number(investment.apyBps) / 100;

  if (m.status === "no_record") {
    return result("history", WARN, "No independent record of this pool",
      `No third-party record exists for ${investment.protocolName} ${investment.investmentName}, ` +
      `so today's ${apy.toFixed(2)}% cannot be compared against any history.`, null,
      risk("Nothing outside Binance confirms this rate is normal.",
        "No independent source tracks this product, so there is no way to tell whether today's " +
        "rate is its usual one or a number that will not last."));
  }
  if (m.status === "ambiguous") {
    const closest = apy - m.err;
    // Records the fact that the protocol and asset were found even though the
    // exact pool was not, because those are different degrees of ignorance.
    return result("history", WARN, "Cannot tell which pool this is",
      `${m.candidates} independent pool${m.candidates === 1 ? "" : "s"} carry this protocol and ` +
      `asset, and none advertises a matching rate. The nearest is ${closest.toFixed(2)}% against ` +
      `the listed ${apy.toFixed(2)}% (${m.err.toFixed(2)}pp apart). Which pool a deposit would ` +
      `enter cannot be established, so its history cannot be read.`,
      { recognised: true, candidates: m.candidates },
      risk("Which pool your money enters cannot be pinned down, so its history cannot be read.",
        "The protocol and asset are recognised independently, but several pools carry them and " +
        "none advertises a matching rate. Without knowing which one this is, there is no record " +
        "to check today's rate against."));
  }
  const h = await apyHistory(m.pool.pool, apy);
  if (!h) {
    return result("history", WARN, "Not enough history",
      `Matched ${m.pool.project}, but its record is too short to judge today's rate.`, null,
      risk("Too new to tell whether this rate holds.",
        "The pool was identified, but it has not existed long enough for its rate history to " +
        "say anything about whether today's number is sustainable."));
  }
  const ev = { ...h, project: m.pool.project, poolId: m.pool.pool, tvlUsd: m.pool.tvlUsd };
  if (h.ratioToMedian !== null && h.ratioToMedian >= 3 && h.percentile >= 0.95) {
    return result("history", WARN, "Rate is far above this pool's own history",
      `Today's ${apy.toFixed(2)}% is ${h.ratioToMedian.toFixed(1)}× the pool's median ` +
      `(${h.median.toFixed(2)}%) across ${h.samples} days since ${h.from}, and higher than ` +
      `${(h.percentile * 100).toFixed(0)}% of its record. Rates this far above a pool's own ` +
      `baseline are usually temporary incentives or a market under stress.`, ev,
      risk("This rate is far above its own normal and is unlikely to last.",
        "Rates this far above a pool's own baseline are usually a temporary incentive or a " +
        "market under stress. Depositing on the strength of the headline number means expecting " +
        "something the pool has almost never paid."));
  }
  return result("history", PASS, "Rate is normal for this pool",
    `${apy.toFixed(2)}% sits at the ${ordinal(Math.round(h.percentile * 100))} percentile of ` +
    `${h.samples} days of record (median ${h.median.toFixed(2)}%) since ${h.from}.`, ev);
}

/**
 * 8. For liquidity pools: what else does this take?
 *
 * `lp-add` accepts one token and one amount, but the wallet debits both pool
 * tokens and does not swap the input into the pair. Nothing states the second
 * requirement in advance — the simulation is what discloses it, either as a
 * second debit in `balanceChange` or as the address in an insufficient-balance
 * error. Either way the user asked to spend one asset and would spend two.
 */
export async function checkPairing(investment, tokenAddress, amount, chainId) {
  const r = await previewLpAdd(investment.investmentId, tokenAddress, amount, 5, chainId);

  if (!r.ok) {
    const m = /Insufficient balance for (0x[0-9a-fA-F]{40}): required ([0-9.]+)/.exec(
      r.error?.message ?? "");
    if (m) {
      const [, addr, need] = m;
      let named = addr;
      try {
        const id = await identify(addr);
        if (id.symbol || id.name) named = `${id.name ?? id.symbol} (${id.symbol ?? "?"})`;
      } catch { /* fall back to the bare address */ }
      const isInput = addr.toLowerCase() === String(tokenAddress).toLowerCase();
      return result("pairing", isInput ? UNTESTED : BLOCK,
        isInput ? "Not simulated — asset not held" : "Deposit also requires a second asset",
        isInput
          ? `The wallet does not hold enough of the named asset to simulate this.`
          : `Adding ${amount} of the named token also requires ${need} of ${named}, which the ` +
            `command never mentions and the wallet does not hold. One asset was asked for; two ` +
            `would be spent.`, r.error);
    }
    return result("pairing", UNTESTED, "Liquidity add not simulated",
      `${r.error?.name}: ${r.error?.message}`, r.error);
  }

  const debits = (r.data?.balanceChange ?? []).filter((c) => Number(c.amount) < 0);
  if (debits.length > 1) {
    const list = debits.map((d) => `${Math.abs(Number(d.amount))} ${d.tokenSymbol}`).join(" and ");
    return result("pairing", WARN, "Deposit draws on two assets",
      `The command names one token, but the simulation debits ${list}.`, r.data);
  }
  return result("pairing", PASS, "Only the named asset is drawn",
    "The simulation debits nothing beyond the token given.", r.data);
}

/**
 * 9. Is the advertised rate the kind of number it looks like?
 *
 * Earn reports APY, liquidity pools report APR, and both land in one sortable
 * list. An APR on a concentrated-liquidity position is an annualised fee rate:
 * it is not a return anyone receives, and it says nothing about impermanent
 * loss. Ranking the two together is a comparison that does not hold.
 */
export function checkRateType(investment, info) {
  const type = info?.apyType ?? null;
  const rate = Number(investment.apyBps) / 100;
  if (investment.investType !== "LiquidityPool" && info?.investType !== "LiquidityPool") {
    return result("ratetype", PASS, "Rate is a yield",
      `Reported as ${type ?? "APY"} — a return, comparable with other ${type ?? "APY"} figures.`);
  }
  return result("ratetype", WARN, "Rate is a fee rate, not a yield",
    `Reported as ${type ?? "APR"} at ${rate.toLocaleString("en-US")}%. On a concentrated-liquidity ` +
    `position that is an annualised trading-fee rate — not a return received, and blind to ` +
    `impermanent loss. It cannot be compared against the APY figures on lending products.`, null,
    risk("This number is a trading fee rate, not money you receive.",
      "On a concentrated-liquidity position the advertised figure annualises trading fees. It " +
      "is not a return anyone is paid, and it takes no account of impermanent loss, so it " +
      "cannot be compared against the APY on a lending product."));
}

/** 7. Is the pool big enough to absorb this deposit? */
export function checkCapacity(depositUsd, poolTvlUsd) {
  if (!poolTvlUsd || poolTvlUsd <= 0 || !depositUsd) {
    return result("capacity", WARN, "Pool size unknown",
      "Could not establish independent pool size, so deposit impact is unknown.", null,
      risk("Unknown whether your deposit is large enough to move the rate it was chosen for.",
        "Pool size could not be established independently, so there is no way to tell whether " +
        "this deposit is small enough to leave the advertised rate intact."));
  }
  const share = depositUsd / poolTvlUsd;
  const pct = (share * 100).toFixed(2);
  if (share > 0.05) {
    return result("capacity", BLOCK, "Deposit is too large for this pool",
      `$${depositUsd.toFixed(2)} would be ${pct}% of a $${Math.round(poolTvlUsd).toLocaleString("en-US")} ` +
      `pool. A share this size moves the rate it was chosen for.`);
  }
  return result("capacity", PASS, "Pool can absorb this deposit",
    `$${depositUsd.toFixed(2)} is ${pct}% of a $${Math.round(poolTvlUsd).toLocaleString("en-US")} pool.`);
}

// ---------------------------------------------------------------- pipeline

/** The native-coin sentinel address used by the wallet for BNB. */
export const NATIVE_BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/**
 * Screen a product without spending or holding anything.
 *
 * Two different questions were tangled together here. "Is this product what it
 * claims to be" can be answered from the listing and the chain alone. "Is it
 * safe to deposit this amount right now" needs a simulation, and a simulation
 * needs the asset in hand. Folding them together meant every product the wallet
 * could not afford came back refused, which is useless for choosing anything.
 *
 * Screening answers the first question only, and says so.
 */
export async function screen({ investment, chainId = "56", observedDelay = null }) {
  const checks = [];
  const listing = await checkListing(investment.investmentId);
  checks.push(listing);
  checks.push(checkRateType(investment, listing.evidence));
  checks.push(checkExitDelay(investment, listing.evidence, observedDelay));

  const pool = listing.evidence?.poolAddress ?? null;
  const [identity, mut, hist] = await Promise.all([
    pool
      ? checkIdentity(pool, investment)
      : Promise.resolve(result("identity", UNTESTED, "No published contract",
          "This product publishes no pool address, so it can only be identified by simulating a " +
          "deposit, which needs the asset in hand.")),
    pool ? checkMutability(pool) : Promise.resolve(null),
    checkHistory(investment),
  ]);
  checks.push(await checkProtocolScore(investment, listing.evidence));
  checks.push(identity);
  if (mut) checks.push(mut);
  checks.push(hist);

  const blocked = checks.filter((c) => c.level === BLOCK).length;
  const untested = checks.filter((c) => c.level === UNTESTED).length;
  return {
    mode: "screen",
    verdict: blocked === 0 && untested === 0 ? "VERIFIED" : "UNVERIFIED",
    reason: blocked > 0 ? "failed" : untested > 0 ? "unverified" : "clear",
    blocked, untested,
    warned: checks.filter((c) => c.level === WARN).length,
    checks,
  };
}

/** Run every check. Returns { verdict, checks } with verdict GO or NO-GO. */
export async function preflight({ investment, tokenAddress, amount, chainId = "56",
                                  observedDelay = null }) {
  const checks = [];
  const investmentId = investment.investmentId;

  const listing = await checkListing(investmentId);
  checks.push(listing);

  // The deposit asset is only exposed by investment-info, never by the listing.
  const token = tokenAddress
    ?? listing.evidence?.assetTokenList?.[0]?.tokenAddress
    ?? (String(investment.investmentName).toUpperCase() === "BNB" ? NATIVE_BNB : null);

  if (!token) {
    checks.push(result("simulate", BLOCK, "No deposit asset exposed",
      "Neither the listing nor the product detail named an asset address to deposit."));
    return { verdict: "NO-GO", blocked: 2, warned: 0, checks };
  }

  const isLp = (investment.investType ?? listing.evidence?.investType) === "LiquidityPool";
  checks.push(checkRateType(investment, listing.evidence));
  checks.push(checkExitDelay(investment, listing.evidence, observedDelay));

  // A liquidity add is a different transaction from a deposit — `preview --action
  // deposit` is not valid for a pool — so LP products are simulated through
  // lp-add, and that same simulation stands in for the deposit step.
  let sim;
  if (isLp) {
    const pairing = await checkPairing(investment, token, amount, chainId);
    checks.push(pairing);
    // The pairing probe is the simulation for a pool. Only record a separate
    // simulation entry when it actually produced one, otherwise the same failure
    // gets reported twice under two different names.
    sim = pairing.level === PASS || pairing.level === WARN
      ? result("simulate", PASS, "Simulated without broadcasting",
          `Liquidity add simulated; would interact with ` +
          `${pairing.evidence?.feeAndContract?.interactWith?.address ?? "an unnamed contract"}.`,
          pairing.evidence)
      : null;
  } else {
    sim = await checkSimulation(investmentId, token, amount, chainId);
  }
  if (sim) checks.push(sim);
  else sim = { level: UNTESTED, evidence: null };

  // The exit probe and the rate history do not depend on the simulation, so they
  // run alongside the identity lookup rather than queueing behind it. On a chat
  // front end that is the difference between a wait and an abandonment.
  // Liquidity pools publish poolAddress in investment-info, so their contract can
  // go straight to the chain without holding either asset. Lending products return
  // null there and the simulation is the only way to reach the address.
  const target = sim.evidence?.feeAndContract?.interactWith?.address
    ?? listing.evidence?.poolAddress
    ?? null;

  const [identity, exit, hist] = await Promise.all([
    target
      ? checkIdentity(target, investment)
      : Promise.resolve(result("identity", sim.level === UNTESTED ? UNTESTED : BLOCK,
          "Contract never revealed",
          "The listing publishes no pool address and the deposit could not be simulated, so " +
          "there is nothing to put to the chain.")),
    checkExit(investmentId, token, chainId),
    checkHistory(investment),
  ]);
  checks.push(await checkProtocolScore(investment, listing.evidence));
  checks.push(identity);
  if (target) checks.push(await checkMutability(target));
  if (sim.level === PASS && target) checks.push(checkValue(sim.evidence));
  checks.push(exit, hist);

  const depositUsd = sim.level === PASS
    ? Math.abs((sim.evidence.balanceChange ?? [])
        .filter((c) => Number(c.amount) < 0)
        .reduce((s, c) => s + Number(c.valueUsd ?? 0), 0))
    : null;
  checks.push(checkCapacity(depositUsd, hist.evidence?.tvlUsd));

  corroborate(checks);

  const blocked = checks.filter((c) => c.level === BLOCK).length;
  const untested = checks.filter((c) => c.level === UNTESTED).length;
  return {
    // Fail closed: an unverified position is refused whether the check failed
    // or merely never ran.
    verdict: blocked === 0 && untested === 0 ? "GO" : "NO-GO",
    reason: blocked > 0 ? "failed" : untested > 0 ? "unverified" : "clear",
    blocked,
    untested,
    warned: checks.filter((c) => c.level === WARN).length,
    checks,
  };
}

/**
 * Let other evidence stand in when name() is missing.
 *
 * name() and symbol() are optional in ERC20 and plenty of serious contracts
 * skip them. Treating their absence as "unverifiable" refused Lista at 1.50%,
 * a protocol holding $724m behind a timelock-governed proxy, and handed back
 * Venus at 0.07% instead. Twenty-one times less yield on the strength of a
 * missing optional method is not caution, it is a bad rule.
 *
 * Identity by name is one route, not the only one. When the chain confirms the
 * code cannot be swapped by a single key, and an independent source recognises
 * the same protocol, asset and rate, that is corroboration from two directions
 * that do not depend on Binance or on each other. It is weaker than reading the
 * name, so it downgrades to a warning rather than a pass, and the deposit
 * proceeds with the reason stated.
 */
function corroborate(checks) {
  const at = (id) => checks.find((c) => c.id === id);
  const identity = at("identity");
  if (!identity || identity.level !== UNTESTED) return;
  if (identity.title !== "Contract does not name itself") return;

  const mut = at("mutability");
  const hist = at("history");

  // Either the code cannot change at all, or changing it takes a timelock rather
  // than one signature. An unresolved admin is not good enough here: not knowing
  // who holds the key is the situation this whole check exists to flag.
  const governed = mut && (mut.level === PASS || mut.title?.includes("not instantly"));

  // Recognised by someone independent. An exact rate match pins the specific
  // pool, which is ideal, but finding the protocol and asset at all still
  // establishes that this is a real thing other people track. Only a complete
  // absence of records counts as unknown.
  const known = hist && (hist.level === PASS || hist.evidence?.recognised === true);

  if (!governed || !known) return;

  identity.level = WARN;
  identity.title = "Identity corroborated, not read directly";
  identity.detail =
    `${identity.evidence?.address ?? "The contract"} implements no name() or symbol(), which is ` +
    `permitted and common. Two independent sources agree on what it is instead: the chain shows ` +
    `its code cannot be replaced by any single key, and third-party records list this protocol, ` +
    `asset and rate. Weaker than reading the name off the contract, and enough to proceed on.`;
}
