// The simulation engine. No DOM, no canvas: the browser and the headless
// checks (headless/check.mjs) run exactly this code, so what is verified
// headlessly is what you see on screen.
//
// Layout is data-oriented for speed: each species is a set of parallel typed
// arrays (population.js), neighbour search uses a counting-sort spatial hash
// rebuilt every step without allocating (spatial.js), and grass is a flat grid
// of numbers rather than agents (grass.js).
//
// Terrain (terrain.js) is optional: with params.terrain.enabled off,
// world.terrain is null and every terrain branch below is skipped, so the
// flat world runs exactly as it always did.
//
// Time (stage 4): each step begins with clock(), the moment by the calendar
// (calendar.js) and what follows from it for everyone: night and dusk, the
// season and this year's winter, how fast the grass grows, how fat grazers
// may grow, and the season's chance of a birth. Lives are long: an animal
// keeps a reserve of fat, eats a big kill into it, and is worth its stomach,
// fat and body to whoever eats it (meatOf); births come in their season, to
// the well fed, and (grazers) the better the pasture, (predators) the emptier
// their territory.
import { createRng } from './rng.js';
import { when, winterOf, seasonal } from './calendar.js';
import { Population, STATE } from './population.js';
import { SpatialHash } from './spatial.js';
import { Grass } from './grass.js';
import { Terrain, BIOME } from './terrain.js';
import { stepHumans, driveOff } from './humans.js';
import { seedTribes, stepTribes } from './tribes.js';
import { caught, afterStep } from './player.js';
import { Spears, stepSpears, carrion, CARRION, eatCarcass } from './spears.js';
import { fighting } from './orders.js';
import { initItems, bequeath, shielded, creditHolder, TASK } from './items.js';
import { stepItems } from './tasks.js';
import { spared, keepLife } from './admin.js';
import { TAU } from './util.js';

export { STATE, STATE_LABEL } from './population.js';

const LOOK_ANGLE = 0.8; // a grazer peeks this far (radians) to either side
const LOOK_COS = Math.cos(LOOK_ANGLE);
const LOOK_SIN = Math.sin(LOOK_ANGLE);

// What a mother has left after a birth (World.bear), read at once.
const born = { e: 0, f: 0 };

// Size a world with the configured AREA and the given aspect ratio (w / h).
export function worldSize(area, aspect) {
    return {
        width: Math.round(Math.sqrt(area * aspect)),
        height: Math.round(Math.sqrt(area / aspect)),
    };
}

export class World {
    constructor(params, { seed = 1, aspect = 1.6 } = {}) {
        // The numbers this world lives by (config.js), its own copy: the
        // console's `set` changes them live. Everything reads these, world.p.
        this.p = params = structuredClone(params);
        this.seed = seed;
        this.rng = createRng(seed);
        const { width, height } = worldSize(params.world.area, aspect);
        this.width = width;
        this.height = height;
        this.time = 0;
        this.nextId = 1;
        this.watch = 0;    // id of an animal someone is following; its death is recorded in `fate`
        this.fate = null;
        this.deaths = { herbivore: {}, carnivore: {}, human: {} }; // running count by cause
        // What happened during the last step, for the page to draw (a body
        // falling, blood): plain objects such as { type: 'death', kind, id,
        // x, y, heading, cause, by, time }. Cleared as each step begins; the
        // simulation never reads it.
        this.events = [];
        // The person the page controls (src/player.js), or null: nobody, and
        // then the world runs exactly as if player.js did not exist.
        this.player = null;
        // The admin console's `immortal` (admin.js): null, or {id, life}, the
        // controlled person's life, which does not fall while it is set.
        this.immortal = null;
        // The player's spears in flight, and its kills waiting to be butchered
        // (src/spears.js): empty unless someone is played. With items, every
        // hunter's kills wait to be butchered too. A carcass never rots: it
        // goes when its meat is gone (cut up, or eaten by predators).
        this.spears = new Spears();
        this.carcasses = new Map(); // the dead creature's id → its carcass
        // Items (src/items.js): world.items, and world.itemsOn, false when
        // params.items.enabled is off (then nothing about items ever runs).
        initItems(this);

        this.terrain = params.terrain.enabled ? new Terrain(width, height, params.terrain, this.rng) : null;
        // Biomes draw from a random stream of their own, so the land and the
        // animals on it start out the same with them on or off.
        if (this.terrain && params.biomes.enabled) this.terrain.makeBiomes(params.biomes, createRng(seed ^ 0x5eedb10e));
        this.grass = new Grass(width, height, params.world.grassCell, params.grass.initial, this.rng);
        if (this.terrain) {
            // grass.initial is the level grazers keep the grass at (THEORY.md §3).
            this.grass.setFertility(this.terrain.fertilityGrid(this.grass), params.terrain.compensate, params.grass.initial);
        }
        // Forest cover (params.biomes.cover): which grazers stand in forest,
        // updated every step, where hunters see them only from closer.
        this.hidden = this.terrain && this.terrain.biomes && params.biomes.cover ? new Uint8Array(1024) : null;
        this.coverSight = params.biomes.coverSight;
        this.herbivores = new Population();
        this.carnivores = new Population();
        this.humans = new Population();
        this.herbivoreHash = new SpatialHash(width, height, params.world.hashCell);
        this.facing = new Float64Array(0); // (stepHerbivores: headings' cos and sin, kept)
        this.facingCos = this.facing;
        this.facingSin = this.facing;
        this.carnivoreHash = new SpatialHash(width, height, params.world.hashCell, true);
        this.humanHash = new SpatialHash(width, height, params.world.hashCell, true, 'tribe');
        this.tribes = [];          // living tribes
        this.tribeById = new Map();
        this.fallen = [];          // the most recent tribes to die out
        this.nextTribeId = 1;
        // How high each grass patch lies, 0 at the shore .. 1 at the highest
        // summit (null on a flat world): grazers look for lower, warmer
        // ground in winter.
        this.lowland = this.terrain ? this.heights() : null;

        // The moment (calendar.js) and what follows from it: see clock().
        this.clock();
        this.seedPopulation(this.herbivores, params.herbivore);
        this.seedPopulation(this.carnivores, params.carnivore);
        if (params.human.enabled) seedTribes(this);
    }

    // The first animals: of every age up to six tenths of a life, fed, with a
    // little fat left from the winter.
    seedPopulation(pop, sp) {
        const { rng, terrain } = this;
        const spread = this.p.evolution.initialSpread;
        for (let k = 0; k < sp.initial; k++) {
            let x = rng.next() * this.width;
            let y = rng.next() * this.height;
            while (terrain && !terrain.spawnable(x, y)) {
                x = rng.next() * this.width;
                y = rng.next() * this.height;
            }
            const i = this.spawn(pop, sp, x, y,
                sp.maxEnergy * (0.4 + 0.5 * rng.next()),
                sp.genes.speed * Math.exp(spread * rng.gauss()),
                sp.genes.sense * Math.exp(spread * rng.gauss()),
                rng.next() * sp.lifespan * 0.6);
            pop.fat[i] = sp.fatMax * 0.2;
        }
    }

    heights() {
        const { grass, terrain } = this;
        const out = new Float32Array(grass.cols * grass.rows);
        const span = terrain.peak - terrain.seaLevel;
        for (let r = 0; r < grass.rows; r++) {
            for (let c = 0; c < grass.cols; c++) {
                const h = (terrain.heightAt((c + 0.5) * grass.cellW, (r + 0.5) * grass.cellH) - terrain.seaLevel) / span;
                out[r * grass.cols + c] = h < 0 ? 0 : h > 1 ? 1 : h;
            }
        }
        return out;
    }

    // The moment, once a step (calendar.js): the part of the day, the season
    // and this year's winter (0 mild, 1 normal, 2 hard), and what follows
    // from them for everyone: `cold`, how deep into winter (0..1, eased in at
    // the end of autumn and out at the end of winter); how fast the grass
    // grows; the grazers' fattening and the animals' chance of a birth.
    clock() {
        const c = this.p.calendar;
        const now = when(c, this.time);
        const G = this.p.grass;
        const H = this.p.herbivore;
        const C = this.p.carnivore;
        this.now = now;
        this.night = now.part === 'night';
        this.dusk = now.part === 'dusk';
        this.winter = winterOf(c, this.seed, now.year);
        this.cold = seasonal(now, 0, 0, 0, 1);
        // (The winter that eases into spring is last year's.)
        const winter = now.season === 0 ? winterOf(c, this.seed, now.year - 1) : this.winter;
        this.regrowth = G.regrowth * seasonal(now, G.seasons[0], G.seasons[1], G.seasons[2], G.seasons[3] * G.winters[winter]);
        this.fatCap = H.fatMax * seasonal(now, H.fatten[0], H.fatten[1], H.fatten[2], H.fatten[3]);
        this.breedH = H.birthChance * seasonal(now, H.births[0], H.births[1], H.births[2], H.births[3], 0.1);
        this.breedC = C.birthChance * seasonal(now, C.births[0], C.births[1], C.births[2], C.births[3], 0.1);
        const Hu = this.p.human;
        this.breedP = Hu.birthChance * seasonal(now, Hu.births[0], Hu.births[1], Hu.births[2], Hu.births[3], 0.1);
    }

    // What individual i of `pop` is worth to whoever eats it: its stomach, its
    // fat, and its body's meat (a newborn's a quarter of a grown one's).
    meatOf(pop, i) {
        const P = this.p[this.kindOf(pop)];
        const grown = pop.age[i] < P.maturity ? pop.age[i] / P.maturity : 1;
        return pop.energy[i] + pop.fat[i] + P.meat * (0.25 + 0.75 * grown);
    }

    // Animal i of `pop` (species P), with `e` in its stomach and `f` of fat,
    // gives birth: a litter of P.litter young (its fraction, the chance of
    // one more), sharing childShare of the stomach and birthCost of the fat
    // (or what fat there is). What it has left goes in `born`.
    bear(pop, P, i, e, f) {
        let young = Math.floor(P.litter);
        if (young < P.litter && this.rng.next() < P.litter - young) young++;
        const food = e * P.childShare;
        const fat = f < P.birthCost ? f : P.birthCost;
        pop.bred[i] = this.time;
        for (let k = 0; k < young; k++) {
            const c = this.spawn(pop, P, pop.x[i], pop.y[i], food / young, this.mutate(pop.speedGene[i]), this.mutate(pop.senseGene[i]), 0, i);
            pop.fat[c] = fat / young;
        }
        born.e = e - food;
        born.f = f - fat;
    }

    spawn(pop, sp, x, y, energy, speedGene, senseGene, age = 0, parent = -1) {
        const { rng } = this;
        const i = pop.add();
        pop.x[i] = x;
        pop.y[i] = y;
        pop.heading[i] = rng.next() * TAU;
        pop.energy[i] = energy;
        pop.age[i] = age;
        pop.lifespan[i] = sp.lifespan * (1 + (sp.lifespanJitter ?? this.p.lifespanJitter) * (2 * rng.next() - 1));
        pop.speedGene[i] = speedGene;
        pop.senseGene[i] = senseGene;
        pop.upkeep[i] = this.upkeep(speedGene, senseGene);
        pop.id[i] = this.nextId++;
        pop.parent[i] = parent >= 0 ? pop.id[parent] : 0;
        pop.lineage[i] = parent >= 0 ? pop.lineage[parent] : 0;
        pop.generation[i] = parent >= 0 ? pop.generation[parent] + 1 : 0;
        if (parent >= 0) pop.children[parent]++;
        pop.children[i] = 0;
        pop.kills[i] = 0;
        pop.focus[i] = 0;
        pop.state[i] = STATE.GRAZING;
        pop.fat[i] = 0;
        pop.bred[i] = -1e9; // (never yet)
        return i;
    }

    // Mark individual i as dead. If it is the one being followed, keep a note
    // of how its story ended. (The event also says, for drawing, a person's
    // tribe and whether a child died.)
    die(pop, i, cause, by = 0) {
        if (this.player !== null && this.immortal !== null && spared(this, pop, i, cause)) return; // (admin.js: immortal)
        pop.energy[i] = 0;
        const kind = this.kindOf(pop);
        const tally = this.deaths[kind];
        tally[cause] = (tally[cause] || 0) + 1;
        this.events.push({
            type: 'death', kind, id: pop.id[i], x: pop.x[i], y: pop.y[i], heading: pop.heading[i], cause, by, time: this.time,
            tribe: pop === this.humans ? pop.tribe[i] : 0, child: pop.age[i] < this.p[kind].maturity,
        });
        if (this.itemsOn && pop === this.humans) {
            // What it held is handed down or left lying (items.js); and a death
            // at a kill being butchered is counted, for the checks.
            if (pop.task[i] === TASK.BUTCHER) this.itemStats.butcherDeaths[cause] = (this.itemStats.butcherDeaths[cause] || 0) + 1;
            if (cause === 'eaten') {
                this.itemStats.eatenAt[pop.task[i]]++;
                this.itemStats.eatenArm[pop.gear[i] >> 3]++;
            }
            bequeath(this, i);
        }
        if (pop.id[i] !== this.watch) return;
        this.fate = {
            id: pop.id[i],
            kind: this.kindOf(pop),
            cause, // 'old age' | 'starvation' | 'eaten' | 'hunted' | 'killed'
            by,    // id of whoever killed it
            tribe: pop === this.humans ? pop.tribe[i] : 0,
            age: pop.age[i],
            children: pop.children[i],
            kills: pop.kills[i],
            generation: pop.generation[i],
            time: this.time,
        };
    }

    kindOf(pop) {
        return pop === this.herbivores ? 'herbivore' : pop === this.carnivores ? 'carnivore' : 'human';
    }

    // Where is the individual with this id now? (Indices shift as others die.)
    find(id) {
        if (!id) return null;
        for (const [kind, pop] of [['herbivore', this.herbivores], ['carnivore', this.carnivores], ['human', this.humans]]) {
            const ids = pop.id;
            for (let i = 0; i < pop.n; i++) if (ids[i] === id) return { kind, pop, i };
        }
        return null;
    }

    // Start following an animal: record its fate when it dies, and tag its
    // living descendants (newborns inherit the tag), so the story can carry on
    // through its offspring.
    follow(id) {
        this.watch = id;
        this.fate = null;
        const found = this.find(id);
        if (!found) return;
        const { pop, i } = found;
        const indexOf = new Map();
        for (let k = 0; k < pop.n; k++) indexOf.set(pop.id[k], k);
        pop.lineage[i] = id;
        for (let changed = true; changed; ) {
            changed = false;
            for (let k = 0; k < pop.n; k++) {
                if (pop.lineage[k] === id) continue;
                const p = indexOf.get(pop.parent[k]);
                if (p !== undefined && pop.lineage[p] === id) {
                    pop.lineage[k] = id;
                    changed = true;
                }
            }
        }
    }

    // A living descendant of the animal `id` (a child if possible), or 0.
    descendant(id) {
        let any = 0;
        for (const pop of [this.herbivores, this.carnivores, this.humans]) {
            for (let i = 0; i < pop.n; i++) {
                if (pop.lineage[i] !== id || pop.id[i] === id || pop.energy[i] <= 0) continue;
                if (pop.parent[i] === id) return pop.id[i];
                any = any || pop.id[i];
            }
        }
        return any;
    }

    mutate(gene) {
        const ev = this.p.evolution;
        if (!ev.enabled) return gene;
        const g = gene * Math.exp(ev.sigma * this.rng.gauss());
        return g < ev.min ? ev.min : g > ev.max ? ev.max : g;
    }

    // Basal-metabolism multiplier for carrying a body with these genes.
    upkeep(speedGene, senseGene) {
        const { wSpeed, wSense } = this.p.evolution;
        return (1 - wSpeed - wSense) + wSpeed * speedGene * speedGene + wSense * senseGene * senseGene;
    }

    // Advance the world by one step.
    step() {
        this.events.length = 0;
        this.clock();
        this.carnivoreHash.build(this.carnivores);
        this.humanHash.build(this.humans);
        // (At night and in winter grazers keep together: they need to know
        // where the others are as they move.)
        if (this.night || this.cold > 0.5) this.herbivoreHash.build(this.herbivores);
        this.stepHerbivores();
        this.herbivoreHash.build(this.herbivores); // (stepHerbivores noted who stands in forest: hidden)
        this.stepCarnivores();
        if (this.humans.n) stepHumans(this);
        if (this.spears.n) stepSpears(this);            // the player's, in flight (spears.js)
        this.grass.regrow(this.regrowth); // (grass.regrowth, by the season: clock)
        this.herbivores.compact();
        this.carnivores.compact();
        this.humans.compact();
        if (this.tribes.length) stepTribes(this);
        if (this.itemsOn) stepItems(this);               // torches burn out, lost items go, tribes reckon their needs
        if (this.player !== null) afterStep(this); // if the controlled person died: its heir (player.js)
        if (this.player !== null && this.immortal !== null) keepLife(this); // (admin.js: immortal)
        this.time++;
    }

    // One step of every grazer. Besides fleeing, grazing and looking for
    // grass, the seasons and the hour (clock): it grazes slower under the
    // snow; it lays on fat when full in the good months and draws on it when
    // hungry; at night and in winter it keeps near the others; in winter it
    // looks for grass downhill, where it is warmer; and it gives birth in its
    // season, when well fed.
    stepHerbivores() {
        const P = this.p.herbivore;
        const pop = this.herbivores;
        const n = pop.n;
        pop.reserve(n * Math.ceil(P.litter)); // at most one litter each
        const { x, y, heading, energy, age, lifespan, speedGene, senseGene, upkeep, state, focus, fat, bred } = pop;
        const { rng, width: W, height: H, carnivoreHash: threats, humanHash: hunters, herbivoreHash: herd, grass, terrain, time } = this;
        const g = grass.g;
        const predatorIds = this.carnivores.id;
        const hunterIds = this.humans.id;
        const anyHunters = this.humans.n > 0;
        // A crouching player (player.js) is noticed only from closer: its id
        // (0: nobody crouches), and that fraction of a grazer's range.
        const creeper = this.player !== null && this.player.crouch ? this.player.id : 0;
        const creep = creeper ? this.p.play.crouchSense : 0;
        // The predators' and the people's marks (spatial.js empty()), read
        // here for both at once when their hashes share their buckets.
        const marks = threats.twin(hunters);
        const small = threats.small;
        const threatNear = threats.near;
        const hunterNear = hunters.near;
        // The season and the hour.
        const cold = this.cold;
        const biteMax = P.bite * (1 - P.snowBite * cold);
        const fatCap = this.fatCap;
        const drawAt = P.draw * P.maxEnergy;
        // Births, the more readily the better the pasture: the land's grass
        // between pasture[0] (none) and [1] (as many as the season allows).
        // Where the herds are many, the grass is grazed short.
        const lush = (grass.level - P.pasture[0]) / (P.pasture[1] - P.pasture[0]);
        const breed = lush <= 0 ? 0 : lush >= 1 ? this.breedH : this.breedH * lush;
        const herding = this.night || cold > 0.5; // (step() built the herd's hash for it)
        const near2 = P.herd * P.herd;
        let moved = 0; // the farthest any grazer has moved this step (since the herd's hash was built: closeBy)
        const lowland = this.lowland;
        const down = lowland !== null ? P.descend * cold : 0;
        // A heading and its cos and sin, each grazer's last worked out: one
        // that searches on in the same direction needs them again. (A slot
        // may hold another's after compact(): only the heading tells.)
        if (this.facing.length < pop.capacity) {
            this.facing = new Float64Array(pop.capacity).fill(NaN);
            this.facingCos = new Float64Array(pop.capacity);
            this.facingSin = new Float64Array(pop.capacity);
        }
        const { facing, facingCos, facingSin } = this;
        // Forest cover (params.biomes.cover): which grazers stand in forest
        // when the step is done, where hunters see them only from closer
        // (spot). Noted for each where it ends its step, the newborn below.
        if (this.hidden !== null && this.hidden.length < pop.capacity) this.hidden = new Uint8Array(pop.capacity);
        const hidden = this.hidden;
        const biomeOf = hidden !== null ? this.terrain.biomeGrid : null;
        const FOREST = BIOME.FOREST;

        for (let i = 0; i < n; i++) {
            if (++age[i] > lifespan[i]) {
                this.die(pop, i, 'old age');
                if (hidden !== null) hidden[i] = biomeOf[grass.index(x[i], y[i])] === FOREST ? 1 : 0;
                continue;
            }
            const sg = speedGene[i];
            const vg = senseGene[i];
            const top = P.speed * sg;
            let h = heading[i];
            let v = 0;
            let dx = 0;
            let dy = 0;
            let gi = -1; // the grass patch underfoot, once looked up
            state[i] = STATE.GRAZING;
            focus[i] = 0;

            // The closest danger: a carnivore, or a human hunter. (Most often
            // the hashes' marks tell at once that neither is near: then both
            // searches are passed by, leaving what they would leave, d2 = r².)
            const sense = P.sense * vg;
            const q = marks && sense <= small ? threats.bucketOf(x[i], y[i]) : -1;
            let threat = -1;
            let tdx = 0;
            let tdy = 0;
            let threatId = 0;
            if (q >= 0 && threatNear[q] === 0 && hunterNear[q] === 0) {
                threats.d2 = sense * sense;
                if (anyHunters) hunters.d2 = sense * sense;
            } else {
                threat = threats.nearest(x[i], y[i], sense);
                tdx = threats.dx;
                tdy = threats.dy;
                threatId = threat >= 0 ? predatorIds[threat] : 0;
                if (anyHunters) {
                    const k = hunters.nearest(x[i], y[i], sense);
                    // (If the nearest person is the player creeping up from farther
                    // than it can tell, it takes no notice of people this step.)
                    if (k >= 0 && (threat < 0 || hunters.d2 < threats.d2)
                        && (hunterIds[k] !== creeper || hunters.d2 < (creep * P.sense * vg) ** 2)) {
                        threat = k;
                        tdx = hunters.dx;
                        tdy = hunters.dy;
                        threatId = hunterIds[k];
                    }
                }
            }
            if (threat >= 0) {
                // Run straight away from the closest danger.
                const d = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
                dx = -tdx / d;
                dy = -tdy / d;
                h = Math.atan2(dy, dx);
                v = top;
                state[i] = STATE.FLEEING;
                focus[i] = threatId;
            } else if (herding && !herd.closeBy(x[i], y[i], P.herdSight, i, P.herd, moved)
                && herd.nearest(x[i], y[i], P.herdSight, i) >= 0 && herd.d2 > near2) {
                // Alone at night or in winter: back to the others, the nearest first.
                // (The usual case, another within `herd` already, closeBy()
                // tells sooner than nearest() would, and with the same answer.)
                const d = Math.sqrt(herd.d2);
                dx = herd.dx / d;
                dy = herd.dy / d;
                h = Math.atan2(dy, dx);
                v = top * P.cruise;
                state[i] = STATE.SEARCHING;
            } else if (g[gi = grass.index(x[i], y[i])] < biteMax) {
                state[i] = STATE.SEARCHING;
                // Patch grazed out: peek straight ahead and 0.8 rad to either
                // side, and head for the greenest (in winter, counting lower
                // ground as greener). If none is better than here, wander off
                // in a new direction.
                const look = P.sense * vg;
                // (cos h and sin h, unless known from its last step: the same h.
                // Not for 0, which === takes for -0, whose sine is -0.)
                let ch;
                let sh;
                if (facing[i] === h && h !== 0) {
                    ch = facingCos[i];
                    sh = facingSin[i];
                } else {
                    ch = Math.cos(h);
                    sh = Math.sin(h);
                    facing[i] = h;
                    facingCos[i] = ch;
                    facingSin[i] = sh;
                }
                const here = gi;
                let best = down > 0 ? g[here] - down * lowland[here] : g[here];
                let turn = 2; // none found yet
                for (let k = -1; k <= 1; k++) {
                    // (cos, sin) of h + k·LOOK_ANGLE, by rotating (ch, sh).
                    const ux = k === 0 ? ch : ch * LOOK_COS - k * sh * LOOK_SIN;
                    const uy = k === 0 ? sh : sh * LOOK_COS + k * ch * LOOK_SIN;
                    let lx = x[i] + ux * look;
                    let ly = y[i] + uy * look;
                    if (lx < 0) lx += W; else if (lx >= W) lx -= W;
                    if (ly < 0) ly += H; else if (ly >= H) ly -= H;
                    const there = grass.index(lx, ly);
                    const gv = down > 0 ? g[there] - down * lowland[there] : g[there];
                    if (gv > best) {
                        best = gv;
                        turn = k;
                        dx = ux;
                        dy = uy;
                    }
                }
                if (turn === 2) {
                    h += (rng.next() - 0.5) * 2;
                    dx = Math.cos(h);
                    dy = Math.sin(h);
                    facing[i] = h;
                    facingCos[i] = dx;
                    facingSin[i] = dy;
                } else {
                    h += turn * LOOK_ANGLE;
                }
                v = top * P.cruise;
            }

            if (v > 0) {
                let nx = x[i] + dx * v;
                let ny = y[i] + dy * v;
                if (nx < 0) nx += W; else if (nx >= W) nx -= W;
                if (ny < 0) ny += H; else if (ny >= H) ny -= H;
                if (terrain !== null && terrain.blocked(nx, ny)) {
                    // Water or a cliff ahead: veer along it (or turn back if boxed in).
                    if (terrain.move(x[i], y[i], dx, dy, v, terrain.side(dx, dy, heading[i], rng))) h = Math.atan2(terrain.uy, terrain.ux);
                    else h += Math.PI;
                    nx = terrain.x;
                    ny = terrain.y;
                }
                x[i] = nx;
                y[i] = ny;
                heading[i] = h;
                if (v > moved) moved = v;
            }

            let e = energy[i] - P.baseCost * upkeep[i] - P.moveCost * v * v;
            let f = fat[i];

            // Graze: into the stomach, and past a full one into fat, as far as
            // the season lets it fatten. Hungry, it draws on its fat. (The
            // patch underfoot is known already if it has not moved.)
            if (v > 0 || gi < 0) gi = grass.index(x[i], y[i]);
            if (hidden !== null) hidden[i] = biomeOf[gi] === FOREST ? 1 : 0;
            const room = P.maxEnergy - e + (f < fatCap ? fatCap - f : 0);
            if (room > 0) {
                let bite = g[gi];
                if (bite > biteMax) bite = biteMax;
                if (bite * P.grassEnergy > room) bite = room / P.grassEnergy;
                g[gi] -= bite;
                e += bite * P.grassEnergy;
            }
            if (e > P.maxEnergy) {
                f += e - P.maxEnergy;
                e = P.maxEnergy;
            } else if (e < drawAt && f > 0) {
                const d = drawAt - e < f ? drawAt - e : f;
                f -= d;
                e += d;
            }

            if (e <= 0) {
                this.die(pop, i, 'starvation');
                continue;
            }

            // A birth, in its season, when grown and well fed.
            if (breed > 0 && age[i] >= P.maturity && e + f >= P.birthReserve && time - bred[i] >= P.birthGap && rng.next() < breed) {
                this.bear(pop, P, i, e, f);
                e = born.e;
                f = born.f;
            }
            energy[i] = e;
            fat[i] = f;
        }
        if (hidden !== null) for (let k = n; k < pop.n; k++) hidden[k] = biomeOf[grass.index(x[k], y[k])] === FOREST ? 1 : 0;
    }

    // One step of every predator: hunting when its stomach and fat run low
    // (more readily at night; a carcass it scents first), eating its kill
    // (what the stomach cannot hold goes to fat), and roaming wider at night
    // and in winter; a birth in its season, when well fed, with its
    // territory not too crowded.
    stepCarnivores() {
        const P = this.p.carnivore;
        const pop = this.carnivores;
        const n = pop.n;
        pop.reserve(n * Math.ceil(P.litter));
        const { x, y, heading, energy, age, lifespan, speedGene, senseGene, upkeep, timer, state, focus, kills, id, fat, bred } = pop;
        const { rng, width: W, height: H, herbivoreHash: grazers, humanHash: people, carnivoreHash: rivals, terrain, time } = this;
        const { herbivores, humans } = this;
        const anyPeople = humans.n > 0;
        const cover = this.hidden !== null;
        // The hour and the season: bolder at night, roaming wider at night and in winter.
        const night = this.night;
        const hungry = P.hunt * (night ? P.bold : 1);
        const giveUp = 1 / (P.stamina * (night ? P.bold : 1));
        const roam = 1 + (night ? P.roamNight : 0) + P.roamWinter * this.cold;
        const drawAt = P.draw * P.maxEnergy;
        const breed = this.breedC;
        // (Counting rivals and prey only as far as the answer needs: more
        // than `rivals`, at least `prey`.)
        const tooMany = Math.floor(P.rivals) + 1;
        const enough = Math.ceil(P.prey);

        for (let i = 0; i < n; i++) {
            if (++age[i] > lifespan[i]) {
                this.die(pop, i, 'old age');
                continue;
            }
            const sg = speedGene[i];
            const vg = senseGene[i];
            const top = P.speed * sg;
            let e = energy[i];
            let f = fat[i];
            let h = heading[i];
            let v = 0;

            // Interference: a rival too close means stand-offs and lost
            // meals. It costs energy, and an idle predator moves off.
            const rival = rivals.nearest(x[i], y[i], P.crowdRadius, i);
            if (rival >= 0) e -= P.crowdCost;
            let meal = null; // (carrion it scents, if it is hungry: spears.js)

            if (timer[i] > 0) {
                timer[i]--; // eating, digesting or catching its breath (state unchanged)
            } else if (e + f < hungry && this.carcasses.size !== 0 && (meal = carrion(this, x[i], y[i], P.smell * vg, P.wary)) !== null) {
                // A carcass scented: a meal that does not run. To it, and
                // eat what the stomach and fat can hold (× efficiency, as a kill).
                const d = Math.sqrt(CARRION.d2);
                h = Math.atan2(CARRION.dy, CARRION.dx);
                focus[i] = 0;
                if (d <= P.catchRadius) {
                    e += eatCarcass(this, meal, (P.maxEnergy - e + P.fatMax - f) / P.efficiency, id[i]) * P.efficiency;
                    timer[i] = P.handling;
                    state[i] = STATE.EATING;
                } else {
                    v = d < top * P.cruise ? d : top * P.cruise;
                    state[i] = STATE.ROAMING;
                }
            } else if (e + f < hungry) {
                // The nearest prey: a grazer, or a person.
                let j = cover ? this.spot(grazers, x[i], y[i], P.sense * vg) : grazers.nearest(x[i], y[i], P.sense * vg);
                let victims = herbivores;
                let found = grazers;
                if (anyPeople) {
                    const k = people.nearest(x[i], y[i], P.sense * vg);
                    if (k >= 0 && (j < 0 || people.d2 < grazers.d2)) {
                        j = k;
                        victims = humans;
                        found = people;
                    }
                }
                if (j >= 0) {
                    const d = Math.sqrt(found.d2);
                    h = Math.atan2(found.dy, found.dx);
                    v = d < top ? d : top;
                    state[i] = STATE.CHASING;
                    focus[i] = victims.id[j];
                    if (d - v <= P.catchRadius) {
                        if (victims === humans && this.itemsOn && shielded(this, j)) {
                            // A burning torch (items.js): it will not take the
                            // one who bears it, and backs off.
                            timer[i] = P.rest;
                            state[i] = STATE.RESTING;
                        } else if (victims === humans && driveOff(this, j)) {
                            // The person's tribe-mates drive it off, and may kill it.
                            timer[i] = P.rest;
                            state[i] = STATE.RESTING;
                            const tribe = this.tribeById.get(humans.tribe[j]);
                            if (rng.next() < fighting(tribe) * this.p.human.killPredator) { // (defending a camp: fiercer, orders.js)
                                if (this.itemsOn) creditHolder(this, j, pop, i); // (the kill of the weapon it went for)
                                this.die(pop, i, 'killed', humans.id[j]);
                                humans.kills[j]++;
                                continue;
                            }
                        } else if (victims === humans && this.player !== null && humans.id[j] === this.player.id
                            && !this.player.auto && caught(this, i, j)) {
                            // The person the page steers is only bitten, or
                            // missed mid-roll (player.js), and lives on.
                        } else {
                            e += this.meatOf(victims, j) * P.efficiency;
                            this.die(victims, j, 'eaten', id[i]);
                            kills[i]++;
                            timer[i] = P.handling;
                            state[i] = STATE.EATING;
                        }
                    } else if (rng.next() < giveUp) {
                        timer[i] = P.rest; // give up, out of breath
                        state[i] = STATE.RESTING;
                        focus[i] = 0;
                    }
                } else {
                    h = rival >= 0 ? Math.atan2(-rivals.dy, -rivals.dx) : h + ((rng.next() - 0.5) * P.turn) / roam;
                    v = top * P.cruise * roam;
                    state[i] = STATE.ROAMING;
                    focus[i] = 0;
                }
            } else if (anyPeople && people.nearest(x[i], y[i], P.wary) >= 0) {
                // Full, and people near: it keeps away from them.
                h = Math.atan2(-people.dy, -people.dx);
                v = top * P.cruise * 0.5;
                state[i] = STATE.SATED;
                focus[i] = 0;
            } else {
                // Full: amble around slowly.
                h = rival >= 0 ? Math.atan2(-rivals.dy, -rivals.dx) : h + (rng.next() - 0.5) * P.turn;
                v = top * P.cruise * 0.5;
                state[i] = STATE.SATED;
                focus[i] = 0;
            }

            if (v > 0) {
                const ux = Math.cos(h);
                const uy = Math.sin(h);
                let nx = x[i] + ux * v;
                let ny = y[i] + uy * v;
                if (nx < 0) nx += W; else if (nx >= W) nx -= W;
                if (ny < 0) ny += H; else if (ny >= H) ny -= H;
                if (terrain !== null && terrain.blocked(nx, ny)) {
                    // Water or a cliff ahead: veer along it (or turn back if boxed in).
                    if (terrain.move(x[i], y[i], ux, uy, v, terrain.side(ux, uy, heading[i], rng))) h = Math.atan2(terrain.uy, terrain.ux);
                    else h += Math.PI;
                    nx = terrain.x;
                    ny = terrain.y;
                }
                x[i] = nx;
                y[i] = ny;
            }
            heading[i] = h;

            e -= P.baseCost * upkeep[i] + P.moveCost * v * v;
            // What a full stomach cannot hold goes to fat (as much as it can
            // carry; the rest is wasted); hungry, it draws on it.
            if (e > P.maxEnergy) {
                f += e - P.maxEnergy;
                if (f > P.fatMax) f = P.fatMax;
                e = P.maxEnergy;
            } else if (e < drawAt && f > 0) {
                const d = drawAt - e < f ? drawAt - e : f;
                f -= d;
                e += d;
            }

            if (e <= 0) {
                this.die(pop, i, 'starvation');
                continue;
            }

            // A litter, in its season, when grown, well fed, and with room
            // for it: no more than `rivals` others within its territory, and
            // prey enough there (at least `prey` grazers) to raise it on.
            if (breed > 0 && age[i] >= P.maturity && e + f >= P.birthReserve && time - bred[i] >= P.birthGap
                && rivals.count(x[i], y[i], P.territory, i, null, 0, true, tooMany) <= P.rivals
                && grazers.count(x[i], y[i], P.territory, -1, null, 0, true, enough) >= P.prey
                && rng.next() < breed) {
                this.bear(pop, P, i, e, f);
                e = born.e;
                f = born.f;
            }
            energy[i] = e;
            fat[i] = f;
        }
    }

    // The nearest grazer a hunter at (px, py) who sees as far as r can make
    // out: in the open within r, in forest only within r × coverSight. Like
    // hash.nearest(), the offset to it is left in hash.dx, dy, d2.
    spot(hash, px, py, r) {
        const open = hash.nearest(px, py, r, -1, this.hidden, 0, true);
        const { dx, dy, d2 } = hash;
        let near = r * this.coverSight;
        if (open >= 0 && d2 < near * near) near = Math.sqrt(d2); // only a closer one would matter
        const hid = hash.nearest(px, py, near, -1, this.hidden, 1, true);
        if (hid >= 0) return hid;
        hash.dx = dx;
        hash.dy = dy;
        hash.d2 = d2;
        return open;
    }

    // Average genes of a population (for the UI and the checks).
    meanGenes(pop) {
        let s = 0;
        let v = 0;
        for (let i = 0; i < pop.n; i++) {
            s += pop.speedGene[i];
            v += pop.senseGene[i];
        }
        return pop.n ? { speed: s / pop.n, sense: v / pop.n } : { speed: 0, sense: 0 };
    }
}
