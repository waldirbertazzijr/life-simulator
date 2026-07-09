// Single-run CLI for the headless simulation.
//
// Usage:
//   node headless/run.mjs                 # run current config.js defaults
//   node headless/run.mjs --baseline      # force the OLD behaviour (trees can't reproduce)
//   node headless/run.mjs --frames 30000 --seed 7
//   node headless/run.mjs '{"trees":{"carryingCapacity":600}}'   # ad-hoc overrides
import { runOnce, scoreRun } from './harness.mjs';
import { animals } from '../Animal.js';

const argv = process.argv.slice(2);
const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : def;
};

const frames = parseInt(flag('frames', '20000'), 10);
const seed = parseInt(flag('seed', '1'), 10);
const baseline = argv.includes('--baseline');

// --world WxH lets us reproduce a specific browser window size (density test).
let world = { width: 1920, height: 1080 };
const worldFlag = flag('world', null);
if (worldFlag && /^\d+x\d+$/.test(worldFlag)) {
    const [w, h] = worldFlag.split('x').map(Number);
    world = { width: w, height: h };
}

// Any bare JSON arg is treated as config overrides.
let overrides = {};
const jsonArg = argv.find((a) => a.trim().startsWith('{'));
if (jsonArg) overrides = JSON.parse(jsonArg);

// --baseline reproduces the original bug: non-renewable trees.
if (baseline) {
    overrides = { ...overrides, trees: { procreatingChance: 0, carryingCapacity: null } };
}

const r = runOnce(overrides, { seed, frames, sample: 100, world });
const score = scoreRun(r);

const bar = (n, max, width = 30) => '█'.repeat(Math.round(clamp01(n / max) * width));
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

console.log(`\n=== Headless run (${baseline ? 'BASELINE: trees cannot reproduce' : 'current config'}) ===`);
console.log(`seed=${seed}  frames=${frames}`);
console.log(overrides && Object.keys(overrides).length ? `overrides: ${JSON.stringify(overrides)}` : 'overrides: (none)');
console.log('');
if (r.completed) {
    console.log(`✅ SURVIVED the full ${frames} frames with all three species alive.`);
} else {
    console.log(`❌ COLLAPSED at frame ${r.collapseFrame} — first species to go extinct: ${r.collapseCause}.`);
}
console.log('');
console.log('Final populations:');
console.log(`  🌳 trees:      ${r.finalCounts.tree}`);
console.log(`  🦌 herbivores: ${r.finalCounts.herbivore}`);
console.log(`  🦁 carnivores: ${r.finalCounts.carnivore}`);
console.log('');
console.log('Back-half stability (mean ± std, min→max, CV):');
for (const s of ['tree', 'herbivore', 'carnivore']) {
    const u = r.summary[s];
    console.log(`  ${s.padEnd(11)} ${u.mean.toFixed(0).padStart(5)} ± ${u.std.toFixed(0).padStart(4)}   ${u.min}→${u.max}   CV=${u.cv.toFixed(2)}`);
}
console.log('');
console.log(`HEALTH SCORE: ${score.toFixed(1)}`);

// Tiny sparkline of the herbivore & carnivore trajectories.
const spark = (arr) => {
    const chars = ' ▁▂▃▄▅▆▇█';
    const max = Math.max(1, ...arr);
    return arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / 60)) === 0)
        .map((v) => chars[Math.round((v / max) * (chars.length - 1))]).join('');
};
console.log('');
console.log(`  🌳 ${spark(r.series.tree)}`);
console.log(`  🦌 ${spark(r.series.herbivore)}`);
console.log(`  🦁 ${spark(r.series.carnivore)}`);
console.log('');

// Evolved genetics + mutation prevalence (headless "Evolution Tracker").
const geneticsOf = (kind) => {
    const a = animals.filter((x) => x.kind === kind);
    if (!a.length) return null;
    const avg = (f) => a.reduce((s, x) => s + f(x), 0) / a.length;
    return {
        n: a.length,
        speed: avg((x) => x.genetics.speedMultiplier),
        size: avg((x) => x.genetics.sizeMultiplier),
        energy: avg((x) => x.genetics.maxEnergyMultiplier),
        vision: avg((x) => x.genetics.visionRange),
        aggr: avg((x) => x.genetics.aggression),
        intel: avg((x) => x.genetics.intelligence),
    };
};
const mut = {};
for (const x of animals) for (const m of x.mutations) mut[m] = (mut[m] || 0) + 1;

console.log('Evolved genetics (avg multiplier vs 1.0 baseline):');
for (const kind of ['herbivore', 'carnivore']) {
    const g = geneticsOf(kind);
    const icon = kind === 'herbivore' ? '🦌' : '🦁';
    if (!g) { console.log(`  ${icon} ${kind}: (extinct)`); continue; }
    console.log(`  ${icon} ${kind.padEnd(9)} ⚡${g.speed.toFixed(2)} 📏${g.size.toFixed(2)} 💪${g.energy.toFixed(2)} 👁️${g.vision.toFixed(2)} 😠${g.aggr.toFixed(2)} 🧠${g.intel.toFixed(2)}`);
}
console.log('Mutations: ' + (Object.keys(mut).length ? Object.entries(mut).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ') : '(none)'));
console.log('');
