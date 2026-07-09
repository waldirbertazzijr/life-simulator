// Live dashboard for the parameter search.
//   node headless/dashboard.mjs   →   open http://localhost:8099
//
// Serves a self-contained page that polls progress.json (written by search.mjs)
// and draws: overall progress, search convergence, and the current best
// ecosystem's population trajectory.
import http from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRESS_PATH = join(__dirname, 'progress.json');
const PORT = Number(process.env.PORT || 8099);

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🌱 Life-Sim Balance Search</title>
<style>
  :root{--bg:#0e1116;--panel:#171b22;--line:#232833;--fg:#e6edf3;--mut:#8b949e;
        --tree:#3fb950;--herb:#f0883e;--carn:#f85149;--acc:#58a6ff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial}
  header{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  h1{font-size:17px;margin:0;font-weight:650}
  .badge{padding:3px 10px;border-radius:999px;background:#1f6feb22;color:var(--acc);font-size:12px;font-weight:600;border:1px solid #1f6feb44}
  .badge.done{background:#3fb95022;color:var(--tree);border-color:#3fb95055}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px 22px;max-width:1200px}
  @media(max-width:820px){.grid{grid-template-columns:1fr}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
  .panel h2{margin:0 0 10px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);font-weight:600}
  .big{font-size:40px;font-weight:750;line-height:1}
  .sub{color:var(--mut);font-size:13px;margin-top:6px}
  .bar{height:10px;background:#0b0e13;border-radius:6px;overflow:hidden;border:1px solid var(--line);margin-top:8px}
  .bar>i{display:block;height:100%;background:linear-gradient(90deg,#1f6feb,#58a6ff);width:0;transition:width .4s}
  .row{display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px dashed var(--line);font-variant-numeric:tabular-nums}
  .row:last-child{border-bottom:0}
  .k{color:var(--mut)}
  canvas{width:100%;height:190px;display:block}
  .legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;font-size:12.5px;font-variant-numeric:tabular-nums}
  .legend b{font-weight:600}
  .dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
  .foot{color:var(--mut);font-size:12px;padding:4px 22px 26px}
  code{background:#0b0e13;padding:1px 6px;border-radius:5px;border:1px solid var(--line)}
</style></head><body>
<header>
  <h1>🌱 Ecosystem Balance Search</h1>
  <span id="phase" class="badge">connecting…</span>
  <span class="sub" id="meta"></span>
</header>
<div class="grid">
  <div class="panel">
    <h2>Progress</h2>
    <div class="big"><span id="done">0</span><span class="sub"> / <span id="total">?</span> candidates</span></div>
    <div class="bar"><i id="pbar"></i></div>
    <div class="sub" id="ptime"></div>
  </div>
  <div class="panel">
    <h2>Best health score</h2>
    <div class="big" id="best">—</div>
    <div class="sub" id="bestsub">searching…</div>
  </div>
  <div class="panel">
    <h2>Search convergence — best score vs candidates</h2>
    <canvas id="conv"></canvas>
  </div>
  <div class="panel">
    <h2>Best ecosystem — population over time</h2>
    <canvas id="traj"></canvas>
    <div class="legend" id="legend"></div>
  </div>
  <div class="panel" style="grid-column:1/-1">
    <h2>Best config so far — the tuned knobs</h2>
    <div id="knobs"></div>
  </div>
</div>
<div class="foot">Auto-refreshes every 1.5s from <code>headless/progress.json</code>. Leave the search running; this just watches it.</div>

<script>
const C={tree:'#3fb950',herb:'#f0883e',carn:'#f85149',acc:'#58a6ff',mut:'#8b949e',line:'#232833'};
const $=id=>document.getElementById(id);
const KNOB_MEANING={
 'trees.procreatingChance':'🌳 forest regrowth rate (r)',
 'trees.carryingCapacity':'🌳 forest cap (K) — paradox of enrichment',
 'herbivores.procreatingChance':'🦌 herbivore fertility',
 'herbivores.energyGain':'🦌 herbivore metabolism (energy/step)',
 'herbivores.maxAge':'🦌 herbivore lifespan',
 'herbivores.carryingCapacity':'🦌 herbivore cap',
 'carnivores.procreatingChance':'🦁 carnivore fertility',
 'carnivores.energyGain':'🦁 carnivore metabolism (energy/step)',
 'carnivores.maxAge':'🦁 carnivore lifespan',
 'carnivores.carryingCapacity':'🦁 carnivore cap',
};
function dpr(cv){const r=window.devicePixelRatio||1;const w=cv.clientWidth,h=cv.clientHeight;
  if(cv.width!==w*r||cv.height!==h*r){cv.width=w*r;cv.height=h*r;}const x=cv.getContext('2d');
  x.setTransform(r,0,0,r,0,0);return {x,w,h};}
function line(x,pts,color,w,h,ymax,pad){
  x.strokeStyle=color;x.lineWidth=2;x.beginPath();
  pts.forEach((v,i)=>{const px=pad+ (i/(pts.length-1||1))*(w-pad*1.5);
    const py=h-pad-(v/(ymax||1))*(h-pad*2);i?x.lineTo(px,py):x.moveTo(px,py);});x.stroke();}
function grid(x,w,h,pad){x.strokeStyle=C.line;x.lineWidth=1;for(let i=0;i<=4;i++){const y=pad+i*(h-pad*2)/4;
  x.beginPath();x.moveTo(pad,y);x.lineTo(w-pad*0.5,y);x.stroke();}}
function drawConv(hist){const {x,w,h}=dpr($('conv'));x.clearRect(0,0,w,h);const pad=26;grid(x,w,h,pad);
  if(!hist||hist.length<2){x.fillStyle=C.mut;x.fillText('waiting for data…',pad,h/2);return;}
  const ys=hist.map(p=>p.best);const ymax=Math.max(...ys)*1.1||1;
  line(x,ys,C.acc,w,h,ymax,pad);
  x.fillStyle=C.mut;x.font='11px system-ui';x.fillText(ymax.toFixed(0),4,pad+4);x.fillText('0',10,h-pad+4);
  x.fillText('candidates →',w-84,h-6);}
function drawTraj(spark,counts){const {x,w,h}=dpr($('traj'));x.clearRect(0,0,w,h);const pad=26;grid(x,w,h,pad);
  if(!spark){x.fillStyle=C.mut;x.fillText('no surviving config yet…',pad,h/2);$('legend').innerHTML='';return;}
  // normalize each species to its own max so dynamics are visible at any scale
  const norm=(a)=>{const m=Math.max(1,...a);return {n:a.map(v=>v/m),max:m};};
  const t=norm(spark.tree),he=norm(spark.herbivore),c=norm(spark.carnivore);
  line(x,t.n,C.tree,w,h,1,pad);line(x,he.n,C.herb,w,h,1,pad);line(x,c.n,C.carn,w,h,1,pad);
  x.fillStyle=C.mut;x.font='11px system-ui';x.fillText('time →',w-56,h-6);x.fillText('(each line scaled to its own max)',pad,14);
  const last=a=>a[a.length-1];
  const item=(dot,name,arr)=>'<span><span class="dot" style="background:'+dot+'"></span><b>'+name+'</b> '+
    Math.min(...arr)+'–'+Math.max(...arr)+' <span style="color:'+C.mut+'">now '+last(arr)+'</span></span>';
  $('legend').innerHTML=item(C.tree,'🌳 trees',spark.tree)+item(C.herb,'🦌 herbivores',spark.herbivore)+item(C.carn,'🦁 carnivores',spark.carnivore);}
function fmt(v){if(v==null)return '—';const a=Math.abs(v);
  if(a>0&&a<0.01)return v.toExponential(2);return Number.isInteger(v)?String(v):v.toFixed(3);}
function drawKnobs(ov){if(!ov){$('knobs').innerHTML='<span class="sub">no config yet…</span>';return;}
  let rows='';for(const grp of Object.keys(ov))for(const k of Object.keys(ov[grp])){
    const key=grp+'.'+k;rows+='<div class="row"><span class="k">'+(KNOB_MEANING[key]||key)+'</span><span>'+fmt(ov[grp][k])+'</span></div>';}
  $('knobs').innerHTML=rows;}
async function tick(){
  let d;try{d=await (await fetch('/api/progress?t='+Date.now())).json();}catch(e){return;}
  if(!d||d.status==='waiting'){$('phase').textContent='waiting for search to start…';return;}
  const ph=$('phase');ph.textContent=d.phase;ph.className='badge'+(/done/.test(d.phase)?' done':'');
  $('meta').textContent=(d.workers?d.workers+' workers · ':'')+(d.searchSeeds?d.searchSeeds+' seeds/candidate · ':'')+(d.frames?d.frames+' frames':'');
  $('done').textContent=d.done??0;$('total').textContent=d.total??'?';
  $('pbar').style.width=((d.done/(d.total||1))*100).toFixed(1)+'%';
  const m=Math.floor((d.elapsedSeconds||0)/60),s=(d.elapsedSeconds||0)%60;$('ptime').textContent='elapsed '+m+'m '+s+'s';
  $('best').textContent=d.bestScore!=null?d.bestScore.toFixed(1):'—';
  let bs='';if(d.finalStats)bs='validated '+d.finalStats.finalScore+' · survived '+d.finalStats.finalCompleted+' seeds @ '+d.finalStats.finalFrames+'f';
  else if(d.bestFinalCounts)bs='🌳'+d.bestFinalCounts.tree+' · 🦌'+d.bestFinalCounts.herbivore+' · 🦁'+d.bestFinalCounts.carnivore+(d.bestCompleted?' (survives horizon)':'');
  $('bestsub').textContent=bs||'searching…';
  drawConv(d.scoreHistory);drawTraj(d.bestSpark,d.bestFinalCounts);drawKnobs(d.bestOverrides);
}
tick();setInterval(tick,1500);window.addEventListener('resize',tick);
</script></body></html>`;

http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/api/progress')) {
        let body = '{"status":"waiting"}';
        try { body = readFileSync(PROGRESS_PATH, 'utf8'); } catch { /* not written yet */ }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(body);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
}).listen(PORT, () => {
    console.log(`\n📊 Dashboard live →  http://localhost:${PORT}\n   (watching ${PROGRESS_PATH})\n`);
});
