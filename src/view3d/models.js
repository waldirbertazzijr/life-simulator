// Imported models: a .glb from assets/models/ turned into one of our bodies,
// the same kind of geometry shapes.js builds in code, so the same instancing,
// materials and vertex animation draw it (creatures.js, animate.js).
//
// What a model becomes (toShape):
// - one non-indexed geometry, every triangle with its own three vertices, so
//   the faces stay flat-shaded;
// - `color`: the model's own colours (linear), per vertex. Its material is
//   then white, so they show as they are; a tint per instance still applies;
// - `rig`: each vertex's part (torso, head, a leg) and that part's joint;
// - our axes: +X the front, +Y up, feet at y = 0, the left side at −Z,
//   centred, and scaled to the asset's length.
//
// The models in assets/models/ were baked from textured, rigged models by
// tools/bake.mjs: flat colours per face, our axes, and each vertex's part
// with its bones' joints (asset.extras.lifeSim). Where they came from is in
// src/credits.js. Other models are read too, if their entry says how they
// were made (which way is up and which way they face, whether their vertex
// colours are sRGB bytes, as trimesh writes them; glTF says linear).
//
// The rig of a quadruped (quadruped()):
// - A baked model says each vertex's part (from the bone that moves it most).
// - A model in separate pieces (meshes) is sorted piece by piece, by the
//   middle of its surface: low and off the middle line, a leg (its corner
//   says which); in the front fifth, or both forward and high (horns, ears),
//   the head; the rest (belly tufts, tail), the torso.
// - One merged mesh (what image-to-3D tools make) is sorted vertex by vertex:
//   below the belly, a leg; the head and the torso as above.
// - Joints: a baked model's legs turn where its bones' hips and shoulders
//   are, and its gait takes that height (`hip`, creatures.js sets GAIT.leg),
//   so the feet do not slide; its head turns at the neck's root. Otherwise a
//   leg turns at its top, at the gait's hip height (pieces of legs that stop
//   below it are lengthened up into the body, so a swinging leg opens no
//   gap), and the head at its back and bottom (the throat). The torso and
//   the whole body turn at the torso's middle.
// - `body`: its proportions against the code-built body the poses were
//   written for (keyframes.js FRAME); they scale the poses' shift and pivot.
//
// Far away a model is drawn simplified (`lite`: three's SimplifyModifier,
// piece by piece): an animal a few pixels long needs no 1,500 triangles.
// Until a model has loaded, the body built in code (shapes.js) stands in.
//
// The next model is an entry in MODELS (and, for a new body plan, a sorter
// in PLANS beside quadruped()). Axes are any of ±x, ±y, ±z: a figure made Z up
// and facing −Y is { up: '+z', forward: '-y' }.
import * as THREE from 'three';
import { readGlb } from './glb.js';
import { GAIT, PART } from './animate.js';
import { FRAME } from './keyframes.js';

// glTF's own conventions, for an entry that does not say (a baked file says).
const DEFAULTS = { up: '+y', forward: '+z', srgb: false, plan: 'quadruped', lite: 0.2 };

export const MODELS = {
    herbivore: {
        url: '../../assets/models/sheep.glb', // from this file
        length: 5.2,  // nose to tail, world units (the code-built grazer: 5 long, 3.4 tall)
        minPx: 8,     // in the map view, at least this many pixels long (creatures.js SPECIES; 6 for the round body built in code)
    },
    carnivore: {
        url: '../../assets/models/wolf.glb',
        length: 7,    // nose to the tip of the tail (the code-built predator: 7)
        minPx: 14,    // (11 for the body built in code; this one is slim, with a long tail)
    },
};

// How a quadruped is sorted, as shares of its length (from the tail), height
// and half width (from the middle line). An asset can change any of these
// (`sort` in its MODELS entry), e.g. a merged mesh whose head and horns sit
// low over the neck: sort: { headHigh: [0.65, 0.65] }.
const QUADRUPED = {
    legBelow: 0.42,  // a piece whose middle is below this height...
    legOff: 0.2,     // ...and this far off the middle line is a leg
    head: 0.8,       // the front fifth is the head...
    headHigh: [0.65, 0.8], // ...and so is what is both this far forward and this high (horns, ears)
    reach: 0.2,      // legs reach above their hip by this share of the hip's height
    top: 0.05,       // a leg's top: its vertices this close (× height) to its highest
};
const LITE_MIN = 6; // a piece keeps at least this many vertices in the far level

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const LEGS = [PART.LEG_FL, PART.LEG_FR, PART.LEG_BL, PART.LEG_BR];
export const PART_NAME = Object.fromEntries(Object.entries(PART).map(([k, v]) => [v, k])); // 2 → 'LEG_FL'

// '+z', '-x', 'y'... as a unit vector.
export function axis(s) {
    const m = /^([+-]?)([xyz])$/i.exec(String(s).trim());
    if (!m) throw new Error(`not an axis: ${s} (use +x, -y, +z...)`);
    return AXES[m[2].toLowerCase()].map((c) => (m[1] === '-' ? 0 - c : c));
}

// The rows that turn the file's axes into ours: forward, up, and forward ×
// up (the file's right, which is our +Z). Always a rotation: the triangles
// keep their winding.
export function basis(up, forward) {
    const u = axis(up);
    const f = axis(forward);
    if (u[0] * f[0] + u[1] * f[1] + u[2] * f[2] !== 0) throw new Error(`up ${up} and forward ${forward} must differ`);
    return [f, u, [f[1] * u[2] - f[2] * u[1] + 0, f[2] * u[0] - f[0] * u[2] + 0, f[0] * u[1] - f[1] * u[0] + 0]];
}

const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// Every primitive as a piece of non-indexed triangles in our axes, standing
// on y = 0, centred, scaled to `length`: { name, pos, col, part } (part per
// vertex only in a baked file). Also the joints a baked file gives (its
// bones'), moved the same way: { head: [x, y, z], leg_fl: ... }.
function piecesOf(glb, config) {
    const [f, u, s] = basis(config.up, config.forward);
    const turn = (x, y, z) => [f[0] * x + f[1] * y + f[2] * z, u[0] * x + u[1] * y + u[2] * z, s[0] * x + s[1] * y + s[2] * z];
    const pieces = [];
    for (const p of glb.primitives) {
        let n = p.indices ? p.indices.length : p.position.length / 3;
        n -= n % 3;
        if (!n) continue;
        const pos = new Float32Array(n * 3);
        const col = new Float32Array(n * 3);
        const part = p.part ? new Uint8Array(n) : null;
        const tint = p.material.color;
        for (let k = 0; k < n; k++) {
            const v = p.indices ? p.indices[k] : k;
            pos.set(turn(p.position[v * 3], p.position[v * 3 + 1], p.position[v * 3 + 2]), k * 3);
            for (let c = 0; c < 3; c++) {
                let a = p.color ? p.color[v * 4 + c] : 1;
                if (p.color && config.srgb) a = linear(a);
                col[k * 3 + c] = a * tint[c];
            }
            if (part) part[k] = Math.round(p.part[v]);
        }
        pieces.push({ name: p.node, pos, col, part });
    }
    if (!pieces.length) throw new Error('no triangles in the model');
    const b = bounds(pieces);
    const scale = config.length / (b.maxX - b.minX);
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const place = ([x, y, z]) => [(x - cx) * scale, (y - b.minY) * scale, (z - cz) * scale];
    for (const { pos } of pieces) {
        for (let i = 0; i < pos.length; i += 3) pos.set(place([pos[i], pos[i + 1], pos[i + 2]]), i);
    }
    const joints = {};
    for (const [name, at] of Object.entries(config.joints ?? {})) joints[name] = place(turn(...at));
    return { pieces, joints };
}

function bounds(pieces, keep = null) {
    const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const piece of pieces) {
        const { pos } = piece;
        for (let i = 0, v = 0; i < pos.length; i += 3, v++) {
            if (keep && !keep(piece, v)) continue;
            if (pos[i] < b.minX) b.minX = pos[i];
            if (pos[i] > b.maxX) b.maxX = pos[i];
            if (pos[i + 1] < b.minY) b.minY = pos[i + 1];
            if (pos[i + 1] > b.maxY) b.maxY = pos[i + 1];
            if (pos[i + 2] < b.minZ) b.minZ = pos[i + 2];
            if (pos[i + 2] > b.maxZ) b.maxZ = pos[i + 2];
        }
    }
    return b;
}

// The middle of a piece's surface (its triangles' centres, by area).
function centroid(pos) {
    let ax = 0;
    let ay = 0;
    let az = 0;
    let total = 0;
    for (let i = 0; i < pos.length; i += 9) {
        const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
        const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
        const a = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) + 1e-12;
        ax += (a * (pos[i] + pos[i + 3] + pos[i + 6])) / 3;
        ay += (a * (pos[i + 1] + pos[i + 4] + pos[i + 7])) / 3;
        az += (a * (pos[i + 2] + pos[i + 5] + pos[i + 8])) / 3;
        total += a;
    }
    return [ax / total, ay / total, az / total];
}

// The quadruped rule for a point, given the model's bounds (in our axes,
// standing on y = 0): its part, with `legOf(front, z)` for a leg's corner.
// tools/bake.mjs sorts bones it cannot name by the same rule.
export function quadrupedRule(box, tune) {
    const Q = { ...QUADRUPED, ...tune };
    const L = box.maxX - box.minX;
    const H = box.maxY - box.minY;
    const cz = (box.minZ + box.maxZ) / 2;
    const B = (box.maxZ - box.minZ) / 2;
    const along = (x) => (x - box.minX) / L;
    const isHead = (x, y) => along(x) > Q.head || (along(x) > Q.headHigh[0] && (y - box.minY) / H > Q.headHigh[1]);
    const isLeg = (y, z) => (y - box.minY) / H < Q.legBelow && Math.abs(z - cz) / B > Q.legOff;
    const legOf = (front, z) => (front ? (z < cz ? PART.LEG_FL : PART.LEG_FR) : z < cz ? PART.LEG_BL : PART.LEG_BR);
    return { Q, L, H, B, along, isHead, isLeg, legOf };
}

// Sort a quadruped's pieces (split 'parts') or vertices ('vertices') into
// torso, head and four legs: each piece gets `part`, a Uint8Array of its
// vertices' parts; a baked file's pieces ('baked') come with theirs.
// Lengthens legs that stop below the hip (pieces only). Returns the joints:
// { joints: part → [x, y, z], torso, root, body }; `given` joints (a baked
// file's bones: head, leg_fl...) are used where there are some.
function quadruped(pieces, split, hip, frame, tune, given = {}) {
    const box = bounds(pieces);
    const { Q, L, H, B, along, isHead, isLeg, legOf } = quadrupedRule(box, tune);

    if (split === 'parts') {
        const legs = [];
        for (const piece of pieces) {
            const [x, y, z] = (piece.middle = centroid(piece.pos));
            piece.leg = isLeg(y, z);
            if (piece.leg) legs.push(x);
        }
        const mid = (Math.min(...legs) + Math.max(...legs)) / 2; // between the front legs and the back
        for (const piece of pieces) {
            const [x, y, z] = piece.middle;
            const part = piece.leg ? legOf(x > mid, z) : isHead(x, y) ? PART.HEAD : PART.TORSO;
            piece.part = new Uint8Array(piece.pos.length / 3).fill(part);
        }
    } else if (split === 'vertices') {
        // The feet: where the surface meets the ground; and how close to
        // the middle line they come.
        let footMin = Infinity;
        let footMax = -Infinity;
        let inner = Infinity;
        for (const { pos } of pieces) {
            for (let i = 0; i < pos.length; i += 3) {
                if (pos[i + 1] >= 0.1 * H) continue;
                footMin = Math.min(footMin, pos[i]);
                footMax = Math.max(footMax, pos[i]);
                inner = Math.min(inner, Math.abs(pos[i + 2]));
            }
        }
        // The belly: the lowest point of the underside in the middle of the
        // body, between the legs (vertices and the middles of triangles).
        let belly = Infinity;
        const low = (x, y, z) => {
            const a = along(x);
            if (a > 0.3 && a < 0.7 && Math.abs(z) < Math.max(0.8 * inner, 0.05 * B) && y < belly) belly = y;
        };
        for (const { pos } of pieces) {
            for (let i = 0; i < pos.length; i += 9) {
                for (let k = 0; k < 9; k += 3) low(pos[i + k], pos[i + k + 1], pos[i + k + 2]);
                low((pos[i] + pos[i + 3] + pos[i + 6]) / 3, (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3, (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3);
            }
        }
        if (!(belly < Infinity)) belly = 0.4 * H;
        const mid = (footMin + footMax) / 2;
        for (const piece of pieces) {
            const { pos } = piece;
            piece.part = new Uint8Array(pos.length / 3);
            for (let i = 0, v = 0; i < pos.length; i += 3, v++) {
                const [x, y, z] = [pos[i], pos[i + 1], pos[i + 2]];
                piece.part[v] = y < belly ? legOf(x > mid, z) : isHead(x, y) ? PART.HEAD : PART.TORSO;
            }
        }
    }

    const of = (part) => (piece, v) => piece.part[v] === part;
    const joints = {};
    // Legs: at their bones' joints (and the gait takes their height), or at
    // the gait's hip height above the middle of the leg's top.
    const bones = LEGS.map((leg) => given[PART_NAME[leg].toLowerCase()]);
    const own = bones.every(Boolean) ? bones.reduce((s, b) => s + b[1], 0) / 4 : null;
    for (const leg of LEGS) {
        const b = bounds(pieces, of(leg));
        if (!(b.maxY > -Infinity)) throw new Error(`no ${PART_NAME[leg]} found`);
        if (own !== null) {
            joints[leg] = [...given[PART_NAME[leg].toLowerCase()]];
            continue;
        }
        const near = b.maxY - Q.top * H;
        let sx = 0;
        let sz = 0;
        let n = 0;
        const want = hip * (1 + Q.reach);
        for (const piece of pieces) {
            const { pos } = piece;
            for (let i = 0, v = 0; i < pos.length; i += 3, v++) {
                if (piece.part[v] !== leg || pos[i + 1] < near) continue;
                sx += pos[i];
                sz += pos[i + 2];
                n++;
                if (split === 'parts' && b.maxY < want) pos[i + 1] += want - b.maxY;
            }
        }
        joints[leg] = [sx / n, hip, sz / n];
    }
    // The head: at its back and bottom (the throat), so that lowered it
    // swings the nose down to the grass; or at its bone's joint (the neck's root).
    const hb = bounds(pieces, of(PART.HEAD));
    if (!(hb.maxX > -Infinity)) throw new Error('no head found');
    joints[PART.HEAD] = given.head ? [given.head[0], given.head[1], 0] : [hb.minX, hb.minY, 0];
    // The torso, and the whole body, at the torso's middle.
    const tb = bounds(pieces, of(PART.TORSO));
    const torso = [(tb.minX + tb.maxX) / 2, (tb.minY + tb.maxY) / 2, 0];
    joints[PART.TORSO] = torso;
    const half = Math.max(-tb.minZ, tb.maxZ);
    const body = frame ? [L / frame.length, torso[1] / frame.center, half / frame.half] : [1, 1, 1];
    return { joints, torso, root: torso, body, hip: own ?? hip };
}

// Pieces (with `part` per vertex) and joints as one geometry like shapes.js's.
function geometryOf(pieces, joints) {
    let n = 0;
    for (const p of pieces) n += p.pos.length / 3;
    const position = new Float32Array(n * 3);
    const color = new Float32Array(n * 3);
    const rig = new Float32Array(n * 4);
    let o = 0;
    for (const p of pieces) {
        position.set(p.pos, o * 3);
        color.set(p.col, o * 3);
        for (let v = 0; v < p.part.length; v++) {
            const j = joints[p.part[v]];
            rig.set([j[0], j[1], j[2], p.part[v]], (o + v) * 4);
        }
        o += p.part.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.setAttribute('rig', new THREE.BufferAttribute(rig, 4));
    g.computeVertexNormals(); // unshared vertices: each gets its face's normal
    g.computeBoundingSphere();
    return g;
}

// The sorters, by body plan. Each takes the pieces (in our axes, standing,
// scaled), how they come ('baked', or to split by 'parts' or 'vertices'),
// the gait's hip height, the body the poses were written for, the entry's
// tuning and a baked file's joints; it gives every piece `part` (per
// vertex), may reshape pieces (a leg lengthened), and returns { joints,
// torso, root, body, hip }. (A 'biped' would go here: legs below the hip,
// split by side; arms beyond the shoulders' width, turned down from an
// A-pose to hanging; the head above the neck; the rest torso. tools/bake.mjs
// would name the bones of arms and legs by side.)
const PLANS = { quadruped };

// A file baked by tools/bake.mjs says its own axes and colour space, and
// carries its bones' joints (asset.extras.lifeSim); it overrides the entry.
export function fileConfig(glb, config) {
    const own = glb.asset?.extras?.lifeSim ?? {};
    const out = { ...DEFAULTS, ...config };
    for (const key of ['up', 'forward', 'srgb', 'joints']) if (own[key] !== undefined) out[key] = own[key];
    return out;
}

// A model (readGlb's) as a body for `kind`: { geometry, pieces, torso, root,
// body, hip, joints, ownColors, info }. The far level is added by lite().
// The pieces stay on the shape (name, pos, col, part) for later passes, such
// as colour roles (skin, cloth) for tints per instance.
export function toShape(glb, entry, kind) {
    const config = fileConfig(glb, entry);
    const sort = PLANS[config.plan];
    if (!sort) throw new Error(`${kind}: no sorter for the body plan '${config.plan}' yet`);
    const { pieces, joints: given } = piecesOf(glb, config);
    const baked = pieces.every((p) => p.part);
    const split = baked ? 'baked' : config.split ?? (pieces.length > 1 ? 'parts' : 'vertices');
    const rig = sort(pieces, split, GAIT[kind].leg, FRAME[kind], config.sort, given);
    const geometry = geometryOf(pieces, rig.joints);
    const triangles = geometry.attributes.position.count / 3;
    return {
        geometry, pieces, ...rig, ownColors: true, lite: null, minPx: config.minPx ?? null,
        info: { triangles, split, parts: pieces.map((p) => [p.name, PART_NAME[p.part[0]]]), skipped: glb.skipped },
    };
}

// A piece (non-indexed pos, col, and part per vertex) simplified to about
// `keep` of its vertices (at least `least`) by three's SimplifyModifier, on
// positions alone so that faces of different colours still join. Each new
// face takes the colour of the old faces nearest it (by area, facing the same
// way); each vertex keeps its part (an edge collapse leaves one of its two
// vertices where it was).
export async function simplify(piece, keep, least = LITE_MIN) {
    const { SimplifyModifier } = await import('../../vendor/three/examples/jsm/modifiers/SimplifyModifier.js');
    const partAt = new Map();
    const key = (a, v) => `${a[v * 3]},${a[v * 3 + 1]},${a[v * 3 + 2]}`;
    for (let v = 0; v < piece.part.length; v++) partAt.set(key(piece.pos, v), piece.part[v]);
    const remove = Math.max(0, partAt.size - Math.max(least, Math.round(partAt.size * keep)));
    if (!remove) return piece;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(piece.pos, 3));
    const pos = Float32Array.from(new SimplifyModifier().modify(g, remove).toNonIndexed().attributes.position.array);
    const part = new Uint8Array(pos.length / 3);
    for (let v = 0; v < part.length; v++) part[v] = partAt.get(key(pos, v)) ?? piece.part[0];
    return { name: piece.name, pos, col: recolour(pos, piece), part };
}

// Each face of `pos` coloured as the faces of `from` nearest it: each old
// face gives its colour, by area, to the nearest new face facing its way;
// a new face given none takes the nearest old face's.
export function recolour(pos, from) {
    const faces = (p) => {
        const n = p.length / 9;
        const c = new Float64Array(n * 3);
        const nrm = new Float64Array(n * 3);
        const area = new Float64Array(n);
        for (let f = 0; f < n; f++) {
            const i = f * 9;
            const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
            const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const a = Math.hypot(nx, ny, nz);
            area[f] = a / 2;
            nrm.set([nx / (a || 1), ny / (a || 1), nz / (a || 1)], f * 3);
            for (let k = 0; k < 3; k++) c[f * 3 + k] = (p[i + k] + p[i + 3 + k] + p[i + 6 + k]) / 3;
        }
        return { n, c, nrm, area };
    };
    const A = faces(pos);
    const O = faces(from.pos);
    const sum = new Float64Array(A.n * 4);
    const nearest = (f, sameWay) => {
        let best = -1;
        let bestD = Infinity;
        for (let g = 0; g < A.n; g++) {
            if (sameWay && A.nrm[g * 3] * O.nrm[f * 3] + A.nrm[g * 3 + 1] * O.nrm[f * 3 + 1] + A.nrm[g * 3 + 2] * O.nrm[f * 3 + 2] < 0.2) continue;
            const dx = A.c[g * 3] - O.c[f * 3], dy = A.c[g * 3 + 1] - O.c[f * 3 + 1], dz = A.c[g * 3 + 2] - O.c[f * 3 + 2];
            const d = dx * dx + dy * dy + dz * dz;
            if (d < bestD) {
                bestD = d;
                best = g;
            }
        }
        return best;
    };
    for (let f = 0; f < O.n; f++) {
        let g = nearest(f, true);
        if (g < 0) g = nearest(f, false);
        const w = O.area[f] + 1e-9;
        for (let k = 0; k < 3; k++) sum[g * 4 + k] += w * from.col[f * 9 + k];
        sum[g * 4 + 3] += w;
    }
    const col = new Float32Array(pos.length);
    for (let g = 0; g < A.n; g++) {
        let rgb;
        if (sum[g * 4 + 3] > 0) rgb = [0, 1, 2].map((k) => sum[g * 4 + k] / sum[g * 4 + 3]);
        else {
            // (Swap roles: the old face nearest this new one.)
            let best = 0;
            let bestD = Infinity;
            for (let f = 0; f < O.n; f++) {
                const dx = A.c[g * 3] - O.c[f * 3], dy = A.c[g * 3 + 1] - O.c[f * 3 + 1], dz = A.c[g * 3 + 2] - O.c[f * 3 + 2];
                const d = dx * dx + dy * dy + dz * dz;
                if (d < bestD) {
                    bestD = d;
                    best = f;
                }
            }
            rgb = [0, 1, 2].map((k) => from.col[best * 9 + k]);
        }
        for (let v = 0; v < 3; v++) col.set(rgb, g * 9 + v * 3);
    }
    return col;
}

// The far level: each piece simplified on its own, keeping about `keep` of
// its vertices; parts and colours carried over.
export async function lite(shape, keep) {
    const out = [];
    for (const piece of shape.pieces) out.push(await simplify(piece, keep));
    return geometryOf(out, shape.joints);
}

// `kind`'s model, fetched, read and converted once (with its far level): a
// promise of the shape, or of null for a kind without one (people, so far).
const loading = new Map();
export function loadModel(kind) {
    const entry = MODELS[kind];
    if (!entry || typeof fetch === 'undefined') return Promise.resolve(null);
    if (!loading.has(kind)) {
        loading.set(kind, (async () => {
            const url = new URL(entry.url, import.meta.url);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`${url.pathname}: ${res.status}`);
            const config = { ...DEFAULTS, ...entry };
            const shape = toShape(readGlb(await res.arrayBuffer()), config, kind);
            if (config.lite) shape.lite = await lite(shape, config.lite);
            return shape;
        })());
    }
    return loading.get(kind);
}
