// Local dashboard. Runs on the machine that holds the wallet session, because
// `baw` is a local CLI — there is no hosted version of this and there cannot be.

import { createServer } from "node:http";
import { listEarn, walletStatus, baw } from "./baw.js";
import { preflight } from "./checks.js";
import { page } from "./ui.js";

const PORT = Number(process.env.PORT ?? 4173);

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page());
  }

  if (url.pathname === "/api/status") {
    const s = await walletStatus();
    return json(res, 200, { connected: s.ok && s.data?.status === "CONNECTED" });
  }

  // Which assets the wallet holds. A deposit can only be simulated for an asset
  // that is held, so this is what separates "checkable" from "listed".
  if (url.pathname === "/api/holdings") {
    const r = await baw(["wallet", "balance", "--binanceChainId",
                         url.searchParams.get("chain") ?? "56"]);
    if (!r.ok) return json(res, 200, { held: [] });
    const held = (r.data ?? []).map((b) => String(b.symbol).toUpperCase());
    return json(res, 200, { held });
  }

  if (url.pathname === "/api/list") {
    const r = await listEarn(url.searchParams.get("chain") ?? "56");
    if (!r.ok) return json(res, 502, { error: r.error });
    const list = r.data.list
      .map((i) => ({
        investmentId: i.investmentId,
        protocolName: i.protocolName,
        investmentName: i.investmentName,
        apyDisplay: i.apyDisplay,
        apyBps: Number(i.apyBps),
        tvl: Number(i.tvl),
        defiProtocolId: i.defiProtocolId,
      }))
      .sort((a, b) => b.apyBps - a.apyBps);
    return json(res, 200, { list });
  }

  if (url.pathname === "/api/check" && req.method === "POST") {
    const { investmentId, amount } = await readBody(req);
    const r = await listEarn("56");
    if (!r.ok) return json(res, 502, { error: r.error });
    const investment = r.data.list.find((i) => i.investmentId === investmentId);
    if (!investment) return json(res, 404, { error: "not in the current listing" });
    const verdict = await preflight({ investment, amount: Number(amount) || 0.005 });
    return json(res, 200, verdict);
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, () => {
  console.log(`\n  nullius — http://localhost:${PORT}\n`);
  console.log("  Runs locally because the wallet session lives on this machine.");
  console.log("  Nothing on this page broadcasts a transaction.\n");
});
