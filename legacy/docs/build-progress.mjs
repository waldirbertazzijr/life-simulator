// Builds docs/progress.html — ONE self-contained file (images inlined as data
// URIs, no network, no external fonts) from docs/progress/data.json.
//
//   export PATH="/opt/homebrew/bin:$PATH"
//   node docs/build-progress.mjs
//
// To update the page: edit docs/progress/data.json (and drop new screenshots in
// docs/progress/shots/), then re-run this. Never hand-edit progress.html.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(HERE, 'progress/data.json'), 'utf8'));

// Inline every referenced screenshot so the page survives being airdropped to a phone.
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
let inlined = 0;
for (const round of data.rounds) {
    for (const shot of [].concat(round.shots || [], round.shot || [])) {
        const p = join(HERE, 'progress/shots', shot.file);
        if (!existsSync(p)) { shot.missing = true; continue; }
        const mime = MIME[extname(shot.file).toLowerCase()] || 'image/jpeg';
        shot.src = `data:${mime};base64,${readFileSync(p).toString('base64')}`;
        inlined++;
    }
    // normalise: single `shot` -> `shots[]`
    if (round.shot && !round.shots) { round.shots = [round.shot]; delete round.shot; }
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const html = `<meta charset="utf-8">
<title>Life Simulator — gauntlet progress</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
/* ---------------------------------------------------------------------------
   Palette is lifted from the game's own HUD tokens (index.html :root) so the
   report and the thing it reports on read as one project. Light theme is the
   same hues re-weighted for a pale ground, not an inversion.
   --------------------------------------------------------------------------- */
:root {
  --ground:#EAEDE6; --panel:#FFFFFF; --sunk:#F1F3EC; --edge:#C4CABE; --rule:#DDE1D6;
  --ink:#1B2029; --dim:#5E6673; --faint:#89909C;
  --accent:#8A6400; --accent-bg:#FFF3CE;
  --tree:#2E7D4F; --herb:#B25A0E; --carn:#BE3B31;
  --pass:#2E7D4F; --fail:#BE3B31; --hold:#8A6400;
  --shadow:2px 2px 0 rgba(27,32,41,.14);
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground:#0E1018; --panel:#161A26; --sunk:#0A0C16; --edge:#39415F; --rule:#252B3D;
    --ink:#D7DCE8; --dim:#8892B0; --faint:#646C85;
    --accent:#FFD866; --accent-bg:#2A2413;
    --tree:#7EE787; --herb:#FFA657; --carn:#FF7B72;
    --pass:#7EE787; --fail:#FF7B72; --hold:#FFD866;
    --shadow:3px 3px 0 rgba(0,0,0,.5);
  }
}
:root[data-theme="dark"] {
  --ground:#0E1018; --panel:#161A26; --sunk:#0A0C16; --edge:#39415F; --rule:#252B3D;
  --ink:#D7DCE8; --dim:#8892B0; --faint:#646C85;
  --accent:#FFD866; --accent-bg:#2A2413;
  --tree:#7EE787; --herb:#FFA657; --carn:#FF7B72;
  --pass:#7EE787; --fail:#FF7B72; --hold:#FFD866;
  --shadow:3px 3px 0 rgba(0,0,0,.5);
}

* { box-sizing:border-box; }
body {
  margin:0; background:var(--ground); color:var(--ink);
  font-family:var(--sans); font-size:16px; line-height:1.6;
  -webkit-text-size-adjust:100%;
}
.wrap { max-width:840px; margin:0 auto; padding:0 18px 96px; }

/* ---- masthead ---- */
header { padding:38px 0 20px; border-bottom:2px solid var(--edge); }
.eyebrow {
  font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase;
  color:var(--faint); margin:0 0 10px;
}
h1 { font-size:30px; line-height:1.15; margin:0 0 10px; text-wrap:balance; letter-spacing:-.015em; }
.sub { color:var(--dim); font-size:15px; margin:0; max-width:62ch; }

/* ---- the four bars ---- */
.bars { display:grid; gap:10px; margin:26px 0 0; }
.bar {
  background:var(--panel); border:2px solid var(--edge); box-shadow:var(--shadow);
  padding:13px 14px; display:grid; gap:7px;
}
.bar-top { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.bar-key { font-family:var(--mono); font-size:13px; font-weight:700; letter-spacing:.12em; }
.chip {
  font-family:var(--mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase;
  padding:3px 7px; border:1.5px solid currentColor; line-height:1.2; white-space:nowrap;
}
.s-pass { color:var(--pass); } .s-fail { color:var(--fail); } .s-hold { color:var(--hold); }
.bar-claim { font-size:13px; color:var(--faint); font-style:italic; }
.bar-status { font-size:14.5px; color:var(--ink); }
.bar-metric {
  font-family:var(--mono); font-size:12.5px; color:var(--dim);
  font-variant-numeric:tabular-nums; border-top:1px dashed var(--rule); padding-top:7px;
}

/* ---- next target ---- */
.target { margin:26px 0 0; border-left:4px solid var(--accent); background:var(--accent-bg); padding:15px 16px; }
.target h2 { font-size:18px; margin:6px 0 8px; line-height:1.25; }
.target p { margin:0; font-size:14.5px; color:var(--ink); }

/* ---- rounds ---- */
h2.log-head {
  font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase;
  color:var(--faint); margin:44px 0 0; padding-bottom:8px; border-bottom:2px solid var(--edge);
}
.round { padding:26px 0; border-bottom:1px solid var(--rule); }
.round-top { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
.round-n {
  font-family:var(--mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint);
}
.round h3 { font-size:22px; margin:0 0 10px; line-height:1.2; text-wrap:balance; letter-spacing:-.01em; }
.round p { margin:0 0 14px; font-size:15px; }

/* ---- receipts: styled as the game's own sunken LCD panel ---- */
.receipts {
  background:var(--sunk); border:2px solid var(--edge); padding:11px 12px; margin:0 0 16px;
  font-family:var(--mono); font-size:12.5px; line-height:1.55; overflow-x:auto;
  font-variant-numeric:tabular-nums;
}
.receipt { display:grid; grid-template-columns:1fr; gap:1px; padding:5px 0; border-bottom:1px dotted var(--rule); }
.receipt:last-child { border-bottom:0; }
.receipt-l { color:var(--dim); white-space:pre; }
.receipt-v { color:var(--ink); }
@media (min-width:620px) {
  .receipt { grid-template-columns:minmax(0,1fr) minmax(0,1.05fr); gap:14px; align-items:baseline; }
  .receipt-v { text-align:right; }
}

/* ---- sparklines ---- */
figure { margin:0 0 16px; }
.spark { background:var(--sunk); border:2px solid var(--edge); padding:10px 12px 8px; }
.spark-row { display:flex; align-items:center; gap:10px; }
.spark-key {
  font-family:var(--mono); font-size:11px; width:78px; flex:0 0 auto; letter-spacing:.04em;
}
/* min-width:0 is load-bearing: without it the flex item refuses to shrink below
   the SVG's 400px intrinsic viewBox width and the whole page scrolls sideways. */
.spark svg { display:block; width:100%; min-width:0; flex:1 1 0; height:34px; }
figcaption { font-size:12.5px; color:var(--faint); margin-top:7px; font-family:var(--mono); line-height:1.45; }

/* ---- screenshots ---- */
.shot img { display:block; width:100%; height:auto; border:2px solid var(--edge); box-shadow:var(--shadow); }
.shot { margin:0 0 16px; }

/* ---- dead ends ---- */
.dead { border-top:1px dashed var(--rule); padding-top:13px; margin-top:4px; }
.dead-h {
  font-family:var(--mono); font-size:10.5px; letter-spacing:.13em; text-transform:uppercase;
  color:var(--fail); margin:0 0 8px;
}
.dead ul { margin:0; padding-left:19px; }
.dead li { font-size:14px; color:var(--dim); margin-bottom:7px; }
.dead li:last-child { margin-bottom:0; }

footer { margin-top:36px; font-family:var(--mono); font-size:11.5px; color:var(--faint); line-height:1.6; }
</style>

<div class="wrap">
<header>
  <p class="eyebrow">Gauntlet log &middot; updated ${esc(data.updated)}</p>
  <h1>${esc(data.title)}</h1>
  <p class="sub">${esc(data.subtitle)}</p>

  <div class="bars">
  ${data.bars.map((b) => `
    <div class="bar">
      <div class="bar-top">
        <span class="bar-key">${esc(b.key)}</span>
        <span class="chip s-${esc(b.state)}">${b.state === 'pass' ? 'holding' : b.state === 'fail' ? 'failing' : 'unmeasured'}</span>
      </div>
      <div class="bar-claim">${esc(b.claim)}</div>
      <div class="bar-status">${esc(b.status)}</div>
      <div class="bar-metric">${esc(b.metric)}</div>
    </div>`).join('')}
  </div>

  <div class="target">
    <p class="eyebrow" style="margin:0;color:var(--accent)">Next target</p>
    <h2>${esc(data.nextTarget.headline)}</h2>
    <p>${esc(data.nextTarget.body)}</p>
  </div>
</header>

<h2 class="log-head">Rounds, newest first</h2>

${[...data.rounds].sort((a, b) => b.n - a.n).map((r) => `
<article class="round">
  <div class="round-top">
    <span class="round-n">Round ${r.n} &middot; ${esc(r.phase)} &middot; ${esc(r.date)}</span>
    <span class="chip s-${esc(r.verdict)}">${esc(r.verdictLabel || r.verdict)}</span>
  </div>
  <h3>${esc(r.title)}</h3>
  <p>${esc(r.body)}</p>

  ${r.receipts?.length ? `<div class="receipts">${r.receipts.map((x) => `
    <div class="receipt"><span class="receipt-l">${esc(x.label)}</span><span class="receipt-v">${esc(x.value)}</span></div>`).join('')}
  </div>` : ''}

  ${r.series ? `<figure><div class="spark">
    ${['tree', 'herbivore', 'carnivore'].filter((k) => r.series[k]).map((k) => `
      <div class="spark-row">
        <span class="spark-key" style="color:var(--${k === 'tree' ? 'tree' : k === 'herbivore' ? 'herb' : 'carn'})">${k}</span>
        ${sparkSvg(r.series[k], k === 'tree' ? 'tree' : k === 'herbivore' ? 'herb' : 'carn')}
      </div>`).join('')}
  </div>${r.series.caption ? `<figcaption>${esc(r.series.caption)}</figcaption>` : ''}</figure>` : ''}

  ${(r.shots || []).map((s) => s.src ? `<figure class="shot">
    <img src="${s.src}" alt="${esc(s.caption || 'screenshot')}">
    ${s.caption ? `<figcaption>${esc(s.caption)}</figcaption>` : ''}
  </figure>` : '').join('')}

  ${r.deadEnds?.length ? `<div class="dead">
    <p class="dead-h">Dead ends &mdash; do not retry</p>
    <ul>${r.deadEnds.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
  </div>` : ''}
</article>`).join('')}

<footer>
  Generated by docs/build-progress.mjs from docs/progress/data.json &middot; ${inlined} screenshot(s) inlined.<br>
  Bars defined in gauntlets/00-master-autonomous-game.md. Methodology in docs/HANDOFF.md &sect;5.
</footer>
</div>
`;

// Sparkline: a filled area with an emphasised endpoint, drawn at build time so
// the page needs no script at all.
function sparkSvg(series, tone) {
    const W = 400, H = 34, pad = 2;
    const max = Math.max(1, ...series);
    const pts = series.map((v, i) => [
        pad + (i / Math.max(1, series.length - 1)) * (W - pad * 2),
        H - pad - (v / max) * (H - pad * 2),
    ]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${line} L${(W - pad).toFixed(1)},${H - pad} L${pad},${H - pad} Z`;
    const [ex, ey] = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${tone} population over time, peak ${max}">
      <path d="${area}" fill="var(--${tone})" opacity=".16"/>
      <path d="${line}" fill="none" stroke="var(--${tone})" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
      <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="2.6" fill="var(--${tone})"/>
    </svg>`;
}

writeFileSync(join(HERE, 'progress.html'), html);
const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`docs/progress.html written — ${kb} KB, ${data.rounds.length} round(s), ${inlined} image(s) inlined.`);
