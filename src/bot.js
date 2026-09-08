// Telegram front end.
//
// The model here reads messages and nothing else. Everything it can reach goes
// through baw.js, which refuses anything outside a read-only allowlist. Moving
// money lives in execute.js behind a nonce minted only after a check came back
// clear, and the model never sees one. So it is not that the model is asked not
// to spend: the call is not reachable from anything it touches.

import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { listInvestments, walletStatus, baw } from "./baw.js";
import { preflight, PASS, WARN, BLOCK, UNTESTED } from "./checks.js";
import { stage, peek, commit, observedDelay } from "./execute.js";
import { positions, formatEarned } from "./positions.js";
import { classify } from "./refusal.js";

// ---------------------------------------------------------------- config

function loadEnv() {
  const f = new URL("../.env", import.meta.url);
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = (process.env.ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const LLM = {
  key: process.env.LLM_API_KEY,
  base: process.env.LLM_BASE_URL ?? "https://api.vikey.ai/v1",
  model: process.env.LLM_MODEL ?? "deepseek/deepseek-v4-flash",
};

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.");
  process.exit(2);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const MARK = { [PASS]: "✅", [WARN]: "⚠️", [BLOCK]: "⛔️", [UNTESTED]: "◽️" };

// ---------------------------------------------------------------- telegram

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return res.json();
}

const esc = (s) => String(s ?? "").replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");

const send = (chat, text, markup) =>
  tg("sendMessage", {
    chat_id: chat, text, parse_mode: "MarkdownV2",
    ...(markup ? { reply_markup: markup } : {}),
    link_preview_options: { is_disabled: true },
  });

const edit = (chat, messageId, text, markup) =>
  tg("editMessageText", {
    chat_id: chat, message_id: messageId, text, parse_mode: "MarkdownV2",
    ...(markup ? { reply_markup: markup } : {}),
    link_preview_options: { is_disabled: true },
  });

const typing = (chat) => tg("sendChatAction", { chat_id: chat, action: "typing" });

const BACK = [{ text: "◀️ Back", callback_data: "home" }];

// Two things this is for, and one explanation. "Show me the trap" is a
// demonstration rather than a feature, so it lives on /compare and not here.
const HOME_KEYS = {
  inline_keyboard: [
    [{ text: "❓ How this works", callback_data: "help" }],
    [{ text: "👛 My balance", callback_data: "bal" }],
    [{ text: "💰 Put my money to work", callback_data: "work" }],
    [{ text: "📊 What I'm holding", callback_data: "pos" }],
  ],
};

const NATIVE_BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/**
 * Deposit sizes, as a share of what the wallet actually holds.
 *
 * These used to be three fixed numbers, which meant offering to deposit 0.005
 * USDT against a balance of ten dollars. Worse than merely silly: at that size
 * the value-conservation and pool-capacity checks both round to zero and stop
 * testing anything, so the report came back clean partly because it had nothing
 * to weigh.
 */
const PROPORTIONS = [[0.25, "25%"], [0.5, "50%"], [1, "100%"]];

/**
 * BNB left behind to pay for the transaction.
 *
 * Gas is paid in BNB no matter which asset is being deposited, so depositing
 * every last BNB leaves nothing to pay for the deposit itself. A deposit costs
 * roughly 0.00004 BNB at current prices; this reserves enough for that and the
 * withdrawal that follows it, several times over.
 */
const GAS_RESERVE_BNB = 0.002;

const normSym = (s) =>
  String(s ?? "").toUpperCase().replace(/^BSC_/, "").replace(/^W(?=BNB$|ETH$)/, "");

/** What the wallet can commit of one asset, after leaving gas behind. */
async function spendable(symbol) {
  const b = await baw(["wallet", "balance", "--binanceChainId", "56"]);
  if (!b.ok || !Array.isArray(b.data)) return null;
  const row = b.data.find((t) => normSym(t.symbol) === normSym(symbol));
  if (!row) return null;
  const held = Number(row.balance);
  const native = normSym(row.symbol) === "BNB";
  return {
    symbol: row.symbol,
    held,
    usable: native ? Math.max(0, held - GAS_RESERVE_BNB) : held,
    price: Number(row.price ?? 0),
    native,
  };
}

/** Trim to something the wallet will accept without rounding past the balance. */
const trim = (n) => Number(Math.floor(n * 1e6) / 1e6);

/** Waiting on someone to type an amount: userId -> what they are sizing. */
const awaitingAmount = new Map();
const AMOUNT_TTL_MS = 5 * 60_000;

/**
 * Long reports, kept so the button that shows one does not have to run every
 * check again. Short by default is only an improvement if the detail is still
 * one tap away.
 */
const reports = new Map();
const REPORT_TTL_MS = 15 * 60_000;

function keepReport(label, v) {
  const id = randomBytes(6).toString("base64url");
  reports.set(id, { text: renderVerdict(label, v, { full: true }), at: Date.now() });
  for (const [k, r] of reports) if (Date.now() - r.at > REPORT_TTL_MS) reports.delete(k);
  return id;
}

const FULL = (id) => [{ text: "📄 Show me everything", callback_data: `rep:${id}` }];

// ---------------------------------------------------------------- screens

/** Home. Wallet state first, then one line of what to do. */
async function homeText() {
  const [w, b] = await Promise.all([
    walletStatus(),
    baw(["wallet", "balance", "--binanceChainId", "56"]).catch(() => ({ ok: false })),
  ]);
  const connected = w.ok && w.data?.status === "CONNECTED";
  const held = b.ok && Array.isArray(b.data) && b.data.length
    ? b.data.map((t) => `${Number(t.balance).toFixed(4)} ${t.symbol}`).join(" · ")
    : "nothing on BNB Chain";

  return `*Nullius*\n_Take nobody's word for it\\._\n\n` +
    `Wallet: ${connected ? "connected" : "*not connected*"}\n` +
    `Holding: ${esc(held)}\n` +
    `\\-\\-\\-\n\n` +
    `Binance shows an agent a protocol name and a percentage, then lets it move your money on ` +
    `that\\. The listing never says which contract you are actually entering\\.\n\n` +
    `I find that contract before anything is signed, ask the chain what it really is, and stop ` +
    `when the answer does not match\\.\n\n` +
    `New here? Start with *How this works*\\. Ready to go? *Put my money to work* finds ` +
    `something, checks it against the chain, and asks you before anything is sent\\.`;
}

const HELP =
  `*How this works*\n\n` +
  `*1\\. I simulate the deposit\\.* No money moves, but the simulation has to name the contract ` +
  `it would call\\. That address is not in the listing anywhere\\.\n\n` +
  `*2\\. I ask the blockchain about it\\.* Not Binance\\. I call the contract directly and read ` +
  `back what it calls itself\\.\n\n` +
  `*3\\. I compare\\.* Listing says one thing, chain says another, I stop\\. Chain says nothing ` +
  `at all, I also stop\\.\n\n` +
  `Eleven checks run in total: delisted products, contracts whose code one key can replace, ` +
  `hidden ` +
  `second assets, fee rates dressed up as yields, missing exits, and pools too small to take ` +
  `your money without moving the rate\\.\n\n` +
  `*Three answers, not two\\.* Pass, fail, or no evidence either way\\. The third one still ` +
  `refuses\\. Not being able to verify something is not permission to proceed\\.\n\n` +
  `I run a model so I can read plain English, and it cannot spend anything\\. Moving money needs ` +
  `a token minted only after a check comes back clear, and the model never sees one\\.`;

function listIntro(type) {
  return type === "LiquidityPool"
    ? `*Liquidity pools, highest advertised rate first*\n\n` +
      `⚠️ *This is not a recommendation\\.* It is the raw Binance listing sorted the way an agent ` +
      `would sort it, so you can see what it would grab\\.\n\n` +
      `These quote APR, which is an annualised trading fee rate\\. It is not money you receive ` +
      `and it ignores impermanent loss entirely\\.\n\n` +
      `Tap any one and I will check it properly\\.`
    : `*Lending products, highest advertised rate first*\n\n` +
      `⚠️ *This is not a recommendation\\.* It is the raw Binance listing sorted the way an agent ` +
      `would sort it\\.\n\n` +
      `These quote APY, which is a real yield\\. Tap any one and I will check it properly\\.`;
}

function productKeys(items, type) {
  const rows = items.slice(0, 6).map((i) => [{
    text: `${i.investmentName} · ${i.apyDisplay}`,
    callback_data: `chk:${type === "LiquidityPool" ? "L" : "E"}:${i.investmentId.slice(0, 24)}`,
  }]);
  rows.push(BACK);
  return { inline_keyboard: rows };
}

/**
 * The report, short.
 *
 * The long version was accurate and nobody finished it. Eleven blocks of prose
 * ending in a tick is a wall, and a wall gets scrolled past, which leaves the
 * warnings inside it doing nothing. What matters is what passed, what did not,
 * and what the ones that did not would cost. Everything else moves behind a
 * button for whoever wants it.
 */
function renderVerdict(label, v, { full = false } = {}) {
  if (full) return renderFull(label, v);

  const passed = v.checks.filter((c) => c.level === PASS).length;
  const flags = v.checks.filter((c) => c.level !== PASS);
  const cleared = v.verdict === "GO" || v.verdict === "VERIFIED";

  const head = cleared
    ? `✅ *Cleared* · ${esc(label)}`
    : v.reason === "failed"
      ? `⛔️ *Refused* · ${esc(label)}`
      : `◽️ *Not confirmed* · ${esc(label)}`;

  if (!flags.length) {
    return `${head}\n\nAll ${passed} checks passed\\. The contract is what the listing says it ` +
      `is, the rate is in line with its own history, and nothing about it needs explaining\\.`;
  }

  // One line each: what it is, then what it costs. Anything without a plain
  // consequence written for it shows its title alone rather than filler.
  const lines = flags.map((c) => {
    const brief = c.consequence?.brief;
    return `${MARK[c.level]} *${esc(c.title)}*` + (brief ? `\n${esc(brief)}` : "");
  }).join("\n\n");

  const count = `*${passed} of ${v.checks.length} checks passed\\.* ` +
    `${flags.length === 1 ? "One thing" : `${flags.length} things`} to know:`;

  const tail = cleared
    ? `\n\nThe contract is genuine and the numbers hold\\. What is left is trust in people, ` +
      `not code\\. Your call\\.`
    : v.reason === "failed"
      ? `\n\nThat is a refusal, not a warning\\. I would not put money here\\.`
      : `\n\nNothing failed, but not everything could be checked\\. Not being able to confirm ` +
        `something is not permission\\.`;

  return `${head}\n\n${count}\n\n${lines}${tail}`;
}

/** Everything, for whoever asks. */
function renderFull(label, v) {
  const gaps = v.checks.filter((c) => c.level === UNTESTED).length;
  const cleared = v.verdict === "GO" || v.verdict === "VERIFIED";
  const head = cleared
    ? `✅ *Cleared* · ${esc(label)}`
    : v.reason === "failed"
      ? `⛔️ *Refused* · ${esc(label)}`
      : `◽️ *Not confirmed* · ${esc(label)}`;
  const body = v.checks
    .map((c) => `${MARK[c.level]} *${esc(c.title)}*\n${esc(c.detail)}`)
    .join("\n\n");
  const tail = cleared
    ? "\n\nEverything I can check, checks out\\."
    : v.reason === "failed"
      ? "\n\nSomething failed outright\\. I would not put money here\\."
      : `\n\nNothing failed, but ${gaps === 1 ? "one check" : `${gaps} checks`} could not be ` +
        `completed at all\\. Not being able to confirm something is not permission\\.`;

  const risks = v.checks.filter((c) => c.consequence?.full && c.level !== PASS);
  const why = risks.length
    ? `\n\n\\-\\-\\-\n\n*What each one would cost you*\n\n` +
      risks.map((c) => `*${esc(c.title)}*\n${esc(c.consequence.full)}`).join("\n\n") +
      `\n\n_I cannot tell you whether this is a good investment, and I am not qualified to\\._`
    : "";

  return `${head}\n\n${body}${tail}${why}`;
}

// ---------------------------------------------------------------- model

async function ask(prompt) {
  if (!LLM.key) return null;
  try {
    const r = await fetch(`${LLM.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${LLM.key}` },
      body: JSON.stringify({ model: LLM.model, temperature: 0,
                             messages: [{ role: "user", content: prompt }] }),
    });
    const j = await r.json();
    const m = /\{[\s\S]*\}/.exec(j?.choices?.[0]?.message?.content ?? "");
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

/** What a model does with the listing and nothing else. */
const unguardedPick = (items) => ask(
  `You manage a crypto wallet. The user says: "find me the best yield on BNB Chain and put my ` +
  `money in". This is the product listing you can see:\n\n` +
  items.slice(0, 12).map((i) => `${i.investmentId.slice(0, 8)} | ${i.protocolName} | ` +
    `${i.investmentName} | ${i.apyDisplay} | TVL $${Math.round(Number(i.tvl)).toLocaleString("en-US")}`)
    .join("\n") +
  `\n\nPick one and give your reasoning in at most 20 words. JSON only: ` +
  `{"idPrefix":"<8 chars>","reason":"<reasoning>"}`);

const routeMessage = (text, items) => ask(
  `Route a message for a tool that checks Binance DeFi products before a deposit.\n` +
  `Products:\n` +
  items.slice(0, 30).map((i) => `${i.investmentId.slice(0, 8)} ${i.protocolName} ${i.investmentName}`)
    .join("\n") +
  `\n\nJSON only: {"action":"check"|"list"|"help"|"compare","idPrefix":"<8 chars or null>"}\n` +
  `Message: ${text}`);

// ---------------------------------------------------------------- data

const cache = { Earn: null, LiquidityPool: null, at: 0 };

async function products(type) {
  if (cache[type] && Date.now() - cache.at < 120_000) return cache[type];
  const r = await listInvestments(type, "56");
  if (!r.ok) return null;
  cache[type] = r.data.list.map((i) => ({ ...i, investType: type }))
    .sort((a, b) => Number(b.apyBps) - Number(a.apyBps));
  cache.at = Date.now();
  return cache[type];
}

function bestMatch(items, query) {
  const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (!q.length) return null;
  let best = null;
  for (const i of items) {
    const hay = `${i.protocolName} ${i.investmentName}`.toLowerCase();
    const score = q.reduce((s, w) => s + (hay.includes(w) ? w.length : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { score, item: i };
  }
  return best?.item ?? null;
}

// ---------------------------------------------------------------- actions

async function showHome(chat) {
  await typing(chat);
  return send(chat, await homeText(), HOME_KEYS);
}

/**
 * Everything the agent's wallet is and holds, in one place.
 *
 * The address matters more here than it would in an ordinary wallet app: this
 * is an account an agent can spend from, so knowing which one it is, and what
 * ceiling the wallet puts on a day's spending, is part of knowing what is at
 * stake. Both come from the wallet itself rather than from anything kept here.
 */
async function showBalance(chat) {
  await typing(chat);
  const [addr, bal, quota, pos] = await Promise.all([
    baw(["wallet", "address"]),
    baw(["wallet", "balance", "--binanceChainId", "56"]),
    baw(["wallet", "left-quota"]).catch(() => ({ ok: false })),
    positions("56").catch(() => ({ ok: false })),
  ]);

  const bsc = (addr.ok ? addr.data?.addresses ?? [] : [])
    .find((a) => String(a.binanceChainId) === "56");

  const tokens = bal.ok && Array.isArray(bal.data) ? bal.data : [];
  const liquid = tokens.reduce((s, t) => s + Number(t.value ?? 0), 0);
  const deployed = pos.ok ? Number(pos.totalUsd ?? 0) : 0;

  const wallet = tokens.length
    ? tokens
        .sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0))
        .map((t) => `${esc(String(trim(Number(t.balance))))} ${esc(t.symbol)} · ` +
                    `$${esc(Number(t.value ?? 0).toFixed(2))}`)
        .join("\n")
    : "_Nothing on BNB Smart Chain\\._";

  const working = pos.ok && pos.held.length
    ? pos.held
        .map((h) => `${esc(h.protocol)} ${esc(h.asset)} · $${esc(h.valueUsd.toFixed(2))}`)
        .join("\n")
    : "_Nothing deposited right now\\._";

  const cap = quota.ok && quota.data
    ? `\n\n*Daily spending cap*\n$${esc(Number(quota.data.quotaLeft ?? 0).toLocaleString("en-US"))} ` +
      `left of $${esc(Number(quota.data.dailyLimit ?? 0).toLocaleString("en-US"))}\\. ` +
      `The wallet enforces this, not me\\.`
    : "";

  return send(chat,
    `*My balance*\n\n` +
    `*Total* · $${esc((liquid + deployed).toFixed(2))}\n` +
    `_$${esc(liquid.toFixed(2))} in the wallet, $${esc(deployed.toFixed(2))} earning\\._\n\n` +
    `*In the wallet*\n${wallet}\n\n` +
    `*Put to work*\n${working}${cap}\n\n` +
    `*Agent wallet address* \\(BNB Smart Chain\\)\n` +
    (bsc ? `\`${esc(bsc.address)}\`` : "_Could not read the address right now\\._") + `\n\n` +
    `_This is the account I deposit from\\. Send funds here to give me more to work with\\._`,
    { inline_keyboard: [
      [{ text: "💰 Put my money to work", callback_data: "work" }],
      BACK,
    ] });
}

async function showList(chat, type) {
  await typing(chat);
  const items = await products(type);
  if (!items) return send(chat, "Could not reach the Binance listing right now\\.", HOME_KEYS);
  return send(chat, listIntro(type), productKeys(items, type));
}

/** One product, with progress so the wait is legible. */
async function runCheck(chat, target, type) {
  const label = `${target.protocolName} ${target.investmentName} @ ${target.apyDisplay}`;
  await typing(chat);
  const m = await send(chat,
    `🔍 Checking *${esc(label)}*\n\n_Simulating the deposit, then asking the chain about the ` +
    `contract it names\\. Nothing gets broadcast\\. This takes a few seconds\\._`);
  const id = m?.result?.message_id;

  // A quarter of what the wallet could commit, so the value and capacity checks
  // have something real to weigh. A fixed token amount made both round to zero.
  const bal = await spendable(target.investmentName);
  const amount = bal && bal.usable > 0 ? trim(bal.usable * 0.25) : 0.005;
  const v = await preflight({ investment: target, amount, chainId: "56",
    observedDelay: observedDelay(target.investmentId) });

  const text = renderVerdict(label, v);
  const keys = { inline_keyboard: [
    FULL(keepReport(label, v)),
    [{ text: "◀️ Back to list", callback_data: `list:${type}` }], BACK] };
  return id ? edit(chat, id, text, keys) : send(chat, text, keys);
}

/**
 * The main flow. Find something the wallet can actually enter, verify it, and
 * offer to do it.
 */
async function putToWork(chat, userId) {
  await typing(chat);
  const [items, bal] = await Promise.all([
    products("Earn"),
    baw(["wallet", "balance", "--binanceChainId", "56"]).catch(() => ({ ok: false })),
  ]);
  if (!items) return send(chat, "Could not reach the Binance listing right now\\.", HOME_KEYS);

  // Keep the balance itself, not just which symbols exist. The check has to run
  // at a size that resembles the deposit being considered, or the value and
  // capacity tests round to zero and confirm nothing.
  const rows = bal.ok ? bal.data ?? [] : [];
  const usableOf = (sym) => {
    const row = rows.find((t) => normSym(t.symbol) === normSym(sym));
    if (!row) return 0;
    const n = Number(row.balance);
    return normSym(row.symbol) === "BNB" ? Math.max(0, n - GAS_RESERVE_BNB) : n;
  };
  const candidates = items
    .filter((i) => usableOf(i.investmentName) > 0)
    .map((i) => ({ inv: i, test: trim(usableOf(i.investmentName) * 0.25) }))
    .filter((c) => c.test > 0);

  if (!candidates.length) {
    return send(chat,
      `Your wallet holds nothing that any lending product on this chain takes\\.\n\n` +
      `Fund it with BNB and try again\\.`, HOME_KEYS);
  }

  const m = await send(chat,
    `🔍 *Checking all ${candidates.length} lending products your wallet can enter\\.*\n\n` +
    `_Each one goes to the chain\\. Nothing is broadcast\\._`);
  const mid = m?.result?.message_id;

  // Everything gets checked, not just up to the first pass. Stopping early meant
  // you were handed one answer with no way to see the others or why they lost.
  // Run them together, since each is mostly waiting on the network.
  const checked = await Promise.all(candidates.map(async ({ inv, test }) => ({
    inv, v: await preflight({ investment: inv, amount: test, chainId: "56",
      observedDelay: observedDelay(inv.investmentId) }),
  })));

  const cleared = checked.filter((c) => c.v.verdict === "GO");
  const refused = checked.filter((c) => c.v.verdict !== "GO");

  const line = ({ inv, v }) => {
    const why = v.reason === "failed"
      ? v.checks.find((c) => c.level === BLOCK)?.title ?? "a check failed"
      : v.checks.find((c) => c.level === UNTESTED)?.title ?? "could not be checked";
    return `${v.verdict === "GO" ? "✅" : v.reason === "failed" ? "⛔️" : "◽️"} ` +
      `*${esc(inv.investmentName)}* · ${esc(inv.protocolName)} · ${esc(inv.apyDisplay)}` +
      (v.verdict === "GO" ? "" : `\n     ${esc(why)}`);
  };

  const body = [...cleared, ...refused].map(line).join("\n");

  if (!cleared.length) {
    return edit(chat, mid,
      `*Checked ${checked.length}, none cleared\\.*\n\n${body}\n\n` +
      `That is the answer, not a failure to find you something\\.`, HOME_KEYS);
  }

  // One button per product that survived, so the choice is yours.
  const keys = cleared.map(({ inv, v }) => {
    const token = v.checks.find((c) => c.id === "listing")
      ?.evidence?.assetTokenList?.[0]?.tokenAddress ?? NATIVE_BNB;
    return [{
      text: `${inv.investmentName} · ${inv.protocolName} · ${inv.apyDisplay}`,
      callback_data: `pick:${stage({ investmentId: inv.investmentId, tokenAddress: token,
        // A placeholder only. showPick sizes it against the balance before
        // anything can be confirmed.
        amount: 0, label: `${inv.protocolName} ${inv.investmentName} @ ${inv.apyDisplay}`,
        ownerId: userId })}`,
    }];
  });
  keys.push(BACK);

  return edit(chat, mid,
    `*${cleared.length} of ${checked.length} cleared\\.*\n\n${body}\n\n` +
    `_Tap one to see its full report and choose an amount\\._`, { inline_keyboard: keys });
}

/** A cleared product, in full, with sizes. */
async function showPick(chat, nonce, userId) {
  const i = peek(nonce);
  if (!i || String(i.ownerId) !== String(userId)) {
    return send(chat, "That has expired\\. Run the check again\\.", HOME_KEYS);
  }
  await typing(chat);
  const items = await products("Earn");
  const inv = items?.find((x) => x.investmentId === i.investmentId);
  if (!inv) return send(chat, "That product has left the listing\\.", HOME_KEYS);

  const bal = await spendable(inv.investmentName);
  if (!bal || bal.usable <= 0) {
    return send(chat,
      `You no longer hold enough ${esc(inv.investmentName)} to deposit\\.` +
      (bal?.native ? `\n\n_${GAS_RESERVE_BNB} BNB is held back for gas, and gas has to come ` +
        `from somewhere\\._` : ""), HOME_KEYS);
  }

  // Check at the size actually on offer, not at a token amount. A check run on
  // 0.005 of anything tells you almost nothing about depositing a quarter of
  // the wallet.
  const v = await preflight({ investment: inv, amount: trim(bal.usable * 0.25), chainId: "56",
    observedDelay: observedDelay(inv.investmentId) });

  // A product can carry a minimum the listing never mentions. If the simulation
  // disclosed one, the proportions that fall under it are not offered.
  const min = v.checks.find((c) => c.minimum)?.minimum ?? 0;

  const rows = [];
  const offered = PROPORTIONS
    .map(([frac, tag]) => ({ frac, tag, amount: trim(bal.usable * frac) }))
    .filter((o) => o.amount > 0 && o.amount >= min);

  for (const o of offered) {
    const usd = o.amount * bal.price;
    rows.push([{
      text: `${o.tag} · ${o.amount} ${inv.investmentName}${usd ? ` (≈$${usd.toFixed(2)})` : ""}`,
      callback_data: `stage:${stage({ investmentId: i.investmentId, tokenAddress: i.tokenAddress,
        amount: o.amount, label: i.label, ownerId: userId })}`,
    }]);
  }
  rows.push([{ text: "✏️ Enter my own amount", callback_data: `amt:${nonce}` }]);
  rows.push(FULL(keepReport(i.label, v)));
  rows.push([{ text: "◀️ Back to the list", callback_data: "work" }]);

  const shortfall = !offered.length
    ? `\n\n⛔️ *This product will not take less than ${esc(String(min))} ${esc(inv.investmentName)}, ` +
      `and you have ${esc(String(trim(bal.usable)))}\\.*`
    : "";

  return send(chat,
    `${renderVerdict(i.label, v)}\n\n` +
    `You hold *${esc(String(trim(bal.held)))} ${esc(inv.investmentName)}*` +
    (bal.native ? `, of which ${esc(String(trim(bal.usable)))} can be deposited once gas is set aside`
                : "") +
    `\\.${min ? ` Minimum deposit is ${esc(String(min))}\\.` : ""}${shortfall}\n\n` +
    `_Pick a size\\. This one actually spends money\\._`,
    { inline_keyboard: rows });
}

/** Ask for a typed amount, and remember what it is for. */
async function askAmount(chat, nonce, userId) {
  const i = peek(nonce);
  if (!i || String(i.ownerId) !== String(userId)) {
    return send(chat, "That has expired\\. Run the check again\\.", HOME_KEYS);
  }
  // The label is "Protocol Asset @ rate" and protocol names contain spaces, so
  // the asset is read back off the listing rather than parsed out of the label.
  const items = await products("Earn");
  const inv = items?.find((x) => x.investmentId === i.investmentId);
  if (!inv) return send(chat, "That product has left the listing\\.", HOME_KEYS);

  const bal = await spendable(inv.investmentName);
  awaitingAmount.set(String(userId), {
    investmentId: i.investmentId, tokenAddress: i.tokenAddress, label: i.label,
    max: bal?.usable ?? null, symbol: bal?.symbol ?? "", price: bal?.price ?? 0,
    at: Date.now(),
  });
  return send(chat,
    `How much do you want to deposit into *${esc(i.label)}*?\n\n` +
    (bal ? `You can commit up to *${esc(String(trim(bal.usable)))} ${esc(bal.symbol)}*\\.\n\n` : "") +
    `_Reply with just the number, like_ \`2.5\`\\.`,
    { inline_keyboard: [[{ text: "◀️ Cancel", callback_data: "work" }]] });
}

/**
 * Turn a typed number into a staged deposit.
 *
 * Returns false when nothing was pending, so ordinary messages still fall
 * through to the rest of the handler.
 */
async function takeAmount(chat, userId, text) {
  const p = awaitingAmount.get(String(userId));
  if (!p) return false;
  if (Date.now() - p.at > AMOUNT_TTL_MS) { awaitingAmount.delete(String(userId)); return false; }

  const n = Number(String(text).trim().replace(/[, ]/g, "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) {
    await send(chat, `That is not an amount I can use\\. Reply with just a number, like \`2.5\`\\.`);
    return true;
  }
  if (p.max !== null && n > p.max) {
    await send(chat,
      `You only have *${esc(String(trim(p.max)))} ${esc(p.symbol)}* to commit\\. Try a smaller number\\.`);
    return true;
  }
  awaitingAmount.delete(String(userId));

  const amount = trim(n);
  const nonce = stage({ investmentId: p.investmentId, tokenAddress: p.tokenAddress,
    amount, label: p.label, ownerId: userId });
  await confirmStage(chat, nonce, userId);
  return true;
}

/** What is held, what it cost, what it has made, and the way out. */
async function showPositions(chat, userId) {
  await typing(chat);
  const r = await positions("56");
  if (!r.ok) return send(chat, "Could not read your positions right now\\.", HOME_KEYS);
  if (!r.held.length) {
    return send(chat, `You hold nothing on this chain yet\\.`, HOME_KEYS);
  }

  const rows = [];
  const keys = [];
  for (const h of r.held) {
    const earned = h.earned === null
      ? `_No cost basis recorded, so I will not guess what it earned\\._`
      : `Earned: ${esc(formatEarned(h.earned, h.asset, h.price))}`;
    rows.push(
      `*${esc(h.protocol)} ${esc(h.asset)}*\n` +
      `Holding ${esc(String(h.amount))} ${esc(h.asset)} · $${esc(h.valueUsd.toFixed(2))}\n` +
      (h.basis !== null ? `Deposited ${esc(String(h.basis))} across ${h.deposits} transfer${h.deposits === 1 ? "" : "s"}\n` : "") +
      earned);

    // Binance reports positions for more protocols than it will build
    // transactions for. Those extra ones still carry an investmentId, and it
    // does not work. Better to say so than to offer a button that fails.
    if (h.withdrawable === false) {
      rows[rows.length - 1] +=
        `\n_Binance shows this position but does not offer a withdrawal path for it, ` +
        `so it has to be exited from the protocol directly\\._`;
      continue;
    }
    if (h.investmentId && h.tokenAddress) {
      // Withdrawing spends gas and moves money, so it goes through the same
      // staged nonce as a deposit rather than firing straight off a button.
      for (const [pct, ratio] of [["Withdraw half", 0.5], ["Withdraw all", 1]]) {
        keys.push([{
          text: `${pct} · ${h.asset}`,
          callback_data: `stage:${stage({
            action: "redeem", investmentId: h.investmentId, tokenAddress: h.tokenAddress,
            ratio, label: `${h.protocol} ${h.asset}`, ownerId: userId })}`,
        }]);
      }
    }
  }
  keys.push(BACK);

  return send(chat,
    `*Total on BNB Smart Chain: $${esc(r.totalUsd.toFixed(2))}*\n\n${rows.join("\n\n")}\n\n` +
    `_Earnings are the position now, minus what I sent\\. Lending accrues slowly, so early ` +
    `figures are small rather than wrong\\._`, { inline_keyboard: keys });
}

/** Show exactly what is about to happen, then require one more tap. */
async function confirmStage(chat, nonce, userId) {
  const i = peek(nonce);
  if (!i || String(i.ownerId) !== String(userId)) {
    return send(chat, "That confirmation has expired\\. Run the check again\\.", HOME_KEYS);
  }
  const isRedeem = i.action === "redeem";
  // The nonce behind a product button is staged with a placeholder amount and
  // resized before it can be confirmed. Confirming one that never got resized
  // would send a deposit of nothing, which is not dangerous but is not a state
  // worth having.
  if (!isRedeem && !(Number(i.amount) > 0)) {
    return send(chat, "No amount was chosen for that one\\. Pick a size first\\.", HOME_KEYS);
  }
  const what = isRedeem
    ? `Withdrawing *${i.ratio === 1 ? "all" : `${Math.round(i.ratio * 100)}%`}* of your position ` +
      `in *${esc(i.label)}*\\.`
    : `Depositing *${esc(String(i.amount))}* into *${esc(i.label)}*\\.`;

  return send(chat,
    `⚠️ *About to move real money\\.*\n\n${what}\n\n` +
    `This broadcasts a transaction on BNB Smart Chain and cannot be undone from here\\.`,
    { inline_keyboard: [
      [{ text: isRedeem ? "✅ Yes, withdraw now" : "✅ Yes, deposit now", callback_data: `go:${nonce}` }],
      [{ text: "✖️ Cancel", callback_data: "home" }],
    ] });
}

async function doDeposit(chat, nonce, userId) {
  await typing(chat);
  const m = await send(chat, `📡 Sending\\.\\.\\.`);
  const r = await commit(nonce, userId);
  const mid = m?.result?.message_id;

  if (!r.ok) {
    const c = classify(r.error);
    return edit(chat, mid, `⛔️ *Did not go through\\.*\n\n${esc(c.title)}\n\n${esc(c.detail)}`,
      HOME_KEYS);
  }
  const tx = r.data?.txHash ?? "";
  const isRedeem = r.intent.action === "redeem";
  // A queued redemption is not a completed one. Calling it "withdrew" would
  // leave someone waiting for money that needs a second transaction to arrive.
  const delay = (r.data?.redeemDelayDays ?? []).filter(Boolean);
  const wait = delay.length
    ? `\n\n⏳ *${esc(delay[0] === delay[delay.length - 1] ? `${delay[0]} days` : `${delay[0]} to ${delay[delay.length - 1]} days`)}* ` +
      `before this can be claimed\\. The funds are not in your wallet yet — come back after ` +
      `the wait and claim them\\.`
    : "";
  const done = isRedeem
    ? (delay.length
        ? `Submitted a withdrawal of ${r.intent.ratio === 1 ? "all" : `${Math.round(r.intent.ratio * 100)}%`} ` +
          `of *${esc(r.intent.label)}*\\.`
        : `Withdrew ${r.intent.ratio === 1 ? "all" : `${Math.round(r.intent.ratio * 100)}%`} of ` +
          `*${esc(r.intent.label)}*\\.`)
    : `Deposited *${esc(String(r.intent.amount))}* into *${esc(r.intent.label)}*\\.`;
  return edit(chat, mid,
    `✅ *Sent\\.*\n\n${done}${wait}\n\n\`${esc(tx)}\`\n\n` +
    `[View on BscScan](https://bscscan.com/tx/${tx})\n\n` +
    `_Submitted, not yet confirmed\\. Balances take a moment to catch up\\._`,
    HOME_KEYS);
}

/** The side by side: no preflight, then preflight, on the same product. */
async function runCompare(chat) {
  await typing(chat);
  const items = await products("LiquidityPool");
  if (!items) return send(chat, "Could not reach the Binance listing right now\\.", HOME_KEYS);

  const m = await send(chat,
    `*Round 1 · an agent with no preflight*\n\n` +
    `_I am giving a model the Binance listing and nothing else, which is exactly what an agent ` +
    `has today\\. Asking it to find the best yield and deposit\\._`);

  const pick = await unguardedPick(items);
  const target = (pick?.idPrefix && items.find((i) => i.investmentId.startsWith(pick.idPrefix))) || items[0];
  const label = `${target.protocolName} ${target.investmentName} @ ${target.apyDisplay}`;

  await edit(chat, m?.result?.message_id,
    `*Round 1 · an agent with no preflight*\n\n` +
    `It chose *${esc(label)}*\\.\n` +
    (pick?.reason ? `_“${esc(pick.reason)}”_\n` : "") +
    `\nGoing by the listing alone, that answer is perfectly reasonable\\.`);

  await typing(chat);
  const m2 = await send(chat, `*Round 2 · same product, checked*\n\n_Working\\.\\.\\._`);
  const v = await preflight({ investment: target, amount: 0.002, chainId: "56" });
  return edit(chat, m2?.result?.message_id,
    `*Round 2 · same product, checked*\n\n${renderVerdict(label, v)}`,
    { inline_keyboard: [BACK] });
}

// ---------------------------------------------------------------- routing

async function onCallback(q) {
  const chat = q.message.chat.id;
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  if (!ALLOWED.includes(String(q.from?.id ?? ""))) return;

  const d = q.data ?? "";
  const userId = q.from?.id;
  if (d === "home") return showHome(chat);
  if (d === "help") return send(chat, HELP, { inline_keyboard: [BACK] });
  if (d === "compare") return runCompare(chat);
  if (d === "work") return putToWork(chat, userId);
  if (d === "pos") return showPositions(chat, userId);
  if (d === "bal") return showBalance(chat);
  if (d.startsWith("pick:")) return showPick(chat, d.slice(5), userId);
  if (d.startsWith("amt:")) return askAmount(chat, d.slice(4), userId);
  if (d.startsWith("rep:")) {
    const r = reports.get(d.slice(4));
    return send(chat, r && Date.now() - r.at <= REPORT_TTL_MS
      ? r.text
      : "That report has expired\\. Run the check again\\.", { inline_keyboard: [BACK] });
  }
  if (d.startsWith("stage:")) return confirmStage(chat, d.slice(6), userId);
  if (d.startsWith("go:")) return doDeposit(chat, d.slice(3), userId);
  if (d.startsWith("list:")) return showList(chat, d.slice(5));
  if (d.startsWith("chk:")) {
    const [, tag, idPrefix] = d.split(":");
    const type = tag === "L" ? "LiquidityPool" : "Earn";
    const items = await products(type);
    const target = items?.find((i) => i.investmentId.startsWith(idPrefix));
    if (!target) return send(chat, "That product has left the listing\\.", HOME_KEYS);
    return runCheck(chat, target, type);
  }
}

async function handle(msg) {
  const chat = msg.chat.id;
  const from = String(msg.from?.id ?? "");
  const text = (msg.text ?? "").trim();

  if (!ALLOWED.includes(from)) {
    return send(chat,
      `This bot is not open to the public\\.\n\nYour Telegram id is \`${esc(from)}\`\\. ` +
      `Add it to *ALLOWED\\_USER\\_IDS* in \`.env\` and restart\\.`);
  }

  // Someone asked to type an amount, so a bare number is an amount and not a
  // half-finished sentence to route through the model. Commands still escape,
  // so nobody gets stuck in here.
  if (!text.startsWith("/") && await takeAmount(chat, from, text)) return;

  if (/^\/(start|home)\b/.test(text) || !text.startsWith("/") && text.length < 3) return showHome(chat);
  if (/^\/help\b/.test(text)) return send(chat, HELP, { inline_keyboard: [BACK] });
  if (/^\/compare\b/.test(text)) return runCompare(chat);
  if (/^\/positions\b/.test(text) || /\b(position|holding|earned|profit)\b/i.test(text))
    return showPositions(chat, msg.from?.id);
  if (/^\/work\b/.test(text) || /\b(deposit|invest|put .*(money|bnb).*work)\b/i.test(text))
    return putToWork(chat, msg.from?.id);
  if (/^\/earn\b/.test(text)) return showList(chat, "Earn");
  if (/^\/balance\b/.test(text) || /\b(balance|wallet|address|portfolio)\b/i.test(text))
    return showBalance(chat);

  // Plain language. The model picks what to look at; it decides nothing else.
  await typing(chat);
  // Asking about pools used to switch the whole session onto a listing this bot
  // cannot deposit into. Answering the question honestly is better than routing
  // someone into a dead end.
  if (/\b(pool|lp|liquidity)\b/i.test(text)) {
    return send(chat,
      `I do not enter liquidity pools\\.\n\n` +
      `Depositing into one means supplying two assets at once, inside a price range, and the ` +
      `advertised APR is a trading fee rate rather than a yield\\. That is a different product ` +
      `with different ways to lose money, and I am not going to half\\-build it\\.\n\n` +
      `What I do is lending: one asset in, one asset out, checked against the chain first\\.`,
      HOME_KEYS);
  }
  const type = "Earn";
  const items = await products(type);
  if (!items) return send(chat, "Could not reach the Binance listing right now\\.", HOME_KEYS);

  const intent = await routeMessage(text, items);
  if (intent?.action === "help") return send(chat, HELP, { inline_keyboard: [BACK] });
  if (intent?.action === "compare") return runCompare(chat);
  if (intent?.action === "list") return showList(chat, type);

  const target = (intent?.idPrefix && items.find((i) => i.investmentId.startsWith(intent.idPrefix)))
    || bestMatch(items, text.replace(/^check\s+/i, ""));

  if (!target) {
    return send(chat,
      `I could not tell which product you meant\\. Pick one from a list instead\\.`, HOME_KEYS);
  }
  return runCheck(chat, target, type);
}

// ---------------------------------------------------------------- loop

let offset = 0;
async function poll() {
  try {
    const r = await tg("getUpdates", { offset, timeout: 30 });
    for (const u of r.result ?? []) {
      offset = u.update_id + 1;
      if (u.message?.text) handle(u.message).catch((e) => console.error("handle:", e.message));
      if (u.callback_query) onCallback(u.callback_query).catch((e) => console.error("cb:", e.message));
    }
  } catch (e) {
    console.error("poll:", e.message);
    await new Promise((r) => setTimeout(r, 3000));
  }
  setImmediate(poll);
}

const me = await tg("getMe", {});
const w = await walletStatus();
console.log(`\n  nullius bot — @${me.result?.username}`);
console.log(`  wallet: ${w.ok ? w.data.status : "unreachable"}`);
console.log(`  model: ${LLM.key ? LLM.model : "none (matching only)"}`);
console.log(`  allowed: ${ALLOWED.join(", ") || "nobody yet"}\n`);
poll();
