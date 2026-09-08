#!/usr/bin/env node
// Point the model at our own checks and ask it to get past them.
//
// Every demo shows the tool catching things. That proves the tool catches what
// it was built to catch, which is not interesting. The useful question is what
// walks straight through, and searching 590 products for something that satisfies
// nine mechanical rules while still being a bad place to put money is a reasoning
// problem rather than a lookup.
//
// The model's answers are claims, not findings. Each one names a specific product
// and a specific mechanism, and each is then run through the real checks. A claim
// that survives is a hole in our tool. A claim that does not is a hallucination,
// and both get written down.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { listInvestments } from "./baw.js";
import { screen, PASS, WARN, BLOCK, UNTESTED } from "./checks.js";

const DIR = new URL("../data/", import.meta.url);
const SURVEY = new URL("survey-latest.json", DIR);
const OUT = new URL("redteam-latest.json", DIR);

function loadEnv() {
  const f = new URL("../.env", import.meta.url);
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const LLM = {
  key: process.env.LLM_API_KEY,
  base: process.env.LLM_BASE_URL ?? "https://api.vikey.ai/v1",
  model: process.env.LLM_MODEL ?? "deepseek/deepseek-v4-flash",
};

/** Exactly what each check does, stated so the model can look for the seams. */
const CHECKS_DESCRIBED = `
1. Listing. Reads investable from investment-info. Refuses a delisted product.
   Does NOT look at anything else the listing says.
2. Rate type. Warns when a liquidity pool's APR is being read as a yield.
   Warning only. Never blocks.
3. Pairing. For pools, simulates lp-add and reports a second asset the command
   did not name. Only fires when the simulation runs or returns an
   insufficient-balance error naming the other token.
4. Simulation. Runs preview without broadcasting to obtain the contract address.
   Needs the asset in hand; otherwise records untested.
5. Identity. Calls name() and symbol() on that contract and compares them to the
   advertised protocol and asset. For pools with no name(), reads token0 and
   token1 instead and compares the pair. String comparison only.
6. Mutability. Reads EIP-1967 slots. Blocks when upgrade authority ends at an
   externally owned account. Warns for a timelock or an unresolved contract.
7. Value. Compares USD in against USD of position out from the simulation.
   Blocks on more than 1% loss.
8. Exit. Simulates a full redeem. INVESTMENT_NO_POSITION counts as the exit path
   existing.
9. History. Matches the pool against DefiLlama on rate agreement within 0.10pp
   and warns when today's rate is 3x its own median and above the 95th
   percentile. Warning only. Never blocks.
10. Capacity. Blocks when the deposit would exceed 5% of independently reported
    pool size. Falls back to a warning when pool size is unknown.
11. Exit delay. Warns when the protocol is one Binance names as able to queue a
    redemption. Cannot be established per product before a deposit exists, so a
    delay actually observed on a past withdrawal overrides it. Warning only.
12. Protocol score. Reads securityScore and the six dimension scores from
    protocol-info. Warns below 70, and warns when the venue publishes no score
    at all. Warning only. Never blocks.

A verdict is VERIFIED only when nothing blocks and nothing is untested.
Warnings never prevent a verdict.
`.trim();

async function ask(prompt) {
  const r = await fetch(`${LLM.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LLM.key}` },
    body: JSON.stringify({ model: LLM.model, temperature: 0.4,
                           messages: [{ role: "user", content: prompt }] }),
  });
  const j = await r.json();
  const raw = j?.choices?.[0]?.message?.content ?? "";
  const m = /\[[\s\S]*\]/.exec(raw);
  if (!m) throw new Error(`no JSON array in reply: ${raw.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

async function main() {
  if (!LLM.key) {
    console.error("LLM_API_KEY is not set. The red team needs a model.");
    process.exit(2);
  }
  if (!existsSync(SURVEY)) {
    console.error("No survey. Run `npm run survey` first.");
    process.exit(2);
  }
  const survey = JSON.parse(readFileSync(SURVEY, "utf8"));

  const menu = survey.rows.slice(0, 60).map((r) =>
    `${r.protocol} | ${r.asset} | ${r.type} | ${r.rate?.toFixed(2)}% ${r.rateType ?? ""} | ` +
    `TVL $${Math.round(r.tvl || 0).toLocaleString("en-US")} | ` +
    `contract ${r.pool ? "published" : "not published"}` +
    (r.isProxy ? ` | upgradeable, authority ${r.controlKind}` : "")).join("\n");

  const prompt =
`You are auditing a tool that decides whether it is safe to deposit into a DeFi
product on BNB Smart Chain. Your job is to defeat it.

These are its checks, in full:

${CHECKS_DESCRIBED}

These are real products it screens:

${menu}

Find cases where every check passes, or produces only warnings, and a depositor
still ends up worse off. Be specific and mechanical. "It might be risky" is not
an answer. Name the product, name which check should have caught it, and say
what the depositor actually loses.

Reply with a JSON array only, 3 to 5 entries:
[{"product":"<protocol> <asset>","gap":"<the check that fails to catch it>",
  "mechanism":"<how a depositor loses money while the checks stay quiet>",
  "severity":"high|medium|low"}]`;

  console.log(`Asking ${LLM.model} to get past ${10} checks across ${survey.rows.length} products.\n`);
  const claims = await ask(prompt);

  // Each claim is now tested against the real checks rather than believed.
  const [earn, pools] = await Promise.all([
    listInvestments("Earn", "56"), listInvestments("LiquidityPool", "56"),
  ]);
  const all = [
    ...(earn.ok ? earn.data.list.map((i) => ({ ...i, investType: "Earn" })) : []),
    ...(pools.ok ? pools.data.list.map((i) => ({ ...i, investType: "LiquidityPool" })) : []),
  ];

  const results = [];
  for (const c of claims) {
    const needle = String(c.product ?? "").toLowerCase();
    const target = all.find((i) =>
      needle.includes(String(i.investmentName).toLowerCase()) &&
      needle.includes(String(i.protocolName).split(" ")[0].toLowerCase()));

    if (!target) {
      results.push({ ...c, verdict: "unfounded", note: "No such product in the live listing." });
      continue;
    }
    const s = await screen({ investment: target, chainId: "56" });
    const blocked = s.checks.filter((x) => x.level === BLOCK).map((x) => x.title);
    const untested = s.checks.filter((x) => x.level === UNTESTED).map((x) => x.title);

    // Three outcomes, and conflating the last two would be flattering ourselves.
    // A check that fired is a catch. A product we cannot evaluate at all is not a
    // catch, it is an admission, and counting it as a win would turn every
    // lending product into a false victory since none of them publish a contract.
    let verdict, note;
    if (blocked.length) {
      verdict = "caught";
      note = `A check fired: ${blocked.join(", ")}.`;
    } else if (untested.length) {
      verdict = "not evaluable";
      note = `The tool cannot assess this product at all (${untested.join(", ")}), so it refuses ` +
             `by default. That is not the same as catching the attack described.`;
    } else {
      verdict = "SURVIVES";
      note = "Passes every check. If the mechanism is real, this is a hole in the tool.";
    }
    results.push({ ...c, verdict, screenVerdict: s.verdict, caughtBy: blocked, untested, note });
  }

  mkdirSync(DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify({ model: LLM.model, at: new Date().toISOString(), results }, null, 2) + "\n");

  const holes = results.filter((r) => r.verdict === "SURVIVES");
  const blind = results.filter((r) => r.verdict === "not evaluable");
  for (const r of results) {
    const tag = { SURVIVES: "GOT THROUGH", caught: "caught",
                  "not evaluable": "BLIND SPOT", unfounded: "unfounded" }[r.verdict];
    console.log(`[${tag}] ${r.product} — ${r.gap}`);
    console.log(`   ${r.mechanism}`);
    console.log(`   ${r.note}\n`);
  }
  console.log(`${holes.length} of ${results.length} claims passed every check.`);
  console.log(`${blind.length} landed on products the tool cannot evaluate at all.`);
  console.log(`Written to data/redteam-latest.json`);
}

await main();
