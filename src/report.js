// Self-contained HTML report. No external assets, no network, opens offline.

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const LEVEL = {
  PASS:     { cls: "pass",  mark: "✓" },
  WARN:     { cls: "warn",  mark: "!" },
  BLOCK:    { cls: "block", mark: "✗" },
  UNTESTED: { cls: "untested", mark: "–" },
};

function checkRow(c) {
  const l = LEVEL[c.level] ?? LEVEL.WARN;
  return `<div class="chk ${l.cls}">
    <span class="mk">${l.mark}</span>
    <div><div class="ct">${esc(c.title)}</div><div class="cd">${esc(c.detail)}</div></div>
  </div>`;
}

function card(run) {
  const go = run.verdict === "GO";
  const apy = run.investment?.apyDisplay ?? "";
  return `<section class="card ${go ? "go" : "nogo"}">
    <header>
      <div>
        <h3>${esc(run.label ?? "")}</h3>
        <div class="sub">${esc(run.investment?.protocolName ?? "")} · ${esc(apy)}</div>
      </div>
      <div class="verdict ${go ? "vgo" : "vnogo"}">${go ? "GO" : "NO-GO"}</div>
    </header>
    <div class="checks">${(run.checks ?? []).map(checkRow).join("")}</div>
  </section>`;
}

export function renderReport(runs, { amount, chainId, demo } = {}) {
  const go = runs.filter((r) => r.verdict === "GO").length;
  const failed = runs.filter((r) => r.reason === "failed").length;
  const unverified = runs.filter((r) => r.reason === "unverified").length;
  const all = runs.flatMap((r) => r.checks ?? []);
  const reasons = [...new Set(all.filter((c) => c.level === "BLOCK").map((c) => c.title))];
  const gaps = [...new Set(all.filter((c) => c.level === "UNTESTED").map((c) => c.title))];

  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>defi-preflight report</title>
<style>
  :root{--bg:#0f1115;--fg:#e7e9ee;--dim:#9aa3b2;--line:#232733;--card:#161923;
        --pass:#3fb950;--warn:#d29922;--block:#f85149;--accent:#f0b90b}
  @media(prefers-color-scheme:light){:root{--bg:#fff;--fg:#14171f;--dim:#5b6472;
        --line:#e5e8ee;--card:#fafbfc}}
  *{box-sizing:border-box}
  body{margin:0;padding:40px 20px;background:var(--bg);color:var(--fg);
       font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:860px;margin:0 auto}
  h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em}
  .lede{color:var(--dim);margin:0 0 28px;max-width:62ch}
  .bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:28px}
  .stat{flex:1;min-width:140px;border:1px solid var(--line);border-radius:10px;
        padding:14px 16px;background:var(--card)}
  .stat b{display:block;font-size:24px;letter-spacing:-.02em}
  .stat span{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
  .card{border:1px solid var(--line);border-radius:12px;background:var(--card);
        margin-bottom:14px;overflow:hidden}
  .card.nogo{border-color:color-mix(in srgb,var(--block) 40%,var(--line))}
  header{display:flex;justify-content:space-between;align-items:center;gap:16px;
         padding:16px 18px;border-bottom:1px solid var(--line)}
  h3{margin:0;font-size:16px}
  .sub{color:var(--dim);font-size:13px}
  .verdict{font-weight:700;font-size:13px;letter-spacing:.06em;padding:5px 12px;border-radius:999px}
  .vgo{color:var(--pass);background:color-mix(in srgb,var(--pass) 14%,transparent)}
  .vnogo{color:var(--block);background:color-mix(in srgb,var(--block) 14%,transparent)}
  .checks{padding:6px 18px 14px}
  .chk{display:flex;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)}
  .chk:last-child{border-bottom:0}
  .mk{width:20px;flex:0 0 20px;text-align:center;font-weight:700}
  .pass .mk{color:var(--pass)}.warn .mk{color:var(--warn)}.block .mk{color:var(--block)}
  .untested .mk{color:var(--dim)}.untested .ct{color:var(--dim)}
  .ct{font-weight:600;font-size:14px}
  .cd{color:var(--dim);font-size:13px}
  .why{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;
       padding:14px 18px;background:var(--card);margin-bottom:28px}
  .why h2{margin:0 0 6px;font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}
  .why ul{margin:8px 0 0;padding-left:18px}
  footer{color:var(--dim);font-size:12px;margin-top:32px;border-top:1px solid var(--line);padding-top:16px}
  code{background:color-mix(in srgb,var(--fg) 8%,transparent);padding:1px 5px;border-radius:4px;font-size:12px}
</style>
<div class="wrap">
  <h1>defi-preflight</h1>
  <p class="lede">Every opportunity below was simulated but never broadcast. The contract each
  deposit would actually touch was read back from the simulation and checked against the BNB Smart
  Chain itself. Anything that could not be verified is refused — inability to verify is not permission.</p>

  <div class="bar">
    <div class="stat"><b>${runs.length}</b><span>screened</span></div>
    <div class="stat"><b style="color:var(--pass)">${go}</b><span>cleared</span></div>
    <div class="stat"><b style="color:var(--block)">${failed}</b><span>failed a check</span></div>
    <div class="stat"><b style="color:var(--dim)">${unverified}</b><span>unverifiable</span></div>
  </div>

  ${reasons.length ? `<div class="why"><h2>Checks that failed outright</h2><ul>${
    reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}

  ${gaps.length ? `<div class="why"><h2>Refused for lack of evidence, not for failure</h2><ul>${
    gaps.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    <p style="margin:8px 0 0;color:var(--dim);font-size:13px">These products were not shown to be
    unsafe. They could not be checked at all — and a deposit is refused either way.</p></div>` : ""}

  ${runs.map(card).join("")}

  <footer>
    Chain ${esc(chainId ?? "56")} · generated ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC${
      demo ? " · recorded run, no wallet or funds used" : ""}<br>
    Binance ships a mandated security pre-check for <code>swap</code> in its own agent skill, but none
    for <code>defi deposit</code>. This tool is that missing pre-check.
  </footer>
</div>
</html>`;
}
