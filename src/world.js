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
import { createRng } from './rng.js';
import { Population, STATE } from './population.js';
import { SpatialHash } from './spatial.js';
import { Grass } from './grass.js';
import { Terrain, BIOME } from './terrain.js';
import { seedTribes, stepHumans, stepTribes, driveOff } from './humans.js';
import { caught, afterStep } from './player.js';
import { Spears, stepSpears, spoilCarcasses } from './spears.js';
import { fighting } from './orders.js';
import { initItems, stepItems, bequeath, shielded, creditHolder, TASK } from './items.js';

export { STATE, STATE_LABEL } from './population.js';

const TAU = Math.PI * 2;
const LOOK_ANGLE = 0.8; // a grazer peeks this far (radians) to either side
const LOOK_COS = Math.cos(LOOK_ANGLE);
const LOOK_SIN = Math.sin(LOOK_ANGLE);

// Size a world with the configured AREA and the given aspect ratio (w / h).
export function worldSize(area, aspect) {
    return {
        width: Math.round(Math.sqrt(area * aspect)),
        height: Math.round(Math.sqrt(area / aspect)),
    };
}

export class World {
    constructor(params, { seed = 1, aspect = 1.6 } = {}) {
        this.p = params;
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
        // The player's spears in flight, and its kills waiting to be butchered
        // (src/spears.js): empty unless someone is played. With items, every
        // hunter's kills wait to be butchered too.
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
        this.carnivoreHash = new SpatialHash(width, height, params.world.hashCell);
        this.humanHash = new SpatialHash(width, height, params.world.hashCell);
        this.tribes = [];          // living tribes
        this.tribeById = new Map();
        this.fallen = [];          // the most recent tribes to die out
        this.nextTribeId = 1;

        this.seedPopulation(this.herbivores, params.herbivore);
        this.seedPopulation(this.carnivores, params.carnivore);
        if (params.human.enabled) seedTribes(this);
    }

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
            this.spawn(pop, sp, x, y,
                sp.birthEnergy * (0.4 + 0.5 * rng.next()),
                sp.genes.speed * Math.exp(spread * rng.gauss()),
                sp.genes.sense * Math.exp(spread * rng.gauss()),
                rng.next() * sp.lifespan * 0.6);
        }
    }

    spawn(pop, sp, x, y, energy, speedGene, senseGene, age = 0, parent = -1) {
        const { rng } = this;
        const i = pop.add();
        pop.x[i] = x;
        pop.y[i] = y;
        pop.heading[i] = rng.next() * TAU;
        pop.energy[i] = energy;
        pop.age[i] = age;
        pop.lifespan[i] = sp.lifespan * (1 + this.p.lifespanJitter * (2 * rng.next() - 1));
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
        return i;
    }

    // Mark individual i as dead. If it is the one being followed, keep a note
    // of how its story ended. (The event also says, for drawing, a person's
    // tribe and whether a child died.)
    die(pop, i, cause, by = 0) {
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
        this.carnivoreHash.build(this.carnivores);
        this.humanHash.build(this.humans);
        this.stepHerbivores();
        this.herbivoreHash.build(this.herbivores);
        if (this.hidden !== null) this.markCover();
        this.stepCarnivores();
        if (this.humans.n) stepHumans(this);
        if (this.spears.n) stepSpears(this);            // the player's, in flight (spears.js)
        if (this.carcasses.size) spoilCarcasses(this);  // the player's kills, left too long
        this.grass.regrow(this.p.grass.regrowth);
        this.herbivores.compact();
        this.carnivores.compact();
        this.humans.compact();
        if (this.tribes.length) stepTribes(this);
        if (this.itemsOn) stepItems(this);               // torches burn out, lost items go, tribes reckon their needs
        if (this.player !== null) afterStep(this); // if the controlled person died: its heir (player.js)
        this.time++;
    }

    stepHerbivores() {
        const P = this.p.herbivore;
        const pop = this.herbivores;
        const n = pop.n;
        pop.reserve(n); // at most one birth each
        const { x, y, heading, energy, age, lifespan, speedGene, senseGene, upkeep, state, focus } = pop;
        const { rng, width: W, height: H, carnivoreHash: threats, humanHash: hunters, grass, terrain } = this;
        const g = grass.g;
        const predatorIds = this.carnivores.id;
        const hunterIds = this.humans.id;
        const anyHunters = this.humans.n > 0;
        // A crouching player (player.js) is noticed only from closer: its id
        // (0: nobody crouches), and that fraction of a grazer's range.
        const creeper = this.player !== null && this.player.crouch ? this.player.id : 0;
        const creep = creeper ? this.p.play.crouchSense : 0;

        for (let i = 0; i < n; i++) {
            if (++age[i] > lifespan[i]) {
                this.die(pop, i, 'old age');
                continue;
            }
            const sg = speedGene[i];
            const vg = senseGene[i];
            const top = P.speed * sg;
            let h = heading[i];
            let v = 0;
            let dx = 0;
            let dy = 0;
            state[i] = STATE.GRAZING;
            focus[i] = 0;

            // The closest danger: a carnivore, or a human hunter.
            let threat = threats.nearest(x[i], y[i], P.sense * vg);
            let tdx = threats.dx;
            let tdy = threats.dy;
            let threatId = threat >= 0 ? predatorIds[threat] : 0;
            if (anyHunters) {
                const k = hunters.nearest(x[i], y[i], P.sense * vg);
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
            if (threat >= 0) {
                // Run straight away from the closest danger.
                const d = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
                dx = -tdx / d;
                dy = -tdy / d;
                h = Math.atan2(dy, dx);
                v = top;
                state[i] = STATE.FLEEING;
                focus[i] = threatId;
            } else if (g[grass.index(x[i], y[i])] < P.bite) {
                state[i] = STATE.SEARCHING;
                // Patch grazed out: peek straight ahead and 0.8 rad to either
                // side, and head for the greenest. If none is better than here,
                // wander off in a new direction.
                const look = P.sense * vg;
                const ch = Math.cos(h);
                const sh = Math.sin(h);
                let best = g[grass.index(x[i], y[i])];
                let turn = 2; // none found yet
                for (let k = -1; k <= 1; k++) {
                    // (cos, sin) of h + k·LOOK_ANGLE, by rotating (ch, sh).
                    const ux = k === 0 ? ch : ch * LOOK_COS - k * sh * LOOK_SIN;
                    const uy = k === 0 ? sh : sh * LOOK_COS + k * ch * LOOK_SIN;
                    let lx = x[i] + ux * look;
                    let ly = y[i] + uy * look;
                    if (lx < 0) lx += W; else if (lx >= W) lx -= W;
                    if (ly < 0) ly += H; else if (ly >= H) ly -= H;
                    const gv = g[grass.index(lx, ly)];
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
            }

            let e = energy[i] - P.baseCost * upkeep[i] - P.moveCost * v * v;

            const gi = grass.index(x[i], y[i]);
            if (e < P.maxEnergy) {
                let bite = g[gi];
                if (bite > P.bite) bite = P.bite;
                const room = (P.maxEnergy - e) / P.grassEnergy;
                if (bite > room) bite = room;
                g[gi] -= bite;
                e += bite * P.grassEnergy;
            }

            if (e <= 0) {
                this.die(pop, i, 'starvation');
                continue;
            }

            if (e >= P.birthEnergy && age[i] >= P.maturity) {
                const child = e * P.childShare;
                e -= child;
                this.spawn(pop, P, x[i], y[i], child, this.mutate(sg), this.mutate(vg), 0, i);
            }
            energy[i] = e;
        }
    }

    stepCarnivores() {
        const P = this.p.carnivore;
        const pop = this.carnivores;
        const n = pop.n;
        pop.reserve(n);
        const { x, y, heading, energy, age, lifespan, speedGene, senseGene, upkeep, timer, state, focus, kills, id } = pop;
        const { rng, width: W, height: H, herbivoreHash: grazers, humanHash: people, carnivoreHash: rivals, terrain } = this;
        const { herbivores, humans } = this;
        const anyPeople = humans.n > 0;
        const hungry = P.hunger * P.maxEnergy;
        const cover = this.hidden !== null;

        for (let i = 0; i < n; i++) {
            if (++age[i] > lifespan[i]) {
                this.die(pop, i, 'old age');
                continue;
            }
            const sg = speedGene[i];
            const vg = senseGene[i];
            const top = P.speed * sg;
            let e = energy[i];
            let h = heading[i];
            let v = 0;

            // Interference: a rival too close means stand-offs and lost
            // meals. It costs energy, and an idle predator moves off.
            const rival = rivals.nearest(x[i], y[i], P.crowdRadius, i);
            if (rival >= 0) e -= P.crowdCost;

            if (timer[i] > 0) {
                timer[i]--; // eating, digesting or catching its breath (state unchanged)
            } else if (e < hungry) {
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
                            e += victims.energy[j] * P.efficiency;
                            this.die(victims, j, 'eaten', id[i]);
                            kills[i]++;
                            timer[i] = P.handling;
                            state[i] = STATE.EATING;
                        }
                    } else if (rng.next() < 1 / P.stamina) {
                        timer[i] = P.rest; // give up, out of breath
                        state[i] = STATE.RESTING;
                        focus[i] = 0;
                    }
                } else {
                    h = rival >= 0 ? Math.atan2(-rivals.dy, -rivals.dx) : h + (rng.next() - 0.5) * P.turn;
                    v = top * P.cruise;
                    state[i] = STATE.ROAMING;
                    focus[i] = 0;
                }
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
            if (e > P.maxEnergy) e = P.maxEnergy; // a full stomach wastes the rest

            if (e <= 0) {
                this.die(pop, i, 'starvation');
                continue;
            }

            if (e >= P.birthEnergy && age[i] >= P.maturity) {
                const child = e * P.childShare;
                e -= child;
                this.spawn(pop, P, x[i], y[i], child, this.mutate(sg), this.mutate(vg), 0, i);
            }
            energy[i] = e;
        }
    }

    // Forest cover: note which grazers stand in forest this step.
    markCover() {
        const pop = this.herbivores;
        if (this.hidden.length < pop.capacity) this.hidden = new Uint8Array(pop.capacity);
        const { hidden, grass } = this;
        const biomeOf = this.terrain.biomeGrid;
        const { x, y } = pop;
        for (let i = 0; i < pop.n; i++) hidden[i] = biomeOf[grass.index(x[i], y[i])] === BIOME.FOREST ? 1 : 0;
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
