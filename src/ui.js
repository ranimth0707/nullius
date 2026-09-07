// The dashboard page. Self-contained: no build step, no framework, no CDN.

export const page = () => `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>nullius</title>
<style>
  :root{--bg:#0d0f13;--fg:#e8eaf0;--dim:#9aa3b2;--line:#222633;--card:#151822;
        --pass:#3fb950;--warn:#d29922;--block:#f85149;--accent:#f0b90b}
  @media(prefers-color-scheme:light){:root{--bg:#fff;--fg:#14171f;--dim:#5b6472;
        --line:#e6e9ef;--card:#fafbfc}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:980px;margin:0 auto;padding:36px 20px 60px}
  h1{font-size:24px;margin:0 0 4px;letter-spacing:-.02em}
  .sub{color:var(--dim);margin:0 0 4px}
  .note{color:var(--dim);font-size:13px;margin:0 0 24px}
  .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
  input,button{font:inherit;border-radius:8px;border:1px solid var(--line);
       background:var(--card);color:var(--fg);padding:8px 12px}
  button{cursor:pointer}
  button.primary{background:var(--accent);color:#1a1500;border-color:var(--accent);font-weight:600}
  button:disabled{opacity:.5;cursor:default}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th{text-align:left;color:var(--dim);font-weight:500;font-size:12px;
     text-transform:uppercase;letter-spacing:.07em;padding:0 10px 8px}
  td{padding:11px 10px;border-top:1px solid var(--line);vertical-align:middle}
  tr.row{cursor:pointer}
  tr.row:hover td{background:var(--card)}
  .apy{font-variant-numeric:tabular-nums;font-weight:600}
  .tvl{color:var(--dim);font-variant-numeric:tabular-nums}
  .pill{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.05em;
        padding:3px 9px;border-radius:999px;white-space:nowrap}
  .p-go{color:var(--pass);background:color-mix(in srgb,var(--pass) 15%,transparent)}
  .p-fail{color:var(--block);background:color-mix(in srgb,var(--block) 15%,transparent)}
  .p-unv{color:var(--dim);background:color-mix(in srgb,var(--dim) 15%,transparent)}
  .p-idle{color:var(--dim);border:1px dashed var(--line)}
  .p-run{color:var(--accent);background:color-mix(in srgb,var(--accent) 15%,transparent)}
  .detail td{background:var(--card);padding:0}
  .checks{padding:6px 16px 14px}
  .chk{display:flex;gap:11px;padding:8px 0;border-bottom:1px solid var(--line)}
  .chk:last-child{border-bottom:0}
  .mk{width:18px;flex:0 0 18px;text-align:center;font-weight:700}
  .m-PASS{color:var(--pass)}.m-WARN{color:var(--warn)}
  .m-BLOCK{color:var(--block)}.m-UNTESTED{color:var(--dim)}
  .ct{font-weight:600;font-size:13.5px}
  .cd{color:var(--dim);font-size:13px}
  .bar{display:flex;gap:9px;flex-wrap:wrap;margin-bottom:20px}
  .stat{border:1px solid var(--line);border-radius:10px;padding:10px 14px;background:var(--card);min-width:96px}
  .stat b{display:block;font-size:20px}
  .stat span{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.07em}
  .off{border:1px solid var(--line);border-left:3px solid var(--block);border-radius:8px;
       padding:14px 16px;background:var(--card);margin-bottom:20px}
  code{font-family:ui-monospace,monospace;font-size:12.5px;
       background:color-mix(in srgb,var(--fg) 8%,transparent);padding:1px 5px;border-radius:4px}
</style>
<div class="wrap">
  <h1>nullius</h1>
  <p class="sub">Take nobody's word for it.</p>
  <p class="note">Every product Binance Agent OS offers on BNB Smart Chain. Click one to resolve the
  contract it would actually enter and put that address to the chain. Nothing here broadcasts.</p>

  <div id="offline" class="off" hidden>
    Wallet not connected. Run <code>baw auth signin</code>, then reload.
  </div>

  <div class="bar" id="bar"></div>

  <div class="toolbar">
    <select id="type">
      <option value="Earn">Earn — lending, reports APY</option>
      <option value="LiquidityPool">Liquidity pools — reports APR</option>
    </select>
    <label style="color:var(--dim);font-size:13px">Deposit tested
      <input id="amt" value="0.005" size="6" style="margin-left:6px"></label>
    <label style="color:var(--dim);font-size:13px">
      <input type="checkbox" id="onlyHeld" style="vertical-align:-2px"> Only assets I hold</label>
    <button id="all" class="primary">Check the top 5</button>
    <span id="prog" style="color:var(--dim);font-size:13px"></span>
  </div>
  <p class="note" id="holdnote" style="margin:-8px 0 16px"></p>

  <table>
    <thead><tr><th>Protocol</th><th>Asset</th><th style="text-align:right">APY</th>
    <th style="text-align:right">Reported TVL</th><th>Verdict</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</div>
<script>
const MK={PASS:"\\u2713",WARN:"!",BLOCK:"\\u2717",UNTESTED:"\\u2013"};
const usd=n=>"$"+Math.round(n).toLocaleString("en-US");
let items=[],state={},held=[],open=new Set();

// The listing carries far more than the wallet can actually simulate. Matching
// BNB against a WBNB product is deliberate: they are the same asset to deposit.
const sameAsset=(a,b)=>{
  const n=s=>String(s).toUpperCase().replace(/^BSC_/,"").replace(/^W(?=BNB$|ETH$)/,"");
  return n(a)===n(b);
};
const visible=()=>onlyHeld.checked
  ? items.filter(i=>held.some(h=>sameAsset(h,i.investmentName)))
  : items;

function pill(v){
  if(!v)return '<span class="pill p-idle">not checked</span>';
  if(v==="running")return '<span class="pill p-run">checking…</span>';
  if(v.verdict==="GO")return '<span class="pill p-go">GO</span>';
  return '<span class="pill '+(v.reason==="failed"?"p-fail":"p-unv")+'">'+
         (v.reason==="failed"?"FAILED":"UNVERIFIED")+'</span>';
}
function stats(){
  const done=Object.values(state).filter(v=>v&&v!=="running");
  const go=done.filter(v=>v.verdict==="GO").length;
  const f=done.filter(v=>v.reason==="failed").length;
  const u=done.filter(v=>v.reason==="unverified").length;
  bar.innerHTML=[["products",visible().length],["checked",done.length],
    ["cleared",go],["failed",f],["unverifiable",u]]
    .map(([l,n])=>'<div class="stat"><b>'+n+'</b><span>'+l+'</span></div>').join("");
}
function render(){
  const list=visible();
  rows.innerHTML=list.map((i,ix)=>{
    const v=state[i.investmentId];
    let d="";
    if(v&&v!=="running"&&open.has(i.investmentId)){
      d='<tr class="detail"><td colspan="5"><div class="checks">'+
        v.checks.map(c=>'<div class="chk"><span class="mk m-'+c.level+'">'+MK[c.level]+
        '</span><div><div class="ct">'+c.title+'</div><div class="cd">'+c.detail+'</div></div></div>').join("")+
        '</div></td></tr>';
    }
    return '<tr class="row" data-i="'+ix+'"><td>'+i.protocolName+'</td><td>'+i.investmentName+
      '</td><td class="apy" style="text-align:right">'+i.apyDisplay+
      '</td><td class="tvl" style="text-align:right">'+usd(i.tvl)+
      '</td><td>'+pill(v)+'</td></tr>'+d;
  }).join("");
  stats();
}
async function check(i,expand=true){
  if(state[i.investmentId]==="running")return;
  state[i.investmentId]="running";render();
  const r=await fetch("/api/check",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({investmentId:i.investmentId,amount:amt.value,type:type.value})});
  state[i.investmentId]=await r.json();
  if(expand)open.add(i.investmentId);
  render();
}
// An already-checked row toggles its detail. Re-running a check on every click
// made it impossible to see the whole table's verdicts at once.
rows.addEventListener("click",e=>{
  const tr=e.target.closest("tr.row");if(!tr)return;
  const i=visible()[+tr.dataset.i];
  const v=state[i.investmentId];
  if(v&&v!=="running"){open.has(i.investmentId)?open.delete(i.investmentId):open.add(i.investmentId);render();}
  else check(i);
});
onlyHeld.onchange=render;
all.onclick=async()=>{
  all.disabled=true;
  const list=visible().slice(0,5);
  for(let k=0;k<list.length;k++){prog.textContent=(k+1)+" of "+list.length;await check(list[k],false);}
  prog.textContent="done";all.disabled=false;
};
async function load(){
  prog.textContent="loading…";
  const d=await(await fetch("/api/list?type="+encodeURIComponent(type.value))).json();
  items=d.list||[];state={};open.clear();prog.textContent="";render();
}
type.onchange=load;
(async()=>{
  const s=await(await fetch("/api/status")).json();
  if(!s.connected)offline.hidden=false;
  const [d,h]=await Promise.all([
    fetch("/api/list?type=Earn").then(r=>r.json()),
    fetch("/api/holdings").then(r=>r.json()).catch(()=>({held:[]}))]);
  items=d.list||[];held=h.held||[];
  holdnote.textContent=held.length
    ? "Wallet holds "+held.join(", ")+". A deposit can only be simulated for an asset that is held \\u2014 everything else can be listed but not checked."
    : "Wallet holds nothing on this chain, so no deposit can be simulated.";
  render();
})();
</script>
</html>`;
