// Telegram front end.
//
// The bot can read and simulate. It cannot deposit: `baw.js` enforces a
// read-only allowlist at the wrapper level, and `defi deposit` is not on it.
// That is not a policy the model is asked to respect — it is a call it cannot
// make, whatever it decides.

import { readFileSync, existsSync } from "node:fs";
import { listInvestments, walletStatus } from "./baw.js";
import { preflight, PASS, WARN, BLOCK, UNTESTED } from "./checks.js";

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
const ALLOWED = (process.env.ALLOWED_USER_IDS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const LLM = {
  key: process.env.LLM_API_KEY,
  base: process.env.LLM_BASE_URL ?? "https://api.deepseek.com",
  model: process.env.LLM_MODEL ?? "deepseek-chat",
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
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

const esc = (s) => String(s ?? "").replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");

const MENU = {
  inline_keyboard: [
    [{ text: "Earn products", callback_data: "list:Earn" },
     { text: "Liquidity pools", callback_data: "list:LiquidityPool" }],
    [{ text: "Show me the trap", callback_data: "compare" }],
    [{ text: "What is this?", callback_data: "help" }],
  ],
};

const send = (chat, text, markup = MENU) =>
  tg("sendMessage", { chat_id: chat, text, parse_mode: "MarkdownV2",
                      reply_markup: markup,
                      link_preview_options: { is_disabled: true } });

/** Buttons for a list of products, so nobody has to type an id. */
function productKeys(items, type) {
  const rows = items.slice(0, 6).map((i) => [{
    text: `${i.investmentName} · ${i.protocolName} · ${i.apyDisplay}`,
    callback_data: `chk:${type === "LiquidityPool" ? "L" : "E"}:${i.investmentId.slice(0, 24)}`,
  }]);
  rows.push([{ text: "Back", callback_data: "help" }]);
  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------- rendering

function renderVerdict(label, v) {
  const head = v.verdict === "GO"
    ? `✅ *GO* — ${esc(label)}`
    : v.reason === "failed"
      ? `⛔️ *NO\\-GO* — ${esc(label)}`
      : `◽️ *NO\\-GO, unverified* — ${esc(label)}`;
  const body = v.checks
    .map((c) => `${MARK[c.level]} *${esc(c.title)}*\n${esc(c.detail)}`)
    .join("\n\n");
  const tail = v.verdict === "GO"
    ? ""
    : v.reason === "failed"
      ? "\n\n_A check failed outright\\._"
      : "\n\n_Nothing failed — but it could not be verified, and that is not permission\\._";
  return `${head}\n\n${body}${tail}`;
}

function renderList(items, type) {
  const head = type === "LiquidityPool"
    ? "*Liquidity pools on BNB Smart Chain*\n\nThese report APR, which is an annualised trading " +
      "fee rate\\. It is not a return anyone receives and it says nothing about impermanent loss\\."
    : "*Earn products on BNB Smart Chain*\n\nThese report APY, a yield\\.";
  return `${head}\n\nTap one to run the full check\\. Nothing gets broadcast\\.`;
}

/**
 * What an agent with no preflight would do.
 *
 * The model is shown exactly what the listing shows and nothing else, because
 * that is the whole situation an unguarded agent is in.
 */
async function unguardedPick(items) {
  if (!LLM.key) return null;
  const menu = items.slice(0, 15)
    .map((i) => `${i.investmentId.slice(0, 8)} | ${i.protocolName} | ${i.investmentName} | ` +
                `${i.apyDisplay} | TVL $${Math.round(Number(i.tvl)).toLocaleString("en-US")}`)
    .join("\n");
  const prompt =
    `You manage a crypto wallet. The user says: "find me the best yield on BNB Chain and put my ` +
    `money in". Here is the product listing you have access to:\n\n${menu}\n\n` +
    `Pick one and state your reasoning in at most 25 words. Reply as JSON only: ` +
    `{"idPrefix":"<8 chars>","reason":"<your reasoning>"}`;
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

// ---------------------------------------------------------------- intent

/** Deterministic fallback: pick the product whose text best matches the query. */
function bestMatch(items, query) {
  const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (q.length === 0) return null;
  let best = null;
  for (const i of items) {
    const hay = `${i.protocolName} ${i.investmentName}`.toLowerCase();
    const score = q.reduce((s, w) => s + (hay.includes(w) ? w.length : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { score, item: i };
  }
  return best?.item ?? null;
}

/**
 * Ask the model what the user wants. The model chooses which product to look at.
 * It never chooses whether to proceed — the checks decide that, and the wrapper
 * would refuse a deposit regardless of what came back here.
 */
async function classify(text, items) {
  if (!LLM.key) return null;
  const menu = items.slice(0, 40)
    .map((i) => `${i.investmentId.slice(0, 8)} ${i.protocolName} ${i.investmentName} ${i.apyDisplay}`)
    .join("\n");
  const prompt =
    `You route messages for a tool that verifies Binance DeFi products before a deposit.\n` +
    `Products (id-prefix, protocol, asset, rate):\n${menu}\n\n` +
    `Reply with JSON only: {"action":"list"|"check"|"help","idPrefix":"<8 chars or null>"}.\n` +
    `Pick "check" and an idPrefix when the user names or describes one product, including ` +
    `superlatives such as "the highest rate". Pick "list" to show the menu.\n\n` +
    `Message: ${text}`;
  try {
    const r = await fetch(`${LLM.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${LLM.key}` },
      body: JSON.stringify({
        model: LLM.model, temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const j = await r.json();
    const raw = j?.choices?.[0]?.message?.content ?? "";
    const m = /\{[\s\S]*\}/.exec(raw);
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- handling

const HELP =
  "*Nullius*\n\nTake nobody's word for it\\.\n\n" +
  "Binance hands an agent a protocol name and a rate, then lets it move your money on that\\. " +
  "The listing never says which contract you are actually entering\\.\n\n" +
  "So before anything is signed I simulate the deposit, which forces the real contract address " +
  "into the open, and then I ask the chain itself what that contract is\\. If the answer does not " +
  "match the listing, I stop\\. If there is no answer at all, I still stop\\.\n\n" +
  "I have a model to read your messages and no way to spend anything\\. The wrapper I call " +
  "through only permits reads and simulations, so `defi deposit` is not a call I can make\\.";

const cache = { Earn: null, LiquidityPool: null, at: 0 };

async function products(type) {
  const fresh = Date.now() - cache.at < 120_000;
  if (fresh && cache[type]) return cache[type];
  const r = await listInvestments(type, "56");
  if (!r.ok) return null;
  cache[type] = r.data.list
    .map((i) => ({ ...i, investType: type }))
    .sort((a, b) => Number(b.apyBps) - Number(a.apyBps));
  cache.at = Date.now();
  return cache[type];
}

/** Run one product through the checks and reply. */
async function runCheck(chat, target, type) {
  const label = `${target.protocolName} ${target.investmentName} @ ${target.apyDisplay}`;
  await send(chat, `Checking *${esc(label)}*\\.\nNothing gets broadcast\\.`, undefined);
  const amount = type === "LiquidityPool" ? 0.002 : 0.005;
  const v = await preflight({ investment: target, amount, chainId: "56" });
  await send(chat, renderVerdict(label, v));
}

/**
 * The side by side. Same listing, same top rate, two different endings:
 * what a model does with the listing alone, and what happens once the
 * contract behind it is actually checked.
 */
async function runCompare(chat) {
  const items = await products("LiquidityPool");
  if (!items) return send(chat, "Could not reach the DeFi listing\\.");

  await send(chat,
    "*Round one\\. No preflight\\.*\n\nI am giving a model the listing and nothing else, " +
    "which is exactly what an agent gets today\\.", undefined);

  const pick = await unguardedPick(items);
  const target = pick?.idPrefix
    ? items.find((i) => i.investmentId.startsWith(pick.idPrefix)) ?? items[0]
    : items[0];
  const label = `${target.protocolName} ${target.investmentName} @ ${target.apyDisplay}`;

  await send(chat,
    `It picked *${esc(label)}*\\.\n\n` +
    (pick?.reason ? `_${esc(pick.reason)}_\n\n` : "") +
    `On the listing alone there is nothing wrong with that answer\\.`, undefined);

  await send(chat, "*Round two\\. Same product, checked\\.*", undefined);
  const v = await preflight({ investment: target, amount: 0.002, chainId: "56" });
  await send(chat, renderVerdict(label, v));
}

async function onCallback(q) {
  const chat = q.message.chat.id;
  const from = String(q.from?.id ?? "");
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  if (!ALLOWED.includes(from)) return;

  const data = q.data ?? "";
  if (data === "help") return send(chat, HELP);
  if (data === "compare") return runCompare(chat);

  if (data.startsWith("list:")) {
    const type = data.slice(5);
    const items = await products(type);
    if (!items) return send(chat, "Could not reach the DeFi listing\\.");
    return tg("sendMessage", { chat_id: chat, text: renderList(items, type),
      parse_mode: "MarkdownV2", reply_markup: productKeys(items, type) });
  }

  if (data.startsWith("chk:")) {
    const [, tag, idPrefix] = data.split(":");
    const type = tag === "L" ? "LiquidityPool" : "Earn";
    const items = await products(type);
    const target = items?.find((i) => i.investmentId.startsWith(idPrefix));
    if (!target) return send(chat, "That product is no longer in the listing\\.");
    return runCheck(chat, target, type);
  }
}

async function handle(msg) {
  const chat = msg.chat.id;
  const from = String(msg.from?.id ?? "");
  const text = (msg.text ?? "").trim();

  if (!ALLOWED.includes(from)) {
    await send(chat,
      `This bot is not open to the public\\.\n\nYour Telegram id is \`${esc(from)}\` — ` +
      `add it to *ALLOWED\\_USER\\_IDS* in \`.env\` and restart to use it\\.`);
    return;
  }

  if (/^\/(start|help)\b/.test(text)) return send(chat, HELP);
  if (/^\/compare\b/.test(text) || /\btrap\b/i.test(text)) return runCompare(chat);

  const wantsPools = /^\/pools\b/.test(text) || /\b(pool|lp|liquidity)\b/i.test(text);
  const type = wantsPools ? "LiquidityPool" : "Earn";

  if (/^\/(earn|pools)\b/.test(text)) {
    const items = await products(type);
    if (!items) return send(chat, "Could not reach the DeFi listing\\.");
    return tg("sendMessage", { chat_id: chat, text: renderList(items, type),
      parse_mode: "MarkdownV2", reply_markup: productKeys(items, type) });
  }

  const items = await products(type);
  if (!items) return send(chat, "Could not reach the DeFi listing\\.");

  let target = null;
  const stripped = text.replace(/^check\s+/i, "").trim();

  const intent = await classify(text, items);
  if (intent?.action === "help") return send(chat, HELP);
  if (intent?.action === "list") return send(chat, renderList(items, type));
  if (intent?.idPrefix) {
    target = items.find((i) => i.investmentId.startsWith(intent.idPrefix)) ?? null;
  }
  if (!target) target = bestMatch(items, stripped);

  if (!target) {
    return send(chat,
      "I could not tell which product you meant\\. Try `/earn` or `/pools` for the list\\.");
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
      if (u.message?.text) await handle(u.message).catch((e) => console.error("handle:", e.message));
      if (u.callback_query) await onCallback(u.callback_query).catch((e) => console.error("cb:", e.message));
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
console.log(`  allowed ids: ${ALLOWED.length ? ALLOWED.join(", ") : "none yet — message the bot to learn yours"}\n`);
poll();
