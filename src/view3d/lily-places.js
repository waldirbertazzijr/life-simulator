// Where the giant water lilies (vitória-régia, Victoria amazonica) float, and
// where the frogs that live among them sit. Pure placement, no three.js, so it
// can be tested in node: lilies.js draws what this decides, frogs.js brings
// the frogs to life.
//
// Scenery, like the trees: the same world (seed and terrain) always gets the
// same lilies, chosen by hashes of the seed, never by the simulation's random
// numbers or Math.random.
//
// How:
// - Lakes are the connected pieces of water on the terrain's grid of height
//   nodes (8 neighbours, wrapping). A lake's shore is the land nodes beside it.
// - Lilies are tropical: a lake with tundra, bare rock or snow on more than
//   COLD_SHARE of its shore gets none. The others are warm or temperate; each
//   one gets lilies with a chance that follows its shore (wetland most, then
//   meadow, forest, and dry steppe least), so not every lake has them. If the
//   dice leave a world without them on any real lake (only on ponds, or
//   nowhere), its best lake gets them anyway.
// - On a chosen lake, a few colonies (more on a long shore) sit in shallow
//   water near the shore, well apart. Pads are scattered around each colony's
//   centre, big ones and small ones, never overlapping (they float at one
//   height and would flicker into each other). Each pad lies wholly over water,
//   in the shallow band (its centre DEPTH[0]..DEPTH[1] deep), and no shore it
//   looks out at is cold. A flower now and then in a gap beside a pad: white,
//   some pink (old blooms turn pink).
// - Frogs live where the lilies are: on some of the bigger pads, and at spots
//   on the shore around each colony.
import { BIOME } from '../terrain.js';
import { hash, meshHeight, wrapDelta, wrap } from './util.js';

export const LILY = {
    DEPTH: [0.15, 2.2],     // a pad's centre floats over water this deep (the deepest lake is the sea level, 8)
    CENTRE: [0.4, 1.5],     // a colony's centre, a little further in
    UNDER: 0.05,            // the lake bed is at least this far under every point of a pad's rim
    PAD: [1.1, 3.4],        // a pad's radius, smallest to largest (a person is about 4.5 tall)
    COLONY: [8, 16],        // a colony's size...
    OVAL: [1.5, 0.7],       // ...times this along the shore, and across
    GAP: 70,                // between colonies' centres, at least
    REACH: [5, 24],         // a colony's centre is this far from the nearest land
    PER_SHORE: 22,          // a lake gets a colony per this many shore nodes (1 to MAX_COLONIES)
    MAX_COLONIES: 6,
    TRIES: 150,             // pads tried per colony
    COLD_SHARE: 0.15,       // a lake with more of its shore than this cold gets no lilies
    CHANCE: 0.7,            // the chance a lake with the best-suited shore has lilies
    LAKE: 40,               // shore nodes of a lake (not a pond)
    LOOK: 60,               // how far a pad looks out for the shore (the cold check)
    FLOWERS: 0.2,           // flowers per pad, about
    PINK: 0.3,              // share of the flowers that are pink
    FROG_PAD: 0.45,         // share of the bigger pads (radius ≥ 1.5) a frog calls home...
    FROG_SHORE: 0.5,        // ...and of the shore spots
};

// The cold biomes, and how much each warm one suits lilies.
const COLD = new Set([BIOME.TUNDRA, BIOME.ROCK, BIOME.SNOW]);
const SUITS = { [BIOME.WETLAND]: 1, [BIOME.MEADOW]: 0.85, [BIOME.FOREST]: 0.55, [BIOME.STEPPE]: 0.4 };
const RAYS = 16;
const SALT = 0x11e5a9d3;

// A small random stream from hashes alone (scenery, not the simulation's):
// numbers in [0, 1).
export function stream(seed) {
    let s = seed >>> 0;
    return () => {
        s = hash((s + 0x9e3779b9) >>> 0);
        return s / 4294967296;
    };
}

// The biome at (x, y), or one that never counts as cold without biomes.
const biomeOf = (T, x, y) => (T.biomes ? T.biome(wrap(x, T.W), wrap(y, T.H)) : BIOME.MEADOW);

// Is any shore that (x, y) looks out at, in RAYS directions up to LOOK
// away, cold? (Exported for the tests.)
export function coldShore(T, x, y, look = LILY.LOOK) {
    const sea = T.seaLevel;
    for (let k = 0; k < RAYS; k++) {
        const a = (k / RAYS) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        for (let d = 2; d <= look; d += 2) {
            const px = x + c * d;
            const py = y + s * d;
            if (T.heightAt(wrap(px, T.W), wrap(py, T.H)) >= sea) {
                if (COLD.has(biomeOf(T, px, py))) return true;
                break;
            }
        }
    }
    return false;
}

// The lakes: a label per height node (−1 on land) and, per lake, its nodes
// and its shore's make-up.
export function findLakes(T) {
    const { cols, rows, height: h, seaLevel: sea, cellW, cellH } = T;
    const n = cols * rows;
    const label = new Int32Array(n).fill(-1);
    const lakes = [];
    const queue = new Int32Array(n);
    const shoreMark = new Int32Array(n).fill(-1);
    for (let s = 0; s < n; s++) {
        if (h[s] >= sea || label[s] >= 0) continue;
        const id = lakes.length;
        let head = 0;
        let tail = 0;
        queue[tail++] = s;
        label[s] = id;
        let shore = 0;
        let cold = 0;
        let suits = 0;
        while (head < tail) {
            const c = queue[head++];
            const a = c % cols;
            const b = (c - a) / cols;
            for (let db = -1; db <= 1; db++) {
                const bb = (b + db + rows) % rows;
                for (let da = -1; da <= 1; da++) {
                    const m = ((a + da + cols) % cols) + bb * cols;
                    if (h[m] < sea) {
                        if (label[m] < 0) {
                            label[m] = id;
                            queue[tail++] = m;
                        }
                    } else if (shoreMark[m] !== id) {
                        shoreMark[m] = id;
                        const ma = m % cols;
                        const bio = biomeOf(T, ma * cellW, ((m - ma) / cols) * cellH);
                        shore++;
                        if (COLD.has(bio)) cold++;
                        else suits += SUITS[bio] ?? 0.5;
                    }
                }
            }
        }
        const coldShare = shore ? cold / shore : 0;
        lakes.push({ id, first: s, nodes: tail, shore, cold: coldShare > LILY.COLD_SHARE, coldShare, score: shore ? suits / shore : 0, chosen: false, colonies: 0 });
    }
    return { label, lakes };
}

// The lake a water point (x, y) belongs to: the label of a corner of its node
// cell that is under water (one is, if the point is).
function lakeAt(T, label, x, y) {
    const { cols, rows, cellW, cellH } = T;
    const i = Math.floor(wrap(x, T.W) / cellW) % cols;
    const j = Math.floor(wrap(y, T.H) / cellH) % rows;
    const i1 = (i + 1) % cols;
    const j1 = (j + 1) % rows;
    for (const k of [i + j * cols, i1 + j * cols, i + j1 * cols, i1 + j1 * cols]) if (label[k] >= 0) return label[k];
    return -1;
}

// The nearest land from (x, y) within `reach`, along RAYS directions:
// { d, a } (its distance and direction), or null.
function nearestLand(T, x, y, reach) {
    let best = null;
    for (let k = 0; k < RAYS; k++) {
        const a = (k / RAYS) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        for (let d = 1.5; d <= reach && (!best || d < best.d); d += 1.5) {
            if (T.heightAt(wrap(x + c * d, T.W), wrap(y + s * d, T.H)) >= T.seaLevel) {
                best = { d, a };
                break;
            }
        }
    }
    return best;
}

// Everything for one world: { pads, flowers, shore, homes, colonies, lakes }.
//   pads      [{ x, y, r, turn, colony }]   turn: 0..1 (a full turn), where the notch points
//   flowers   [{ x, y, size, turn, pink }]  pink: 0 white .. 1 pink
//   shore     [{ x, y, h }]                 frog spots on the shore (h: the ground's height)
//   homes     [{ pad, shore, x, y, h, seed }] where frogs live: on pad `pad`, or at shore spot `shore` (the other −1)
//   colonies  [{ x, y, r, along, lake }]    along: the direction of the shore beside it (radians)
//   lakes     findLakes()'s, with `chosen` and `colonies` filled in
export function placeLilies(T, seed) {
    const empty = { pads: [], flowers: [], shore: [], homes: [], colonies: [], lakes: [] };
    if (!T) return empty;
    const W = T.W;
    const H = T.H;
    const sea = T.seaLevel;
    const salt = hash((seed ^ SALT) >>> 0);
    const { label, lakes } = findLakes(T);
    const out = [0, 0];
    const depthAt = (x, y) => {
        meshHeight(T, wrap(x, W), wrap(y, H), out);
        return sea - out[0];
    };

    // Which lakes get lilies: about two in three of the best suited, fewer
    // where the shore is drier or cooler. A world whose dice chose no lake
    // of any size (only ponds, or none) gives its best lake lilies anyway.
    let best = null;
    for (const lake of lakes) {
        if (lake.cold) continue;
        const chance = LILY.CHANCE * Math.min(1, Math.max(0, (lake.score - 0.2) / 0.7));
        lake.chosen = hash(salt ^ Math.imul(lake.first + 1, 0x2545f491)) / 4294967296 < chance;
        if (!best || lake.score * Math.sqrt(lake.shore) > best.score * Math.sqrt(best.shore)) best = lake;
    }
    if (best && !lakes.some((l) => l.chosen && l.shore >= LILY.LAKE)) best.chosen = true;

    // Candidate colony centres: shallow water near land, on chosen lakes, in
    // an order shuffled by the seed.
    const STEP = 6;
    const candidates = [];
    for (let y = STEP / 2; y < H; y += STEP) {
        for (let x = STEP / 2; x < W; x += STEP) {
            const d = sea - T.heightAt(x, y);
            if (d < LILY.CENTRE[0] || d > LILY.CENTRE[1]) continue;
            const lake = lakeAt(T, label, x, y);
            if (lake < 0 || !lakes[lake].chosen) continue;
            candidates.push({ x, y, lake, order: hash(salt ^ Math.imul(candidates.length + 7, 0x9e3779b1)) });
        }
    }
    candidates.sort((a, b) => a.order - b.order);

    const colonies = [];
    for (const c of candidates) {
        const lake = lakes[c.lake];
        const budget = Math.max(1, Math.min(LILY.MAX_COLONIES, Math.round((lake.shore / LILY.PER_SHORE) * (0.5 + 0.5 * lake.score))));
        if (lake.colonies >= budget) continue;
        if (colonies.some((o) => Math.hypot(wrapDelta(o.x - c.x, W), wrapDelta(o.y - c.y, H)) < LILY.GAP)) continue;
        const land = nearestLand(T, c.x, c.y, LILY.REACH[1]);
        if (!land || land.d < LILY.REACH[0]) continue;
        if (coldShore(T, c.x, c.y)) continue;
        const rnd = stream(c.order);
        colonies.push({
            x: c.x, y: c.y, r: LILY.COLONY[0] + (LILY.COLONY[1] - LILY.COLONY[0]) * rnd(),
            along: land.a + Math.PI / 2, lake: c.lake, order: c.order,
        });
        lake.colonies++;
    }

    // The pads and flowers of each colony.
    const pads = [];
    const flowers = [];
    const shore = [];
    for (let ci = 0; ci < colonies.length; ci++) {
        const col = colonies[ci];
        const rnd = stream(col.order ^ 0x5bd1e995);
        const mine = [];
        // A colony is an oval lying along the shore, denser in the middle.
        const ca = Math.cos(col.along);
        const sa = Math.sin(col.along);
        for (let t = 0; t < LILY.TRIES; t++) {
            const a = rnd() * Math.PI * 2;
            const rho = rnd() ** 0.65;
            const u = Math.cos(a) * rho * col.r * LILY.OVAL[0];
            const v = Math.sin(a) * rho * col.r * LILY.OVAL[1];
            const x = wrap(col.x + ca * u - sa * v, W);
            const y = wrap(col.y + sa * u + ca * v, H);
            // Mostly middling pads, a few giants; smaller toward the colony's edge.
            let r = LILY.PAD[0] + (LILY.PAD[1] - LILY.PAD[0]) * rnd() ** 1.8;
            r *= 1 - 0.3 * rho;
            if (r < LILY.PAD[0]) r = LILY.PAD[0];
            const d = depthAt(x, y);
            if (d < LILY.DEPTH[0] || d > LILY.DEPTH[1]) continue;
            if (mine.some((p) => Math.hypot(wrapDelta(p.x - x, W), wrapDelta(p.y - y, H)) < p.r + r + 0.12)) continue;
            // The bed is under every part of its rim, as drawn (the mesh's
            // triangles) and as the world has it (bilinear).
            let under = true;
            for (let k = 0; k < 24 && under; k++) {
                const b = (k / 24) * Math.PI * 2;
                const px = wrap(x + Math.cos(b) * r * 1.06, W);
                const py = wrap(y + Math.sin(b) * r * 1.06, H);
                under = depthAt(px, py) >= LILY.UNDER && sea - T.heightAt(px, py) >= LILY.UNDER;
            }
            if (!under || coldShore(T, x, y)) continue;
            const pad = { x, y, r, turn: rnd(), colony: ci };
            mine.push(pad);
            pads.push(pad);
        }

        // Flowers in the gaps beside the pads.
        const want = Math.round(mine.length * LILY.FLOWERS + rnd());
        const blooms = [];
        for (let t = 0; t < want * 6 && blooms.length < want && mine.length; t++) {
            const p = mine[Math.floor(rnd() * mine.length)];
            const a = rnd() * Math.PI * 2;
            const size = 0.95 + 0.3 * rnd();
            const gap = p.r + 0.45 * size + 0.3 * rnd();
            const x = wrap(p.x + Math.cos(a) * gap, W);
            const y = wrap(p.y + Math.sin(a) * gap, H);
            if (depthAt(x, y) < 0.1) continue;
            if (mine.some((q) => Math.hypot(wrapDelta(q.x - x, W), wrapDelta(q.y - y, H)) < q.r + 0.4 * size)) continue;
            if (blooms.some((q) => Math.hypot(wrapDelta(q.x - x, W), wrapDelta(q.y - y, H)) < 1.8)) continue;
            const pink = rnd() < LILY.PINK ? 0.7 + 0.3 * rnd() : 0.08 * rnd();
            const f = { x, y, size, turn: rnd(), pink };
            blooms.push(f);
            flowers.push(f);
        }

        // Spots on the shore around the colony: along rays from its centre,
        // just past the water's edge, on gentle ground.
        const reach = col.r * LILY.OVAL[0] + 10;
        for (let k = 0; k < 28; k++) {
            const a = (k / 28) * Math.PI * 2 + rnd() * 0.15;
            const c = Math.cos(a);
            const s = Math.sin(a);
            for (let d = 1; d <= reach; d += 0.5) {
                if (depthAt(col.x + c * d, col.y + s * d) > 0) continue;
                const x = wrap(col.x + c * (d + 0.4), W);
                const y = wrap(col.y + s * (d + 0.4), H);
                meshHeight(T, x, y, out);
                const up = out[0] - sea;
                if (up > 0.02 && up < 1 && out[1] < 0.6 && !shore.some((q) => Math.hypot(wrapDelta(q.x - x, W), wrapDelta(q.y - y, H)) < 2.5)) {
                    shore.push({ x, y, h: out[0] });
                }
                break;
            }
        }
    }

    // Where frogs live, each with a seed of its own.
    const homes = [];
    for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        const h = hash(salt ^ Math.imul(i + 1, 0x27d4eb2f));
        if (p.r >= 1.5 && h / 4294967296 < LILY.FROG_PAD) homes.push({ pad: i, shore: -1, x: p.x, y: p.y, h: sea, seed: hash(h) });
    }
    for (let i = 0; i < shore.length; i++) {
        const s = shore[i];
        const h = hash(salt ^ Math.imul(i + 1, 0x165667b1));
        if (h / 4294967296 < LILY.FROG_SHORE) homes.push({ pad: -1, shore: i, x: s.x, y: s.y, h: s.h, seed: hash(h) });
    }

    for (const c of colonies) delete c.order;
    return { pads, flowers, shore, homes, colonies, lakes };
}
