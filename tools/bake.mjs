// Bake a heavy model (textures, a skeleton, animations) into our format, run
// inside the Playwright container by `make bake`: Chromium decodes the
// textures, three's GLTFLoader reads the file, and tools/bake-page.js does
// the work (see there). Out comes a small .glb that src/view3d/models.js
// reads like the owner's trimesh models: flat colours per face, our axes,
// and each vertex's rig part with the bones' joints. Also a picture of the
// original beside the bake in .shots/bake-<out>.png.
//
//   make bake ARGS="--in assets/local/in/sheep.glb --out assets/local/sheep.glb"
//
// Options (paths are inside the repo; assets/local/ is git-ignored and writable):
//   --in <glb>          the model to bake
//   --out <glb>         where the bake goes
//   --plan quadruped    the body plan (the rig's parts)
//   --up +y             the file's up (glTF's is +y)
//   --forward auto      the way it faces: auto (from the head's bones), or +z, -x...
//   --budget 1500       simplify to about this many triangles if over
//   --drop <regex>      leave out meshes whose name matches (e.g. a ground plane)
//   --alpha 0.5         faces of a see-through material whose texture is fainter than this go
//   --gain 1           brighten (or darken) every colour by this factor
//   --parts <json>      bone name (regex) → part, before the built-in names, e.g. '{"Tail":"torso"}'
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const IN = opt('in');
const OUT = opt('out');
if (!IN || !OUT) {
    console.error('usage: make bake ARGS="--in <glb> --out <glb> [--plan quadruped] [--up +y] [--forward auto] [--budget 1500] [--drop regex]"');
    process.exit(2);
}
const options = {
    input: `/${IN.replace(/^\/+/, '')}`,
    name: path.basename(IN),
    plan: opt('plan', 'quadruped'),
    up: opt('up', '+y'),
    forward: opt('forward', 'auto'),
    budget: Number(opt('budget', '1500')),
    drop: opt('drop', ''),
    alpha: Number(opt('alpha', '0.5')),
    gain: Number(opt('gain', '1')),
    parts: JSON.parse(opt('parts', '{}')),
};

const out = (s) => fs.writeSync(1, `${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary' };
const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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
    '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

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
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (m.method === 'Runtime.exceptionThrown') logs.push(`EXCEPTION: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
});
const send = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:8080/tools/bake.html' });
await sleep(1500);
const r = await send('Runtime.evaluate', {
    expression: `Promise.race([
        new Promise((r) => { const t = () => (window.bakePage ? r(window.bakePage) : setTimeout(t, 50)); t(); })
            .then((m) => m.bake(${JSON.stringify(options)})),
        new Promise((_, no) => setTimeout(() => no(new Error('timed out')), 240000)),
    ])`,
    awaitPromise: true,
    returnByValue: true,
});
let failed = false;
if (r.result?.exceptionDetails) {
    out(`bake failed: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
    failed = true;
} else {
    const { glb, report } = r.result.result.value;
    const bytes = Buffer.from(glb, 'base64');
    fs.mkdirSync(path.dirname(path.join('/app', OUT)), { recursive: true });
    fs.writeFileSync(path.join('/app', OUT), bytes);
    out(report);
    out(`wrote ${OUT}: ${bytes.length} bytes`);
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = `bake-${path.basename(OUT, '.glb')}.png`;
    fs.writeFileSync(path.join('/out', file), Buffer.from(shot.result.data, 'base64'));
    out(`original (left) and bake (right) → .shots/${file}`);
}
for (const l of logs) out(`LOG ${l}`);
chrome.kill();
server.close();
process.exit(failed ? 1 : 0);
