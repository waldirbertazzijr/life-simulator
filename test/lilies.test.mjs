// Giant water lilies (src/view3d/lily-places.js): where the pads, flowers
// and frogs' homes go. Pure placement, no three.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params as defaults } from '../src/config.js';
import { World } from '../src/world.js';
import { BIOME } from '../src/terrain.js';
import { placeLilies, LILY } from '../src/view3d/lily-places.js';
import { meshHeight, wrap, wrapDelta } from '../src/view3d/util.js';

const COLD = new Set([BIOME.TUNDRA, BIOME.ROCK, BIOME.SNOW]);

// A world with few animals (placement only needs its land), with `change`
// applied to the parameters.
function world(seed, change = (p) => p) {
    const p = structuredClone(defaults);
    p.herbivore.initial = 20;
    p.carnivore.initial = 4;
    p.human.enabled = false;
    change(p);
    return new World(p, { seed, aspect: 1.6 });
}

// A colder climate: the cool regions' lowlands turn to tundra, so some lakes
// lie in tundra (and rock, and snow).
const cold = (p) => Object.assign(p.biomes, { climateSpread: 0.9, snowBelow: 0.2, rockBelow: 0.3, tundraBelow: 0.45 });

const mesh = (T, x, y) => {
    const out = [0, 0];
    meshHeight(T, wrap(x, T.W), wrap(y, T.H), out);
    return out[0];
};
const dist = (T, a, b) => Math.hypot(wrapDelta(a.x - b.x, T.W), wrapDelta(a.y - b.y, T.H));

// The lakes, worked out here on their own: a label per height node (−1 on
// land), and per lake the share of its shore nodes that are cold.
function lakesOf(T) {
    const { cols, rows, height: h, seaLevel: sea } = T;
    const label = new Int32Array(cols * rows).fill(-1);
    const coldShare = [];
    for (let s = 0; s < cols * rows; s++) {
        if (h[s] >= sea || label[s] >= 0) continue;
        const id = coldShare.length;
        const stack = [s];
        label[s] = id;
        const shore = new Set();
        while (stack.length) {
            const c = stack.pop();
            const a = c % cols;
            const b = (c - a) / cols;
            for (let db = -1; db <= 1; db++) {
                for (let da = -1; da <= 1; da++) {
                    const m = ((a + da + cols) % cols) + ((b + db + rows) % rows) * cols;
                    if (h[m] >= sea) shore.add(m);
                    else if (label[m] < 0) {
                        label[m] = id;
                        stack.push(m);
                    }
                }
            }
        }
        let n = 0;
        for (const m of shore) {
            const i = m % cols;
            if (COLD.has(T.biome(i * T.cellW, ((m - i) / cols) * T.cellH))) n++;
        }
        coldShare.push(shore.size ? n / shore.size : 0);
    }
    return { label, coldShare };
}

// The lake a water point lies in: the label of a corner of its node cell.
function lakeOf(T, label, x, y) {
    const i = Math.floor(wrap(x, T.W) / T.cellW) % T.cols;
    const j = Math.floor(wrap(y, T.H) / T.cellH) % T.rows;
    for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const k = ((i + di) % T.cols) + ((j + dj) % T.rows) * T.cols;
        if (label[k] >= 0) return label[k];
    }
    return -1;
}

// The first land along each of `rays` directions from (x, y), within `look`.
function shoresSeen(T, x, y, look, rays = 24) {
    const seen = [];
    for (let k = 0; k < rays; k++) {
        const a = (k / rays) * Math.PI * 2;
        for (let d = 1; d <= look; d += 1) {
            const px = wrap(x + Math.cos(a) * d, T.W);
            const py = wrap(y + Math.sin(a) * d, T.H);
            if (T.heightAt(px, py) >= T.seaLevel) {
                seen.push({ d, biome: T.biome(px, py) });
                break;
            }
        }
    }
    return seen;
}

test('pads float wholly on water, in the shallow band near the shore, never overlapping', () => {
    for (const seed of [1, 2, 3, 7]) {
        const T = world(seed).terrain;
        const sea = T.seaLevel;
        const { pads } = placeLilies(T, seed);
        assert.ok(pads.length > 50, `seed ${seed}: only ${pads.length} pads`);
        for (const p of pads) {
            const depth = sea - mesh(T, p.x, p.y);
            assert.ok(depth >= LILY.DEPTH[0] && depth <= LILY.DEPTH[1], `seed ${seed}: pad at (${p.x}, ${p.y}) over water ${depth} deep`);
            assert.ok(T.isWater(p.x, p.y));
            assert.ok(p.r >= LILY.PAD[0] && p.r <= LILY.PAD[1]);
            for (let k = 0; k < 16; k++) {
                const a = (k / 16) * Math.PI * 2;
                const x = p.x + Math.cos(a) * p.r;
                const y = p.y + Math.sin(a) * p.r;
                assert.ok(mesh(T, x, y) < sea && T.heightAt(wrap(x, T.W), wrap(y, T.H)) < sea, `seed ${seed}: a pad's rim reaches land`);
            }
            // Not out in open water: land is near.
            const near = Math.min(...shoresSeen(T, p.x, p.y, 80).map((s) => s.d));
            assert.ok(near < 50, `seed ${seed}: a pad ${near} from the shore`);
        }
        // No two pads overlap.
        for (let i = 0; i < pads.length; i++) {
            for (let j = i + 1; j < pads.length; j++) {
                assert.ok(dist(T, pads[i], pads[j]) >= pads[i].r + pads[j].r, `seed ${seed}: pads ${i} and ${j} overlap`);
            }
        }
    }
});

test('flowers float on open water beside the pads; frogs live on pads and on the shore', () => {
    for (const seed of [1, 7]) {
        const T = world(seed).terrain;
        const P = placeLilies(T, seed);
        assert.ok(P.flowers.length > 10);
        assert.ok(P.flowers.some((f) => f.pink > 0.5) && P.flowers.some((f) => f.pink < 0.5), 'white flowers and pink ones');
        for (const f of P.flowers) {
            assert.ok(mesh(T, f.x, f.y) < T.seaLevel);
            for (const p of P.pads) assert.ok(dist(T, f, p) >= p.r, 'a flower on a pad');
            assert.ok(P.pads.some((p) => dist(T, f, p) < p.r + 2), 'a flower far from any pad');
        }
        assert.ok(P.homes.some((h) => h.pad >= 0) && P.homes.some((h) => h.shore >= 0));
        for (const h of P.homes) {
            if (h.pad >= 0) {
                assert.equal(h.x, P.pads[h.pad].x);
                assert.ok(P.pads[h.pad].r >= 1.5);
            } else {
                // On land, at the water's edge.
                const s = P.shore[h.shore];
                assert.ok(mesh(T, s.x, s.y) >= T.seaLevel, 'a shore spot under water');
                let wet = false;
                for (let k = 0; k < 16 && !wet; k++) {
                    const a = (k / 16) * Math.PI * 2;
                    wet = mesh(T, s.x + Math.cos(a) * 1.5, s.y + Math.sin(a) * 1.5) < T.seaLevel;
                }
                assert.ok(wet, 'a shore spot away from the water');
            }
        }
    }
});

test('no lilies on lakes in tundra or snow, and none looking out on cold shores', () => {
    let coldLakes = 0;
    let pads = 0;
    for (const seed of [3, 5, 7, 10]) {
        const T = world(seed, cold).terrain;
        const P = placeLilies(T, seed);
        const { label, coldShare } = lakesOf(T);
        coldLakes += coldShare.filter((s) => s >= 0.5).length;
        pads += P.pads.length;
        for (const p of P.pads) {
            const lake = lakeOf(T, label, p.x, p.y);
            assert.ok(lake >= 0);
            assert.ok(coldShare[lake] <= LILY.COLD_SHARE, `seed ${seed}: a pad on a lake whose shore is ${Math.round(coldShare[lake] * 100)}% cold`);
            for (const s of shoresSeen(T, p.x, p.y, LILY.LOOK - 4)) {
                assert.ok(!COLD.has(s.biome), `seed ${seed}: a pad at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) looks out on cold land ${s.d} away`);
            }
        }
    }
    assert.ok(coldLakes >= 4, `the cold worlds have only ${coldLakes} cold lakes`);
    assert.ok(pads > 100, `the cold worlds' warm lakes have only ${pads} pads`);
});

test('not every lake has lilies, but every world has some', () => {
    let bare = 0;
    for (let seed = 1; seed <= 8; seed++) {
        const P = placeLilies(world(seed).terrain, seed);
        assert.ok(P.pads.length > 0, `seed ${seed}: no lilies`);
        bare += P.lakes.filter((l) => !l.cold && l.shore >= LILY.LAKE && !l.colonies).length;
    }
    assert.ok(bare > 0, 'every sizeable lake got lilies');
});

test('the same world always gets the same lilies; another seed others', () => {
    const a = world(7);
    const b = world(7);
    const A = placeLilies(a.terrain, 7);
    assert.deepEqual(placeLilies(b.terrain, 7), A);
    assert.deepEqual(placeLilies(a.terrain, 7), A);
    const other = placeLilies(a.terrain, 8); // the same land, another seed
    assert.notDeepEqual(other.pads, A.pads);
});

test('no terrain, no lilies', () => {
    const P = placeLilies(null, 1);
    assert.deepEqual(P.pads, []);
    assert.deepEqual(P.homes, []);
    const flat = world(1, (p) => { p.terrain.enabled = false; });
    assert.deepEqual(placeLilies(flat.terrain, 1).pads, []);
});
