#!/usr/bin/env node
// nullius — refuses to deposit what it cannot verify.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { walletStatus, listEarn } from "./baw.js";
import { preflight, BLOCK, WARN, PASS, UNTESTED } from "./checks.js";
import { renderReport } from "./report.js";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", grey: "\x1b[90m",
};
const MARK = {
  [PASS]: `${C.green}✓${C.reset}`,
  [WARN]: `${C.yellow}!${C.reset}`,
  [BLOCK]: `${C.red}✗${C.reset}`,
  [UNTESTED]: `${C.grey}–${C.reset}`,
};

const NATIVE_BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function printResult(r) {
  console.log(`  ${MARK[r.level]} ${C.bold}${r.title}${C.reset}`);
  console.log(`    ${C.dim}${r.detail}${C.reset}`);
}

function printVerdict(v) {
  const ok = v.verdict === "GO";
  const colour = ok ? C.green : v.reason === "failed" ? C.red : C.grey;
  const parts = [];
  if (v.blocked) parts.push(`${v.blocked} failed`);
  if (v.untested) parts.push(`${v.untested} untested`);
  if (v.warned) parts.push(`${v.warned} warning`);
  console.log(`\n  ${colour}${C.bold}${v.verdict}${C.reset}  ${C.dim}${parts.join(", ") || "all clear"}${C.reset}`);
  if (!ok) {
    const why = v.reason === "failed"
      ? "A check failed outright."
      : "Nothing failed — but the position could not be verified, and that is not permission.";
    console.log(`  ${C.dim}${why}${C.reset}`);
  }
}

async function requireWallet() {
  const s = await walletStatus();
  if (!s.ok || s.data?.status !== "CONNECTED") {
    console.error(`${C.red}Wallet is not connected.${C.reset}`);
    console.error(`Run: ${C.cyan}baw auth signin${C.reset} then ${C.cyan}baw auth verify --qrCodeId <id>${C.reset}`);
    console.error(`Or run ${C.cyan}npm run judge${C.reset} to see a recorded run with no wallet needed.`);
    process.exit(2);
  }
}

// ------------------------------------------------------------------ commands

async function cmdScan() {
  const amount = Number(arg("amount", "10"));
  const chainId = arg("chain", "56");
  const limit = Number(arg("limit", "8"));
  const demo = flag("demo");

  let runs;
  if (demo) {
    const fixture = new URL("../fixtures/demo-run.json", import.meta.url);
    if (!existsSync(fixture)) {
      console.error("No recorded run found. Run a live scan first: npm run scan");
      process.exit(2);
    }
    runs = JSON.parse(readFileSync(fixture, "utf8"));
    console.log(`${C.bold}Recorded run — no wallet, no network, no funds.${C.reset}`);
    console.log(`${C.dim}Replayed exactly as captured against BNB Smart Chain.${C.reset}\n`);
    for (const r of runs) {
      console.log(`${C.bold}${r.label}${C.reset}`);
      (r.checks ?? []).forEach(printResult);
      printVerdict(r);
      console.log();
    }
  } else {
    await requireWallet();
    const list = await listEarn(chainId);
    if (!list.ok) {
      console.error("Could not list opportunities:", list.error);
      process.exit(1);
    }
    const asset = arg("asset");
    const items = list.data.list
      .filter((i) => !asset || String(i.investmentName).toUpperCase() === asset.toUpperCase())
      .sort((a, b) => Number(b.apyBps) - Number(a.apyBps))
      .slice(0, limit);
    if (items.length === 0) {
      console.error(`No Earn products found${asset ? ` for asset ${asset}` : ""}.`);
      process.exit(1);
    }

    console.log(`${C.bold}Screening the ${items.length} highest-yield opportunities on chain ${chainId}.${C.reset}`);
    console.log(`${C.dim}Deposit size tested: $${amount}. Nothing is broadcast.${C.reset}\n`);

    runs = [];
    for (const inv of items) {
      const label = `${inv.protocolName} ${inv.investmentName} @ ${inv.apyDisplay}`;
      console.log(`${C.bold}${label}${C.reset}`);
      const v = await preflight({ investment: inv, amount, chainId });
      v.checks.forEach(printResult);
      printVerdict(v);
      runs.push({ label, investment: inv, ...v });
      console.log();
    }
  }

  const go = runs.filter((r) => r.verdict === "GO").length;
  console.log(`${C.bold}${go} of ${runs.length} cleared preflight.${C.reset}`);

  const outDir = new URL("../reports/", import.meta.url);
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = new URL(`preflight-${stamp}.html`, outDir);
  writeFileSync(out, renderReport(runs, { amount, chainId, demo }), "utf8");
  console.log(`${C.dim}Report: ${out.pathname}${C.reset}`);

  if (!demo) {
    const fx = new URL("../fixtures/", import.meta.url);
    mkdirSync(fx, { recursive: true });
    writeFileSync(new URL("demo-run.json", fx), JSON.stringify(runs, null, 2), "utf8");
  }
}

async function cmdCheck() {
  await requireWallet();
  const investmentId = arg("investmentId");
  const token = arg("token", NATIVE_BNB);
  const amount = Number(arg("amount", "0.005"));
  const chainId = arg("chain", "56");
  if (!investmentId) {
    console.error("Usage: nullius check --investmentId <id> [--token <addr>] [--amount <n>]");
    process.exit(2);
  }
  const list = await listEarn(chainId);
  const inv = list.ok ? list.data.list.find((i) => i.investmentId === investmentId) : null;
  if (!inv) {
    console.error("That investment id is not in the current Earn listing.");
    process.exit(1);
  }
  console.log(`${C.bold}${inv.protocolName} ${inv.investmentName} @ ${inv.apyDisplay}${C.reset}\n`);
  const v = await preflight({ investment: inv, tokenAddress: token, amount, chainId });
  v.checks.forEach(printResult);
  printVerdict(v);
  process.exit(v.verdict === "GO" ? 0 : 1);
}

const cmd = process.argv[2];
if (cmd === "scan") await cmdScan();
else if (cmd === "check") await cmdCheck();
else {
  console.log(`nullius — refuses to deposit what it cannot verify.

  scan    Screen the highest-yield opportunities and write an HTML report.
          --amount <usd>   deposit size to test (default 10)
          --limit <n>      how many to screen (default 8)
          --demo           replay a recorded run; no wallet or funds needed

  check   Run the full preflight on one product.
          --investmentId <id> --token <addr> --amount <n>

Nothing in this tool broadcasts a transaction.`);
}
