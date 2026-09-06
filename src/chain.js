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

/** Ask the chain what this contract calls itself. */
export async function identify(address) {
  const [code, symbol, name] = await Promise.all([
    hasCode(address).catch(() => false),
    callString(address, SELECTOR.symbol),
    callString(address, SELECTOR.name),
  ]);
  return { address, isContract: code, symbol, name };
}
