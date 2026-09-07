// Independent on-chain verification.
//
// This deliberately does NOT go through Binance. The whole point of the check is
// to ask the blockchain itself what a contract is, so that a wrong or stale claim
// from the listing cannot pass silently.

const RPCS = [
  "https://bsc-rpc.publicnode.com",
  "https://binance.llamarpc.com",
  "https://bsc-dataseed1.defibit.io",
];

// keccak256 selectors
const SELECTOR = {
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  decimals: "0x313ce567",
};

async function rpc(method, params, { timeoutMs = 15_000 } = {}) {
  let lastErr;
  for (const url of RPCS) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ac.signal,
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message ?? "rpc error");
      return json.result;
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(`all RPC endpoints failed: ${lastErr?.message ?? "unknown"}`);
}

/**
 * Decode an eth_call return value that is either a dynamic `string`
 * or a legacy fixed `bytes32` (older tokens such as MKR use bytes32).
 */
export function decodeStringReturn(hex) {
  if (!hex || hex === "0x") return null;
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;

  // Dynamic string: 32-byte offset, 32-byte length, then data.
  if (body.length >= 128) {
    const offset = Number.parseInt(body.slice(0, 64), 16);
    if (Number.isSafeInteger(offset) && offset === 32) {
      const len = Number.parseInt(body.slice(64, 128), 16);
      if (Number.isSafeInteger(len) && len > 0 && 128 + len * 2 <= body.length) {
        const raw = body.slice(128, 128 + len * 2);
        const out = Buffer.from(raw, "hex").toString("utf8").replace(/\0+$/, "").trim();
        if (out) return out;
      }
    }
  }
  // bytes32 fallback: trim trailing zero padding.
  const out = Buffer.from(body.slice(0, 64), "hex")
    .toString("utf8")
    .replace(/\0+/g, "")
    .trim();
  return out || null;
}

// EIP-1967 storage slots, plus the older OpenZeppelin one.
const SLOT = {
  impl:  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon:"0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  legacy:"0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
};
const nonZero = (h) => typeof h === "string" && /[1-9a-f]/i.test(h.slice(2));
const addrFromSlot = (h) => (nonZero(h) ? `0x${h.slice(-40)}` : null);

/**
 * Can this contract be replaced out from under a depositor?
 *
 * Verifying what a contract calls itself is worth little if someone can swap the
 * code behind that name tomorrow. A proxy means the bytecode checked today is not
 * necessarily the bytecode running when the money is withdrawn, and whoever holds
 * the admin key decides that.
 */
/**
 * Follow upgrade authority to whoever actually holds it.
 *
 * A proxy on its own says little. What matters is what sits at the end of the
 * chain. Wasabi Protocol lost $5m on 30 April 2026 because ADMIN_ROLE sat on a
 * single externally owned account: one key, no timelock, and the attacker
 * upgraded the implementation out from under depositors. Drift lost $285m to the
 * same shape. An admin that is itself a governance contract is a different
 * proposition from an admin that is one private key.
 */
export async function controlChain(start, maxHops = 4) {
  const hops = [];
  let cur = start;
  for (let i = 0; i < maxHops && cur; i += 1) {
    // Same rule as above: a failed read is not an observation, so let it throw
    // and let the caller decide, rather than recording "unreadable" as a fact.
    const code = await rpc("eth_getCode", [cur, "latest"]);
    const isEOA = !code || code === "0x";
    if (isEOA) { hops.push({ address: cur, kind: "eoa" }); break; }

    // A timelock or a multisig at the end of the chain is a materially better
    // answer than a bare key, so name them when they identify themselves.
    const [delay, threshold] = await Promise.all([
      rpc("eth_call", [{ to: cur, data: "0xf27a0c92" }, "latest"]).catch(() => null), // getMinDelay()
      rpc("eth_call", [{ to: cur, data: "0xe75235b8" }, "latest"]).catch(() => null), // getThreshold()
    ]);
    const kind = delay && delay !== "0x" ? "timelock"
      : threshold && threshold !== "0x" ? "multisig"
      : "contract";
    hops.push({
      address: cur, kind,
      minDelaySeconds: kind === "timelock" ? Number(BigInt(delay)) : undefined,
      threshold: kind === "multisig" ? Number(BigInt(threshold)) : undefined,
    });
    if (kind !== "contract") break;

    let owner = null;
    try {
      owner = await rpc("eth_call", [{ to: cur, data: "0x8da5cb5b" }, "latest"]);
    } catch { /* no owner() to follow */ }
    const next = addrFromSlot(owner);
    if (!next || next.toLowerCase() === cur.toLowerCase()) break;
    cur = next;
  }
  return { hops, endsAt: hops[hops.length - 1] ?? null };
}

export async function mutability(address) {
  // Storage reads are not allowed to fail quietly. Every address has storage, so
  // an error here is transport, not absence, and swallowing it would record "no
  // admin" for something that simply did not answer. A monitor built on that
  // reports changes that never happened.
  const [impl, admin, beacon, legacy] = await Promise.all([
    rpc("eth_getStorageAt", [address, SLOT.impl, "latest"]),
    rpc("eth_getStorageAt", [address, SLOT.admin, "latest"]),
    rpc("eth_getStorageAt", [address, SLOT.beacon, "latest"]),
    rpc("eth_getStorageAt", [address, SLOT.legacy, "latest"]),
  ]);
  // owner() is different: plenty of contracts genuinely do not implement it, and
  // a revert there is an answer rather than a failure.
  const owner = await rpc("eth_call", [{ to: address, data: "0x8da5cb5b" }, "latest"])
    .catch(() => null);
  const implementation = addrFromSlot(impl) ?? addrFromSlot(legacy);
  return {
    isProxy: Boolean(implementation) || nonZero(beacon),
    implementation,
    admin: addrFromSlot(admin),
    beacon: addrFromSlot(beacon),
    owner: addrFromSlot(owner),
  };
}

/** True when the address holds deployed bytecode (i.e. is a contract, not an EOA). */
export async function hasCode(address) {
  const code = await rpc("eth_getCode", [address, "latest"]);
  return typeof code === "string" && code !== "0x" && code.length > 2;
}

async function callString(address, selector) {
  try {
    const res = await rpc("eth_call", [{ to: address, data: selector }, "latest"]);
    return decodeStringReturn(res);
  } catch {
    return null;
  }
}

/**
 * Read the two sides of a pool straight from the pool contract.
 *
 * A Uniswap-style pool implements no name() or symbol(), but it does say which
 * two tokens it holds. Since the listing publishes poolAddress for every
 * liquidity pool, this verifies the advertised pair without holding either
 * asset and without asking Binance to confirm its own claim.
 */
export async function poolPair(address) {
  const addrOf = (hex) =>
    typeof hex === "string" && hex.length >= 66 ? `0x${hex.slice(-40)}` : null;
  try {
    const [a0, a1] = await Promise.all([
      rpc("eth_call", [{ to: address, data: "0x0dfe1681" }, "latest"]).catch(() => null),
      rpc("eth_call", [{ to: address, data: "0xd21220a7" }, "latest"]).catch(() => null),
    ]);
    const [t0, t1] = [addrOf(a0), addrOf(a1)];
    if (!t0 || !t1) return null;
    const [i0, i1] = await Promise.all([identify(t0), identify(t1)]);
    return { token0: i0, token1: i1 };
  } catch {
    return null;
  }
}

/** Ask the chain what this contract calls itself. */
export async function identify(address) {
  const [code, symbol, name] = await Promise.all([
    hasCode(address).catch(() => false),
    callString(address, SELECTOR.symbol),
    callString(address, SELECTOR.name),
  ]);
  return { address, isContract: code, symbol, name };
}
