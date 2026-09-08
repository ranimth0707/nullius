// What a refused simulation actually means.
//
// Every failed preview used to be reported the same way: "Simulation refused",
// followed by whatever string came back. That reads as a finding about the
// product, and most of the time it is nothing of the sort. Across 144 deposit
// previews run against every Earn and LiquidityPool product on BSC, 101 of the
// refusals were the wallet not holding the token, one was a minimum deposit,
// and 43 were a parameter this program had failed to supply. None of those is
// evidence about the product, and presenting them as refusals is how a screen
// ends up looking like it distrusts everything.
//
// The official error table says to branch on the code rather than the message
// (products/defi-api/error-codes.md). The CLI does not expose those numeric
// codes. It returns its own `name`, which is stable and usually enough — with
// one exception worth knowing about: `SERVICE_ERROR` is not a service error. It
// is the bucket the CLI puts ordinary business rejections in, so a minimum
// deposit and a missing tick range both arrive under it. That one has to be
// read from the message.

/** A refusal is either evidence about the product, or it is not. */
export const FINDING = "FINDING";     // the product itself refused; worth reporting
export const CONDITION = "CONDITION"; // a requirement of the product, not a fault
export const CALLER = "CALLER";       // this program asked wrongly
export const TRANSPORT = "TRANSPORT"; // the request never got a real answer

const MINIMUM = /(?:less than|below) minimum\s+([\d.]+)/i;
const TICK = /tick range is required|nftId|priceRange/i;
const NOT_LP = /is not a LP investment|not an? LP/i;

/**
 * Classify a `baw` error envelope.
 *
 * Returns `{ kind, title, detail, retryable, minimum }`. `minimum` is set only
 * when the product stated one, in the asset's own units.
 */
export function classify(error, { asset = "the asset" } = {}) {
  const name = String(error?.name ?? "UNKNOWN");
  const msg = String(error?.message ?? "");

  if (name === "INSUFFICIENT_BALANCE") {
    // The wallet's holdings are not a property of the product. Binance's own
    // table says an insufficient balance surfaces as a simulation revert rather
    // than a structured code, which is exactly why it is easy to mistake for one.
    const held = msg.match(/available\s+(\S+)\s+balance is\s+([\d.]+)/i);
    return {
      kind: CONDITION, retryable: false, minimum: null,
      title: `Nothing to simulate with — no ${held?.[1] ?? asset} held`,
      detail: `Checking a deposit means simulating one, and simulating one needs the asset in ` +
              `hand. The wallet holds ${held?.[2] ?? "none"} ${held?.[1] ?? asset}. This says ` +
              `nothing about the product; it only means the contract behind it stayed hidden.`,
    };
  }

  if (name === "INVESTMENT_NO_POSITION") {
    return {
      kind: CONDITION, retryable: false, minimum: null,
      title: "Exit not simulated — nothing held here yet",
      detail: "The withdrawal path can only be simulated against a position that exists.",
    };
  }

  // Everything below arrives as SERVICE_ERROR, whatever it actually is.
  const min = msg.match(MINIMUM);
  if (min) {
    return {
      kind: CONDITION, retryable: false, minimum: Number(min[1]),
      title: `Below the minimum deposit of ${min[1]}`,
      detail: `This product will not accept less than ${min[1]}. The listing does not mention ` +
              `a minimum; the simulation is what discloses it.`,
    };
  }

  if (TICK.test(msg) || NOT_LP.test(msg)) {
    return {
      kind: CALLER, retryable: false, minimum: null,
      title: "Not simulated — wrong call shape",
      detail: `This program did not supply what the product needs to be simulated: ${msg}. ` +
              `That is a fault here, not a finding about the product.`,
    };
  }

  if (name === "CLI_FAILURE" || name === "BAD_JSON" ||
      /rate limit|timed? out|temporarily unavailable|internal error|RPC/i.test(msg)) {
    return {
      kind: TRANSPORT, retryable: true, minimum: null,
      title: "No answer from the wallet service",
      detail: `The request did not complete: ${name}. A missing answer is not an observation, ` +
              `so nothing is claimed either way.`,
    };
  }

  // What is left is the product, or the chain, actually rejecting the deposit.
  return {
    kind: FINDING, retryable: false, minimum: null,
    title: "The deposit itself was rejected",
    detail: `Simulating this deposit failed with ${name}: ${msg}. The simulation is the last ` +
            `step before real money, and it did not pass.`,
  };
}

/** True when the refusal says something about the product rather than the wallet. */
export const isFinding = (c) => c.kind === FINDING;
