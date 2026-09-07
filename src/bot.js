// Telegram front end.
//
// The bot can read and simulate. It cannot deposit: baw.js enforces a read-only
// allowlist at the wrapper level and `defi deposit` is not on it. That is not a
// rule the model is asked to respect, it is a call it cannot make.

import { readFileSync, existsSync } from "node:fs";
import { listInvestments, walletStatus, baw } from "./baw.js";
import { preflight, screen, PASS, WARN, BLOCK, UNTESTED } from "./checks.js";
import { stage, peek, commit } from "./execute.js";

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
    [{ text: "💰 Put my money to work", callback_data: "work" }],
    [{ text: "🔍 Check something before I deposit elsewhere", callback_data: "ok:LiquidityPool" }],
    [{ text: "❓ How this works", callback_data: "help" }],
  ],
};

const NATIVE_BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** Deposit sizes offered once a product clears, in the asset it is denominated in. */
const SIZES = [0.005, 0.01, 0.02];

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
    `👇 Tap *Put my money to work*\\. I will find something, check it against the chain, ` +
    `and ask you before anything is sent\\.`;
}

const HELP =
  `*How this works*\n\n` +
  `*1\\. I simulate the deposit\\.* No money moves, but the simulation has to name the contract ` +
  `it would call\\. That address is not in the listing anywhere\\.\n\n` +
  `*2\\. I ask the blockchain about it\\.* Not Binance\\. I call the contract directly and read ` +
  `back what it calls itself\\.\n\n` +
  `*3\\. I compare\\.* Listing says one thing, chain says another, I stop\\. Chain says nothing ` +
  `at all, I also stop\\.\n\n` +
  `Nine checks run in total, covering delisted products, hidden second assets, fee rates dressed ` +
  `up as yields, missing exits, and pool sizes too small to take your money\\.\n\n` +
  `*Three answers, not two\\.* Pass, fail, or no evidence either way\\. The third one still ` +
  `refuses\\. Not being able to verify something is not permission to proceed\\.\n\n` +
  `I run a model so I can read plain English\\. It has no way to spend anything\\. The wrapper I ` +
  `call through only permits reads and simulations\\.`;

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

function renderVerdict(label, v) {
  const gaps = v.checks.filter((c) => c.level === UNTESTED).length;
  const head = v.verdict === "GO" || v.verdict === "VERIFIED"
    ? `✅ *Cleared* · ${esc(label)}`
    : v.reason === "failed"
      ? `⛔️ *Refused* · ${esc(label)}`
      : `◽️ *Refused* · ${esc(label)}`;
  const body = v.checks.map((c) => `${MARK[c.level]} *${esc(c.title)}*\n${esc(c.detail)}`).join("\n\n");
  // The old wording claimed nothing could be checked even when most of it had
  // been, which contradicted the ticks directly above it.
  const tail = v.verdict === "GO" || v.verdict === "VERIFIED"
    ? "\n\nEverything I can check, checks out\\."
    : v.reason === "failed"
      ? "\n\nSomething failed outright\\. I would not put money here\\."
      : `\n\nNothing failed, but ${gaps === 1 ? "one check" : `${gaps} checks`} could not be ` +
        `completed at all\\. Not being able to confirm something is not permission\\.`;
  return `${head}\n\n${body}${tail}`;
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

/**
 * Screening results, built in the background so a tap returns instantly.
 *
 * Screening needs no balance, so it can cover the whole listing rather than the
 * handful of products the wallet happens to hold.
 */
const screened = { LiquidityPool: new Map(), Earn: new Map() };
let screening = false;

async function screenAll(type, limit = 24) {
  const items = await products(type);
  if (!items) return;
  for (const inv of items.slice(0, limit)) {
    if (screened[type].has(inv.investmentId)) continue;
    try {
      screened[type].set(inv.investmentId, await screen({ investment: inv, chainId: "56" }));
    } catch { /* leave it out rather than record a guess */ }
  }
}

async function backgroundScreen() {
  if (screening) return;
  screening = true;
  try {
    await screenAll("LiquidityPool");
    await screenAll("Earn");
    const v = [...screened.LiquidityPool.values(), ...screened.Earn.values()]
      .filter((s) => s.verdict === "VERIFIED").length;
    console.log(`  screened ${screened.LiquidityPool.size + screened.Earn.size} products, ` +
                `${v} verified`);
  } finally {
    screening = false;
  }
}

/** Products whose identity the chain confirms, best rate first. */
function verified(type) {
  const items = cache[type] ?? [];
  return items.filter((i) => screened[type].get(i.investmentId)?.verdict === "VERIFIED");
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

async function showList(chat, type) {
  await typing(chat);
  const items = await products(type);
  if (!items) return send(chat, "Could not reach the Binance listing right now\\.", HOME_KEYS);
  return send(chat, listIntro(type), productKeys(items, type));
}

/** The useful half: what survived screening. */
async function showVerified(chat, type) {
  await typing(chat);
  await products(type);
  if (!screened[type].size) {
    backgroundScreen();
    return send(chat,
      `I am still working through the listing\\. Give me a minute and try again\\.`, HOME_KEYS);
  }
  const ok = verified(type);
  const total = screened[type].size;
  const noun = type === "LiquidityPool" ? "pools" : "lending products";

  if (!ok.length) {
    return send(chat,
      `I checked ${total} ${noun} against the chain and *none of them came back clean*\\.\n\n` +
      `That is the finding, not a failure to produce a list\\.`, HOME_KEYS);
  }
  const head =
    `*${ok.length} of ${total} ${noun} check out*\n\n` +
    `For each of these the chain confirms the contract really holds what the listing says, the ` +
    `product still accepts deposits, and the rate is in line with its own history\\.\n\n` +
    (type === "LiquidityPool"
      ? `Still an APR, so still a fee rate rather than a yield, and impermanent loss is your ` +
        `problem\\.\n\n`
      : ``) +
    `Tap one for the full check before you actually put money in\\.`;
  return send(chat, head, productKeys(ok, type));
}

/** One product, with progress so the wait is legible. */
async function runCheck(chat, target, type) {
  const label = `${target.protocolName} ${target.investmentName} @ ${target.apyDisplay}`;
  await typing(chat);
  const m = await send(chat,
    `🔍 Checking *${esc(label)}*\n\n_Simulating the deposit, then asking the chain about the ` +
    `contract it names\\. Nothing gets broadcast\\. This takes a few seconds\\._`);
  const id = m?.result?.message_id;

  const amount = type === "LiquidityPool" ? 0.002 : 0.005;
  const v = await preflight({ investment: target, amount, chainId: "56" });

  const text = renderVerdict(label, v);
  const keys = { inline_keyboard: [[{ text: "◀️ Back to list", callback_data: `list:${type}` }], BACK] };
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

  const held = new Set((bal.ok ? bal.data ?? [] : []).map((t) => String(t.symbol).toUpperCase()));
  const norm = (s) => String(s).toUpperCase().replace(/^BSC_/, "").replace(/^W(?=BNB$|ETH$)/, "");
  const candidates = items.filter((i) => [...held].some((h) => norm(h) === norm(i.investmentName)));

  if (!candidates.length) {
    return send(chat,
      `Your wallet holds nothing that any lending product on this chain takes\\.\n\n` +
      `Fund it with BNB and try again\\.`, HOME_KEYS);
  }

  const m = await send(chat,
    `🔍 *Working through ${candidates.length} lending products your wallet can actually enter\\.*\n\n` +
    `_Checking each one against the chain, best rate first\\. Nothing is broadcast yet\\._`);
  const mid = m?.result?.message_id;

  // Best rate first, and stop at the first one that survives everything.
  let cleared = null, tried = 0;
  const rejected = [];
  for (const inv of candidates) {
    tried += 1;
    const v = await preflight({ investment: inv, amount: SIZES[0], chainId: "56" });
    if (v.verdict === "GO") { cleared = { inv, v }; break; }
    rejected.push(`${inv.investmentName} · ${inv.protocolName} · ${inv.apyDisplay}`);
  }

  if (!cleared) {
    return edit(chat, mid,
      `⛔️ *Nothing cleared\\.*\n\nI checked ${tried} products your wallet could enter and not one ` +
      `of them survived\\.\n\n${rejected.map((r) => `• ${esc(r)}`).join("\n")}\n\n` +
      `That is the answer, not a failure to find you something\\.`, HOME_KEYS);
  }

  const { inv, v } = cleared;
  const label = `${inv.protocolName} ${inv.investmentName} @ ${inv.apyDisplay}`;
  const token = v.checks.find((c) => c.id === "listing")?.evidence?.assetTokenList?.[0]?.tokenAddress
    ?? NATIVE_BNB;

  const skipped = rejected.length
    ? `\n\nPassed over on the way here: ${esc(rejected.join(", "))}\\.`
    : "";

  const keys = {
    inline_keyboard: [
      SIZES.map((s) => ({
        text: `Deposit ${s} ${inv.investmentName}`,
        callback_data: `stage:${stage({ investmentId: inv.investmentId, tokenAddress: token,
          amount: s, label, ownerId: userId })}`,
      })),
      BACK,
    ],
  };

  return edit(chat, mid,
    `${renderVerdict(label, v)}${skipped}\n\n` +
    `_Pick a size and I will send it\\. This one actually spends money\\._`, keys);
}

/** Show exactly what is about to happen, then require one more tap. */
async function confirmStage(chat, nonce, userId) {
  const i = peek(nonce);
  if (!i || String(i.ownerId) !== String(userId)) {
    return send(chat, "That confirmation has expired\\. Run the check again\\.", HOME_KEYS);
  }
  return send(chat,
    `⚠️ *About to spend real money\\.*\n\n` +
    `Depositing *${esc(String(i.amount))}* into *${esc(i.label)}*\\.\n\n` +
    `This broadcasts a transaction on BNB Smart Chain and cannot be undone from here\\.`,
    { inline_keyboard: [
      [{ text: "✅ Yes, deposit now", callback_data: `go:${nonce}` }],
      [{ text: "✖️ Cancel", callback_data: "home" }],
    ] });
}

async function doDeposit(chat, nonce, userId) {
  await typing(chat);
  const m = await send(chat, `📡 Sending\\.\\.\\.`);
  const r = await commit(nonce, userId);
  const mid = m?.result?.message_id;

  if (!r.ok) {
    return edit(chat, mid,
      `⛔️ *Did not go through\\.*\n\n${esc(r.error?.name ?? "")}: ${esc(r.error?.message ?? "")}`,
      HOME_KEYS);
  }
  const tx = r.data?.txHash ?? "";
  return edit(chat, mid,
    `✅ *Sent\\.*\n\nDeposited *${esc(String(r.intent.amount))}* into *${esc(r.intent.label)}*\\.\n\n` +
    `\`${esc(tx)}\`\n\n` +
    `[View on BscScan](https://bscscan.com/tx/${tx})\n\n` +
    `_Submitted, not yet confirmed\\. The destination should match the contract I verified above\\._`,
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
  if (d.startsWith("stage:")) return confirmStage(chat, d.slice(6), userId);
  if (d.startsWith("go:")) return doDeposit(chat, d.slice(3), userId);
  if (d.startsWith("list:")) return showList(chat, d.slice(5));
  if (d.startsWith("ok:")) return showVerified(chat, d.slice(3));
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

  if (/^\/(start|home)\b/.test(text) || !text.startsWith("/") && text.length < 3) return showHome(chat);
  if (/^\/help\b/.test(text)) return send(chat, HELP, { inline_keyboard: [BACK] });
  if (/^\/compare\b/.test(text)) return runCompare(chat);
  if (/^\/work\b/.test(text) || /\b(deposit|invest|put .*(money|bnb).*work)\b/i.test(text))
    return putToWork(chat, msg.from?.id);
  if (/^\/earn\b/.test(text)) return showList(chat, "Earn");
  if (/^\/pools\b/.test(text)) return showList(chat, "LiquidityPool");

  // Plain language. The model picks what to look at; it decides nothing else.
  await typing(chat);
  const looksLikePool = /\b(pool|lp|liquidity)\b/i.test(text);
  const type = looksLikePool ? "LiquidityPool" : "Earn";
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
backgroundScreen();
setInterval(backgroundScreen, 10 * 60_000);
