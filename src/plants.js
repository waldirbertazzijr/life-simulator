// Wild berry bushes and fruit trees (stage 4, package 2): placed once per
// world, ripening in their season every year, picked down by people. Grazers
// leave them be.
//
// world.plants (null with params.plants off, or on a flat world):
//   n                  how many
//   x, y               where each stands (Float64Array)
//   kind               1 a berry bush, 2 a fruit tree (Uint8Array: KINDS)
//   fruit              how much is on it now, 0..1 of a full crop (Float32Array)
//   taken              how much of this year's crop people have picked (Float32Array)
//   rev                counts changes to `fruit` (the snapshot sends it again then)
//
// Where: berry bushes on meadows and forest edges, fruit trees on meadows by
// wetland edges, chosen by a random stream of their own (from the seed), so
// the same world grows the same plants, and the animals' stream is untouched.
//
// When: a crop comes in through its season and falls after it: berries in
// summer, fruit in autumn (crop(), by the time of year). What is on a plant
// is its season's crop less what was picked; with the crop gone, the plant
// is bare until next year's.
//
// Picking: a forager (humans.js) goes to a ripe one within plants.sight
// before hunting; the player's E picks one within items.pickReach
// (items.js handWork says 'fruit'). Each step takes plants.pick food.
import { createRng } from './rng.js';
import { BIOME } from './terrain.js';
import { wrapDelta } from './util.js';

export const PLANT = { BERRY: 1, FRUIT: 2 };
const EVERY = 45; // steps between looks at the crops (they come in over days)

const smoothstep = (a, b, v) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

// A crop through the year (yearT, 0: the first dawn of spring): berries come
// in early in summer and fall at its end; fruit early in autumn, falling
// into the first days of winter.
export function crop(kind, yearT) {
    return kind === PLANT.BERRY
        ? smoothstep(0.26, 0.33, yearT) * (1 - smoothstep(0.47, 0.54, yearT))
        : smoothstep(0.51, 0.58, yearT) * (1 - smoothstep(0.72, 0.78, yearT));
}

// ---- Placing them --------------------------------------------------------------------------

// The world's plants (World's constructor, after the land and the grass).
export function placePlants(world) {
    const P = world.p.plants;
    const T = world.terrain;
    if (!P.enabled || T === null || T.biomeGrid === null) return null;
    const { grass } = world;
    const { cols, rows } = grass;
    const B = T.biomeGrid;
    const rng = createRng(world.seed ^ 0x6265727a);
    // Edges: a patch of one biome with another within two patches.
    const near = (c, r, biome) => {
        for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
                const cc = (c + dc + cols) % cols;
                const rr = (r + dr + rows) % rows;
                if (B[cc + rr * cols] === biome) return true;
            }
        }
        return false;
    };
    // Each patch's weight for each kind, and a key (weighted sampling: the
    // largest u^(1/w) are taken), so the most likely places win.
    const keys = [[], []];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const k = c + r * cols;
            const b = B[k];
            if (b !== BIOME.MEADOW && b !== BIOME.FOREST && b !== BIOME.WETLAND) continue;
            const x = (c + 0.5) * grass.cellW;
            const y = (r + 0.5) * grass.cellH;
            if (!T.spawnable(x, y)) continue;
            // Berries: meadow by the forest (or the forest's edge), a few in open meadow.
            const berry = b === BIOME.MEADOW ? (near(c, r, BIOME.FOREST) ? 1 : 0.08) : b === BIOME.FOREST && near(c, r, BIOME.MEADOW) ? 0.6 : 0;
            // Fruit: meadow by the wetland (or the wetland's edge).
            const fruit = b === BIOME.MEADOW ? (near(c, r, BIOME.WETLAND) ? 1 : 0.03) : b === BIOME.WETLAND && near(c, r, BIOME.MEADOW) ? 0.5 : 0;
            const u = rng.next();
            const v = rng.next();
            if (berry > 0) keys[0].push([Math.pow(u, 1 / berry), k]);
            if (fruit > 0) keys[1].push([Math.pow(v, 1 / fruit), k]);
        }
    }
    const picked = new Set();
    const chosen = [];
    for (const [kind, list, most] of [[PLANT.BERRY, keys[0], P.berries], [PLANT.FRUIT, keys[1], P.fruit]]) {
        list.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
        let n = 0;
        for (const [, k] of list) {
            if (n >= most) break;
            if (picked.has(k)) continue; // (one plant a patch)
            picked.add(k);
            chosen.push([kind, k]);
            n++;
        }
    }
    const n = chosen.length;
    const plants = {
        n, x: new Float64Array(n), y: new Float64Array(n), kind: new Uint8Array(n),
        fruit: new Float32Array(n), taken: new Float32Array(n), rev: 0,
    };
    for (let j = 0; j < n; j++) {
        const [kind, k] = chosen[j];
        const c = k % cols;
        const r = Math.floor(k / cols);
        plants.kind[j] = kind;
        plants.x[j] = (c + 0.2 + 0.6 * rng.next()) * grass.cellW;
        plants.y[j] = (r + 0.2 + 0.6 * rng.next()) * grass.cellH;
    }
    ripen(world, plants);
    return plants;
}

// ---- Through the year ---------------------------------------------------------------------

// Every few steps (World.step): the crops come in and fall.
export function stepPlants(world) {
    if (world.time % EVERY === 0) ripen(world, world.plants);
}

// What is on each plant now: its crop less what was picked; with no crop,
// what was picked is forgotten (next year's crop is whole).
function ripen(world, plants) {
    const y = world.now.yearT;
    const crops = [0, crop(PLANT.BERRY, y), crop(PLANT.FRUIT, y)];
    const { kind, fruit, taken } = plants;
    let changed = false;
    for (let j = 0; j < plants.n; j++) {
        const c = crops[kind[j]];
        if (c === 0) taken[j] = 0;
        const f = c > taken[j] ? c - taken[j] : 0;
        if (f !== fruit[j]) {
            fruit[j] = f;
            changed = true;
        }
    }
    if (changed) plants.rev++;
}

// ---- Picking ------------------------------------------------------------------------------

// The food on a full plant of `kind`.
export const foodOf = (P, kind) => (kind === PLANT.BERRY ? P.berryFood : P.fruitFood);

// Pick up to `amount` food from plant j: what was taken.
export function pick(world, j, amount) {
    const plants = world.plants;
    const P = world.p.plants;
    const food = foodOf(P, plants.kind[j]);
    const on = plants.fruit[j] * food;
    const take = amount < on ? amount : on;
    if (!(take > 0)) return 0;
    const share = take / food;
    plants.taken[j] += share;
    plants.fruit[j] = plants.fruit[j] > share ? plants.fruit[j] - share : 0;
    plants.rev++;
    world.plantStats.picked += take;
    return take;
}

// The nearest plant to (x, y) within r with fruit on it worth picking
// (plants.ripe; `ripe` for the page's Mirror, which has the same numbers):
// its index, or -1. A world-ish `w` (World or Mirror: plants, p, width, height).
export function ripeNear(w, x, y, r) {
    const plants = w.plants;
    if (!plants) return -1;
    const ripe = w.p.plants.ripe;
    let best = -1;
    let bestD2 = r * r;
    for (let j = 0; j < plants.n; j++) {
        if (plants.fruit[j] < ripe) continue;
        const dx = wrapDelta(plants.x[j] - x, w.width);
        if (dx > r || dx < -r) continue;
        const dy = wrapDelta(plants.y[j] - y, w.height);
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestD2) {
            bestD2 = d2;
            best = j;
        }
    }
    return best;
}

// The plants near tribe t's camp (within its home range and a forager's
// sight beyond), worked out again when the camp moves (or plants are added:
// package 3's cultivators): their indices.
function nearCamp(world, t) {
    const near = t.plantsNear;
    if (near && near.x === t.camp.x && near.y === t.camp.y && near.n === world.plants.n) return near.list;
    const plants = world.plants;
    const R = world.p.human.homeRange + world.p.plants.sight;
    const list = [];
    for (let j = 0; j < plants.n; j++) {
        const dx = wrapDelta(plants.x[j] - t.camp.x, world.width);
        const dy = wrapDelta(plants.y[j] - t.camp.y, world.height);
        if (dx * dx + dy * dy < R * R) list.push(j);
    }
    t.plantsNear = { x: t.camp.x, y: t.camp.y, n: plants.n, list };
    return list;
}

// The nearest ripe plant within plants.sight of person i, among those near
// its tribe's camp: its index, or -1; the offset to it in TO.
export const TO = { dx: 0, dy: 0, d: 0 };
export function ripeFor(world, i, t) {
    const plants = world.plants;
    const P = world.p.plants;
    const pop = world.humans;
    const x = pop.x[i];
    const y = pop.y[i];
    const list = nearCamp(world, t);
    let best = -1;
    let bestD2 = P.sight * P.sight;
    for (let k = 0; k < list.length; k++) {
        const j = list[k];
        if (plants.fruit[j] < P.ripe) continue;
        const dx = wrapDelta(plants.x[j] - x, world.width);
        const dy = wrapDelta(plants.y[j] - y, world.height);
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
            bestD2 = d2;
            best = j;
            TO.dx = dx;
            TO.dy = dy;
        }
    }
    if (best >= 0) TO.d = Math.sqrt(bestD2);
    return best;
}
