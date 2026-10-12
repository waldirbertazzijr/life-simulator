// Behaviour fingerprint: runs the engine on a few seeds and hashes the whole
// trajectory (population counts every 100 steps, plus every individual's
// position and energy at the end). A refactor or optimisation that claims to
// change nothing must leave these hashes identical.
//
//   make fingerprint                                   # seeds 1-3 × 20k steps, defaults
//   make fingerprint ARGS="--set terrain.enabled=false"
import { createHash } from 'node:crypto';
import { params as defaults } from '../src/config.js';
import { World } from '../src/world.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const [s0, s1] = opt('seeds', '1-3').split('-').map(Number);
const steps = Number(opt('steps', '20000'));
const params = structuredClone(defaults);
for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--set') continue;
    const [path, raw] = args[++i].split('=');
    const keys = path.split('.');
    let o = params;
    for (const k of keys.slice(0, -1)) o = o[k];
    if (!(keys.at(-1) in o)) throw new Error(`unknown parameter: ${path}`);
    o[keys.at(-1)] = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
}

const all = createHash('sha256');
for (let seed = s0; seed <= (s1 ?? s0); seed++) {
    const h = createHash('sha256');
    const w = new World(params, { seed, aspect: 1.6 });
    for (let t = 1; t <= steps; t++) {
        w.step();
        if (t % 100 === 0) h.update(`${w.herbivores.n},${w.carnivores.n},${w.humans.n},${w.tribes.length};`);
    }
    for (const pop of [w.herbivores, w.carnivores, w.humans]) {
        h.update(Buffer.from(pop.x.buffer, 0, pop.n * 8));
        h.update(Buffer.from(pop.y.buffer, 0, pop.n * 8));
        h.update(Buffer.from(pop.energy.buffer, 0, pop.n * 8));
    }
    const digest = h.digest('hex').slice(0, 16);
    all.update(digest);
    console.log(`seed ${seed}: ${digest}   (${w.herbivores.n}/${w.carnivores.n}/${w.humans.n}, ${w.tribes.length} tribes)`);
}
console.log(`all:    ${all.digest('hex').slice(0, 16)}`);
