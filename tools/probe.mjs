// Headless browser check, run inside the Playwright container by `make shot`.
// Serves the repo, opens it in Chromium (software WebGL, no GPU needed),
// optionally runs some JavaScript, then at each time mark prints a readout of
// the panel and saves a screenshot to .shots/<name>-<ms>.png. Console errors
// and exceptions are printed at the end.
//
//   make shot                                         # 1440x900, ?seed=7, one shot at 4s
//   make shot ARGS="--size 390x844 --dpr 2 --mobile"  # a phone
//   make shot ARGS="--speed 16 --at 4000,20000"       # 16x, shots at 4s and 20s
//   make shot ARGS="--eval 'sim.follow(sim.world.humans.id[0])' --name follow"
//   make shot ARGS="--query '?seed=3&2d'"
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const [W, H] = opt('size', '1440x900').split('x').map(Number);
const DPR = Number(opt('dpr', '1'));
const MOBILE = args.includes('--mobile');
const QUERY = opt('query', '?seed=7');
const SPEED = opt('speed', '');
const MARKS = opt('at', '4000').split(',').map(Number);
const EVAL = opt('eval', '');
const NAME = opt('name', 'shot');
const OUT = '/out';

const out = (s) => fs.writeSync(1, `${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.md': 'text/plain' };
const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join('/app', p);
    fs.readFile(f, (e, d) => {
        if (e) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
        res.end(d);
    });
}).listen(8080);

const chrome = spawn('/ms-playwright/chromium-1248/chrome-linux-arm64/chrome', [
    '--headless=new', '--no-sandbox', '--hide-scrollbars', '--remote-debugging-port=9222',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });

let targets = [];
for (let i = 0; i < 50 && !targets.length; i++) {
    try {
        targets = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).filter((t) => t.type === 'page');
    } catch {}
    if (!targets.length) await sleep(200);
}
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        logs.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
        logs.push(`EXCEPTION: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
    }
    if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
        logs.push(`log.${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url || ''}`);
    }
});
const send = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.exceptionDetails ? `error: ${r.result.exceptionDetails.exception?.description}` : r.result?.result?.value;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: MOBILE });
await send('Page.navigate', { url: `http://127.0.0.1:8080/${QUERY}` });
await sleep(1000);
if (SPEED) await evaluate(`document.querySelector('[data-speed="${SPEED}"]')?.click()`);
if (EVAL) out(`EVAL: ${JSON.stringify(await evaluate(EVAL))}`);

const readout = `JSON.stringify({
    status: document.getElementById('status')?.textContent,
    counts: ['n-grass', 'n-herbivores', 'n-carnivores', 'n-humans'].map((k) => document.getElementById(k)?.textContent).join(' '),
    follow: document.getElementById('follow')?.hidden === false ? document.getElementById('follow').innerText.replace(/\\s+/g, ' ') : null,
})`;
const fps = `new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n / ((performance.now() - t0) / 1000)); }; requestAnimationFrame(f); })`;

let t = 1000;
for (const mark of MARKS) {
    await sleep(Math.max(0, mark - t));
    t = mark;
    const info = await evaluate(readout);
    const f = await evaluate(fps);
    t += 2000;
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = `${NAME}-${mark}.png`;
    fs.writeFileSync(path.join(OUT, file), Buffer.from(shot.result.data, 'base64'));
    out(`@${mark}ms ${info} fps=${typeof f === 'number' ? f.toFixed(1) : f} → .shots/${file}`);
}
for (const l of logs) out(`LOG ${l}`);
out(`${logs.length} console errors/warnings`);
chrome.kill();
server.close();
process.exit(0);
