// Imported models (src/view3d/glb.js, models.js): the baked sheep and wolf
// from assets/models/, read here with node's fs as the page reads them, and
// small made-up models for the sorting a model without bones gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';

// The view's modules import 'three', which the page maps to the vendored
// copy (an import map in index.html); here a loader hook does the same.
const THREE_URL = new URL('../vendor/three/three.module.min.js', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(
    `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(THREE_URL)}, shortCircuit: true } : next(s, c); }`,
)}`);

const { readGlb, GlbError } = await import('../src/view3d/glb.js');
const { MODELS, toShape, lite, basis } = await import('../src/view3d/models.js');
const { PART } = await import('../src/view3d/animate.js');
const { FRAME } = await import('../src/view3d/keyframes.js');

const LEGS = [PART.LEG_FL, PART.LEG_FR, PART.LEG_BL, PART.LEG_BR];
const ALL = [PART.TORSO, PART.HEAD, ...LEGS];
const file = (kind) => new URL(MODELS[kind].url.replace('../../', '../'), import.meta.url);
const glbOf = (kind) => readGlb(fs.readFileSync(file(kind)));
const shapes = { herbivore: toShape(glbOf('herbivore'), MODELS.herbivore, 'herbivore'), carnivore: toShape(glbOf('carnivore'), MODELS.carnivore, 'carnivore') };

// Per part: its joint, its vertices' extent and their mean, from a geometry.
function partsOf(g) {
    const pos = g.attributes.position;
    const rig = g.attributes.rig;
    const parts = new Map();
    for (let v = 0; v < pos.count; v++) {
        const p = rig.getW(v);
        if (!parts.has(p)) parts.set(p, { joint: [rig.getX(v), rig.getY(v), rig.getZ(v)], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], sum: [0, 0, 0], n: 0 });
        const e = parts.get(p);
        [pos.getX(v), pos.getY(v), pos.getZ(v)].forEach((c, k) => {
            e.min[k] = Math.min(e.min[k], c);
            e.max[k] = Math.max(e.max[k], c);
            e.sum[k] += c;
        });
        e.n++;
    }
    for (const e of parts.values()) e.mean = e.sum.map((s) => s / e.n);
    return parts;
}
const sorted = (m) => [...m.keys()].sort((a, b) => a - b);
function box(g) {
    g.computeBoundingBox();
    return g.boundingBox;
}

// Four legs on their corners, each on the ground.
function cornersOk(shape) {
    const parts = partsOf(shape.geometry);
    const x0 = shape.torso[0];
    for (const [leg, fx, sz] of [[PART.LEG_FL, 1, -1], [PART.LEG_FR, 1, 1], [PART.LEG_BL, -1, -1], [PART.LEG_BR, -1, 1]]) {
        const { joint, mean, min } = parts.get(leg);
        assert.deepEqual([Math.sign(joint[0] - x0), Math.sign(joint[2])], [fx, sz], `leg ${leg} joint`);
        assert.deepEqual([Math.sign(mean[0] - x0), Math.sign(mean[2])], [fx, sz], `leg ${leg} vertices`);
        assert.ok(min[1] < 0.1, `leg ${leg} reaches the ground`);
    }
}

// ---- The baked sheep and wolf ----

for (const [kind, name] of [['herbivore', 'sheep'], ['carnivore', 'wolf']]) {
    test(`the ${name}: a small baked file, flat colours, a part for every vertex`, () => {
        assert.ok(fs.statSync(file(kind)).size < 150 * 1024, 'under 150 KB');
        const m = glbOf(kind);
        const life = m.asset.extras.lifeSim;
        assert.deepEqual([life.up, life.forward, life.srgb, life.plan], ['+y', '+x', false, 'quadruped']);
        assert.deepEqual(Object.keys(life.joints).sort(), ['head', 'leg_bl', 'leg_br', 'leg_fl', 'leg_fr']);
        for (const p of m.primitives) {
            assert.ok(p.part && p.part.length === p.position.length / 3, 'a part per vertex');
            assert.equal(p.indices, null, 'every triangle its own vertices');
            for (let t = 0; t < p.color.length; t += 12) {
                assert.deepEqual(Array.from(p.color.slice(t, t + 4)), Array.from(p.color.slice(t + 4, t + 8)), 'one colour per face');
            }
        }
        const s = shapes[kind];
        assert.equal(s.info.split, 'baked');
        assert.ok(s.info.triangles > 1000 && s.info.triangles <= 1500, `${s.info.triangles} triangles`);
        const g = s.geometry;
        assert.equal(g.index, null);
        assert.equal(g.attributes.rig.count, g.attributes.position.count);
        assert.deepEqual(sorted(partsOf(g)), ALL);
        // No black faces from a texture sampled off its picture (the wolf's
        // claws are black: a few).
        const c = g.attributes.color;
        let black = 0;
        for (let v = 0; v < c.count; v++) if (c.getX(v) + c.getY(v) + c.getZ(v) < 0.003) black++;
        assert.ok(black < 0.06 * c.count, `${black} of ${c.count} vertices black`);
    });

    test(`the ${name} stands in our axes: feet at 0, facing +X, at its length`, () => {
        const s = shapes[kind];
        const b = box(s.geometry);
        assert.ok(Math.abs(b.min.y) < 1e-6, `feet at ${b.min.y}`);
        assert.ok(Math.abs(b.max.x - b.min.x - MODELS[kind].length) < 1e-4, `length ${b.max.x - b.min.x}`);
        assert.ok(Math.abs(b.max.x + b.min.x) < 1e-4 && Math.abs(b.max.z + b.min.z) < 1e-4, 'centred');
        const parts = partsOf(s.geometry);
        assert.ok(parts.get(PART.HEAD).mean[0] > parts.get(PART.TORSO).mean[0] + 1, 'the head is in front');
        assert.ok(parts.get(PART.HEAD).max[0] > b.max.x - 0.05, 'the nose is the front');
        assert.ok(b.max.y > 2 && b.max.y < 4, `height ${b.max.y}`);
    });

    test(`the ${name}'s legs turn at its bones' hips and shoulders`, () => {
        const s = shapes[kind];
        cornersOk(s);
        const parts = partsOf(s.geometry);
        let sum = 0;
        for (const leg of LEGS) {
            const { joint, max } = parts.get(leg);
            assert.ok(joint[1] > 0.8 && joint[1] < 3, `hip at ${joint[1]}`);
            assert.ok(max[1] > joint[1] - 0.3, 'the leg reaches up to its hip');
            sum += joint[1];
        }
        assert.ok(Math.abs(s.hip - sum / 4) < 1e-6, 'the gait takes the hips\' height');
        // The neck turns the head (at the neck's root), behind the head's middle.
        const neck = s.joints[PART.HEAD];
        assert.ok(neck[0] < parts.get(PART.HEAD).mean[0], 'the neck is behind the head');
        // The fall pivots at the ground, on its own side.
        assert.ok(Math.abs(s.body[1] * FRAME[kind].center - s.root[1]) < 1e-6);
        assert.ok(s.body[2] * FRAME[kind].half <= box(s.geometry).max.z + 1e-6);
    });
}

test('the wolf\'s tail goes with its torso', () => {
    const parts = partsOf(shapes.carnivore.geometry);
    const b = box(shapes.carnivore.geometry);
    assert.ok(parts.get(PART.TORSO).min[0] < b.min.x + 0.05, 'the tail tip is torso');
});

test('the far level: a fraction of the triangles, the same parts and joints, the colours kept', async () => {
    for (const kind of ['herbivore', 'carnivore']) {
        const shape = toShape(glbOf(kind), MODELS[kind], kind);
        const far = await lite(shape, 0.2);
        const triangles = far.attributes.position.count / 3;
        assert.ok(triangles < shape.info.triangles / 3 && triangles > 100, `${kind}: ${triangles} triangles`);
        const near = partsOf(shape.geometry);
        const parts = partsOf(far);
        assert.deepEqual(sorted(parts), sorted(near));
        for (const [p, e] of parts) assert.deepEqual(e.joint, near.get(p).joint, `part ${p}`);
        // Its mean colour stays near the model's.
        const mean = (g) => {
            const c = g.attributes.color;
            let s = 0;
            for (let v = 0; v < c.count; v++) s += c.getX(v) + c.getY(v) + c.getZ(v);
            return s / c.count;
        };
        assert.ok(Math.abs(mean(far) / mean(shape.geometry) - 1) < 0.25, `${kind}: colours kept`);
    }
});

// ---- Models without bones: sorted by where their pieces are ----

// A made-up quadruped in pieces (boxes), +Y up and facing +X: a body, a head
// with two horns over the neck, four legs, a tuft under the belly and a tail.
function boxPrimitive(node, [x0, y0, z0], [x1, y1, z1], rgb = [1, 1, 1]) {
    const position = new Float32Array([
        x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
    ]);
    const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
    const color = new Float32Array(32);
    for (let v = 0; v < 8; v++) color.set([...rgb, 1], v * 4);
    return { node, mesh: node, position, normal: null, color, uv: null, part: null, indices, material: { name: '', color: [1, 1, 1, 1], texture: null } };
}
function madeUp() {
    const legs = [[0.7, -0.25], [0.7, 0.25], [-0.7, -0.25], [-0.7, 0.25]].map(([x, z], i) => boxPrimitive(`leg${i}`, [x - 0.08, 0, z - 0.08], [x + 0.08, 0.85, z + 0.08]));
    return {
        asset: {}, skipped: [], primitives: [
            boxPrimitive('body', [-1, 0.8, -0.4], [1, 1.6, 0.4]),
            boxPrimitive('head', [1.05, 1.35, -0.15], [1.6, 1.75, 0.15]),
            boxPrimitive('hornL', [0.75, 1.65, -0.2], [1.0, 1.85, -0.1]),
            boxPrimitive('hornR', [0.75, 1.65, 0.1], [1.0, 1.85, 0.2]),
            ...legs,
            boxPrimitive('tuft', [-0.1, 0.65, -0.08], [0.1, 0.85, 0.08]),
            boxPrimitive('tail', [-1.25, 1.3, -0.05], [-1.0, 1.4, 0.05]),
        ],
    };
}
const madeUpConfig = { up: '+y', forward: '+x', length: 5, plan: 'quadruped' };

test('a model in pieces: legs low and off the middle, the head in front and high, the rest torso', () => {
    const s = toShape(madeUp(), madeUpConfig, 'herbivore');
    assert.equal(s.info.split, 'parts');
    const of = Object.fromEntries(s.info.parts);
    assert.deepEqual([of.body, of.head, of.hornL, of.hornR, of.tuft, of.tail], ['TORSO', 'HEAD', 'HEAD', 'HEAD', 'TORSO', 'TORSO']);
    assert.deepEqual([of.leg0, of.leg1, of.leg2, of.leg3], ['LEG_FL', 'LEG_FR', 'LEG_BL', 'LEG_BR']);
    cornersOk(s);
    // Legs stopping below the gait's hip are lengthened up into the body.
    for (const leg of LEGS) {
        const { joint, max } = partsOf(s.geometry).get(leg);
        assert.ok(max[1] > joint[1], `leg ${leg} reaches past its hip`);
    }
});

test('one merged mesh sorts vertex by vertex', () => {
    const m = madeUp();
    const position = [];
    const color = [];
    const indices = [];
    let base = 0;
    for (const p of m.primitives) {
        position.push(...p.position);
        color.push(...p.color);
        for (const i of p.indices) indices.push(base + i);
        base += p.position.length / 3;
    }
    const merged = { ...m, primitives: [{ ...m.primitives[0], node: 'merged', position: Float32Array.from(position), color: Float32Array.from(color), indices: Uint32Array.from(indices) }] };
    const s = toShape(merged, madeUpConfig, 'herbivore');
    assert.equal(s.info.split, 'vertices');
    assert.deepEqual(sorted(partsOf(s.geometry)), ALL);
    cornersOk(s);
});

test('axes: up and forward give a rotation, the left side at −Z', () => {
    assert.deepEqual(basis('+z', '+x'), [[1, 0, 0], [0, 0, 1], [0, -1, 0]]); // Z up facing +X: +Y (left) → −Z
    assert.deepEqual(basis('+y', '+z'), [[0, 0, 1], [0, 1, 0], [-1, 0, 0]]); // glTF's own: +X (left) → −Z
    assert.deepEqual(basis('+z', '-y'), [[0, -1, 0], [0, 0, 1], [-1, 0, 0]]); // Z up facing −Y: +X (left) → −Z
    assert.throws(() => basis('+z', '-z'), /must differ/);
    assert.throws(() => basis('up', '+x'), /not an axis/);
});

// ---- The reader on small made-up files ----

function makeGlb(json, bin = new Uint8Array(0)) {
    const enc = new TextEncoder().encode(JSON.stringify(json));
    const pad = (n) => (4 - (n % 4)) % 4;
    const jl = enc.length + pad(enc.length);
    const bl = bin.length + pad(bin.length);
    const total = 12 + 8 + jl + (bl ? 8 + bl : 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jl, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.set(enc, 20);
    out.fill(0x20, 20 + enc.length, 20 + jl);
    if (bl) {
        dv.setUint32(20 + jl, bl, true);
        dv.setUint32(24 + jl, 0x004e4942, true);
        out.set(bin, 28 + jl);
    }
    return out;
}

// One triangle (or a strip of two) in a node with a transform.
function triangleFile({ node = {}, mode = 4, extensionsRequired } = {}) {
    const pts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    const bin = new Uint8Array(pts.buffer);
    return makeGlb({
        asset: { version: '2.0' },
        ...(extensionsRequired ? { extensionsRequired, extensionsUsed: extensionsRequired } : {}),
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: 'root', children: [1], translation: [10, 0, 0] }, { name: 'leaf', mesh: 0, ...node }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: mode === 4 ? 3 : 4, type: 'VEC3' }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
        buffers: [{ byteLength: bin.length }],
    }, bin);
}

test('the reader moves pieces by their nodes (translation, rotation, scale, matrix)', () => {
    const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-6);
    let p = readGlb(triangleFile({ node: { scale: [2, 2, 2] } })).primitives[0];
    assert.ok(near(Array.from(p.position), [10, 0, 0, 12, 0, 0, 10, 2, 0]));
    // A quarter turn about Z: +X goes to +Y.
    const q = Math.SQRT1_2;
    p = readGlb(triangleFile({ node: { rotation: [0, 0, q, q] } })).primitives[0];
    assert.ok(near(Array.from(p.position), [10, 0, 0, 10, 1, 0, 9, 0, 0]));
    p = readGlb(triangleFile({ node: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 0, 1] } })).primitives[0];
    assert.ok(near(Array.from(p.position), [10, 5, 0, 11, 5, 0, 10, 6, 0]));
    // A mirrored node keeps its triangles facing out.
    p = readGlb(triangleFile({ node: { scale: [-1, 1, 1] } })).primitives[0];
    assert.deepEqual(Array.from(p.indices), [0, 2, 1]);
});

test('the reader turns strips into triangles', () => {
    const p = readGlb(triangleFile({ mode: 5 })).primitives[0];
    assert.deepEqual(Array.from(p.indices), [0, 1, 2, 2, 1, 3]);
});

test('the reader refuses what it cannot read, saying why', () => {
    assert.throws(() => readGlb(new Uint8Array(40)), (e) => e instanceof GlbError && /not a binary glTF/.test(e.message));
    assert.throws(() => readGlb(triangleFile({ extensionsRequired: ['KHR_draco_mesh_compression'] })), /Draco/);
    assert.throws(() => readGlb(triangleFile({ extensionsRequired: ['EXT_meshopt_compression'] })), /meshopt/);
    assert.throws(() => readGlb(triangleFile({ extensionsRequired: ['EXT_something_new'] })), /EXT_something_new/);
    // Quantized geometry is just accessors: read.
    assert.equal(readGlb(triangleFile({ extensionsRequired: ['KHR_mesh_quantization'] })).primitives.length, 1);
});
