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
// The rig of a biped (biped(), the people in assets/models/people/): piece by
// piece, the bare body first, by where its pieces are:
// - its skin is the colour of the outermost piece (in an A-pose, a hand);
// - the head is the highest skin piece, with the neck (the middle piece that
//   reaches up into it) and what is above its chin (ears, nose);
// - below the torso's lowest point, a piece off the middle line is a leg (by
//   its side); above it, an arm (by its side); the rest is the torso;
// - then whatever it wears, largest first: a piece across the middle line
//   (a robe, a belt) is torso (head, above the chin); any other goes with the
//   piece nearest it (a fringe with its robe, a wrap with its limb, a bead
//   with the chest it lies on). Long robes stay torso: their hems do not
//   swing with the legs.
// - Its arms, made held out in an A-pose, are turned down about the shoulder
//   (the middle of the arm's top piece) until the hand would come too close to
//   the torso: they hang at its sides, a little out where the
//   hips are wide, which is the rest the poses were written for.
// - Joints: the legs turn at the hip (the thigh's top, less half its
//   radius), and the gait takes that height; the torso bends there too, and
//   the whole body turns about it; the head nods at the neck's root.
// - `rig`: where the shoulders, the hands (gripping), the belt and the back
//   are, for what is held or carried (items.js).
//
// Each piece of a person also gets a colour role (`dye`, per vertex): skin
// (its colour kept as a share of the skin's, so the lips stay lips, and the
// skin tone comes per person), cloth (its colour as a shade of the main
// garment's: dyed per person in its tribe's colour), or its own (bone,
// beads, cord, paint). Cloth is any colour but the skin's that covers a fair
// share of the surface; the rest keep their own, but for the few the table
// TONED makes skin. Hair (hair.js) is added to the head: every style, of
// which each person shows one (animate.js).
//
// Far away a model is drawn simplified (`lite`: three's SimplifyModifier,
// piece by piece): an animal a few pixels long needs no 1,500 triangles.
// Until a model has loaded, the body built in code (shapes.js) stands in.
//
// The next model is an entry in MODELS (and, for a new body plan, a sorter
// in PLANS beside quadruped()). Axes are any of ±x, ±y, ±z: a figure made Z up
// and facing −Y is { up: '+z', forward: '-y' }. People are a body (looks.js
// BODIES) in an outfit (OUTFITS), all with one entry, PERSON.
import * as THREE from 'three';
import { readGlb } from './glb.js';
import { GAIT, PART } from './animate.js';
import { FRAME } from './keyframes.js';
import { hairPieces } from './hair.js';
import { DYE } from './looks.js';

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

// People: three bodies (looks.js BODIES), each in five outfits,
// assets/models/people/<body>__<outfit>.glb
// (the owner's, made with trimesh: Z up, facing −Y, sRGB vertex colours, A-pose).
// One scale for all: the man is 4.8 tall, as the body built in code, and the
// women as tall as they were made beside him.
export const OUTFITS = ['plain_base', 'warrior', 'shaman', 'thinker', 'cultivator'];
export const PERSON = {
    up: '+z', forward: '-y', srgb: true, plan: 'biped', scale: 1.93, lite: 0.2,
    minPx: 12, // in the map view, at least this many pixels tall (10 for the body built in code: these are slimmer)
};
export const personUrl = (body, outfit) => `../../assets/models/people/${body}__${outfit}.glb`;

// What a person wears is its job's outfit: the one place that says so.
// (Jobs come with package 3: until then nobody has one, everyone wears
// plain_base, and the other outfits are never fetched.)
const OUTFIT_OF_JOB = { warrior: 'warrior', shaman: 'shaman', thinker: 'thinker', cultivator: 'cultivator' };
export const outfitOf = (job) => OUTFIT_OF_JOB[job] ?? OUTFITS[0];

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
// How a biped is sorted, as shares of its height.
const BIPED = {
    side: 0.04,   // a piece whose middle is this far off the middle line is on one side...
    cross: 0.01,  // ...and one reaching this far past it on both sides crosses it
    clear: 0.02,  // a hanging hand stays this far from the torso...
    hand: 0.75,   // ...the arm from this share of its length on (the wrist and the hand)
};
// Colour roles: a garment is cloth if its colour covers this share of the
// surface; and colours (as the file has them, sRGB bytes) that follow the
// skin tone although they are not the skin's (the lips).
const CLOTH_SHARE = 0.08;
const TONED = new Set(['111,76,59']);
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
// on y = 0, centred, scaled to `length` (or by `scale`): { name, pos, col,
// part, key } (part per vertex only in a baked file; key, its first colour as
// the file has it, 'r,g,b' in bytes). Also the joints a baked file gives (its
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
        const key = p.color ? [0, 1, 2].map((c) => Math.round(p.color[c] * 255)).join(',') : '';
        pieces.push({ name: p.node, pos, col, part, key });
    }
    if (!pieces.length) throw new Error('no triangles in the model');
    const b = bounds(pieces);
    const scale = config.scale ?? config.length / (b.maxX - b.minX);
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

// ---- Bipeds ----

const ARMS = [PART.ARM_L, PART.ARM_R];

function area(pos) {
    let a = 0;
    for (let i = 0; i < pos.length; i += 9) {
        const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
        const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
        a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    return a;
}

// The nearest vertex of `piece` to the point p, squared.
function nearest2(piece, [x, y, z]) {
    const { pos } = piece;
    let best = Infinity;
    for (let i = 0; i < pos.length; i += 3) {
        const d = (pos[i] - x) ** 2 + (pos[i + 1] - y) ** 2 + (pos[i + 2] - z) ** 2;
        if (d < best) best = d;
    }
    return best;
}

const argmax = (list, f) => list.reduce((best, p) => (best === null || f(p) > f(best) ? p : best), null);

// Sort a biped's pieces into torso, head, two legs and two arms, turn its
// arms down to hang, and find its joints (see the top of this file).
// Returns { joints, torso, root, body, hip, rig, skin }; every piece gets
// `part`. (It finds its own hips: the gait's are not needed.)
function biped(pieces, split, gaitHip, frame, tune) {
    if (split !== 'parts') throw new Error('a biped is sorted piece by piece: its model must come in parts');
    const B = { ...BIPED, ...tune };
    const H = bounds(pieces).maxY;
    for (const p of pieces) {
        p.middle = centroid(p.pos);
        p.box = bounds([p]);
        p.area = area(p.pos);
        p.part = null;
    }
    const set = (p, part) => {
        p.part = new Uint8Array(p.pos.length / 3).fill(part);
    };
    const sideOf = (p) => (Math.abs(p.middle[2]) > B.side * H ? Math.sign(p.middle[2]) : 0);

    // The bare body: the pieces in the skin's colour.
    const skin = argmax(pieces, (p) => Math.max(-p.box.minZ, p.box.maxZ)).col;
    const isSkin = (p) => Math.abs(p.col[0] - skin[0]) + Math.abs(p.col[1] - skin[1]) + Math.abs(p.col[2] - skin[2]) < 0.01;
    const bare = pieces.filter(isSkin);
    const head = argmax(bare, (p) => p.box.maxY);
    const chin = head.box.minY;
    const trunk = argmax(bare.filter((p) => p !== head && sideOf(p) === 0 && p.middle[1] < chin), (p) => p.area);
    if (!trunk) throw new Error('no torso found');
    const waist = trunk.box.minY;
    let neck = null;
    for (const p of bare) {
        if (p === head) set(p, PART.HEAD);
        else if (p !== trunk && sideOf(p) === 0 && p.box.minY < chin && p.box.maxY > chin) {
            set(p, PART.HEAD); // the neck
            neck = p;
        } else if (p.middle[1] > chin) set(p, PART.HEAD); // ears, nose
        else if (sideOf(p) === 0) set(p, PART.TORSO);
        else if (p.middle[1] < waist) set(p, sideOf(p) < 0 ? PART.LEG_FL : PART.LEG_FR);
        else set(p, sideOf(p) < 0 ? PART.ARM_L : PART.ARM_R);
    }
    // What it wears, largest first.
    const sorted = [...bare];
    for (const p of pieces.filter((q) => !q.part).sort((a, b) => b.area - a.area)) {
        if (p.box.minZ < -B.cross * H && p.box.maxZ > B.cross * H) set(p, p.middle[1] > chin ? PART.HEAD : PART.TORSO);
        else set(p, argmax(sorted, (q) => -nearest2(q, p.middle)).part[0]);
        sorted.push(p);
    }
    for (const part of [PART.LEG_FL, PART.LEG_FR, ...ARMS]) {
        if (!bare.some((p) => p.part[0] === part)) throw new Error(`no ${PART_NAME[part]} found`);
    }

    // The torso's half width (and how far back it reaches) at each height,
    // in bands of a hundredth of the height: along every edge of its
    // triangles, where it crosses each band.
    const BANDS = 100;
    const wide = new Float64Array(BANDS);
    const back = new Float64Array(BANDS);
    const band = (y) => Math.min(BANDS - 1, Math.max(0, Math.floor((y / H) * BANDS)));
    const across = (pos, a, b) => {
        const ya = pos[a + 1];
        const yb = pos[b + 1];
        for (let k = band(Math.min(ya, yb)); k <= band(Math.max(ya, yb)); k++) {
            const y = Math.min(Math.max(((k + 0.5) / BANDS) * H, Math.min(ya, yb)), Math.max(ya, yb));
            const t = yb === ya ? 0 : (y - ya) / (yb - ya);
            wide[k] = Math.max(wide[k], Math.abs(pos[a + 2] + (pos[b + 2] - pos[a + 2]) * t));
            back[k] = Math.max(back[k], -(pos[a] + (pos[b] - pos[a]) * t));
        }
    };
    for (const p of pieces) {
        if (p.part[0] !== PART.TORSO) continue;
        for (let i = 0; i < p.pos.length; i += 9) {
            across(p.pos, i, i + 3);
            across(p.pos, i + 3, i + 6);
            across(p.pos, i + 6, i);
        }
    }
    const widest = (y) => Math.max(wide[band(y) - 1] ?? 0, wide[band(y)], wide[band(y) + 1] ?? 0);

    // The arms, turned down from the A-pose about the shoulder, as far as
    // the torso lets them.
    const joints = {};
    const grip = {};
    for (const arm of ARMS) {
        const skinOf = bare.filter((p) => p.part[0] === arm);
        const shoulder = argmax(skinOf, (p) => p.box.maxY).middle;
        const hand = argmax(skinOf, (p) => Math.hypot(p.middle[1] - shoulder[1], p.middle[2] - shoulder[2])).middle;
        const s = Math.sign(hand[2] - shoulder[2]);
        const reach = Math.hypot(hand[1] - shoulder[1], hand[2] - shoulder[2]);
        const out = Math.atan2(Math.abs(hand[2] - shoulder[2]), shoulder[1] - hand[1]); // from hanging straight down
        const mine = pieces.filter((p) => p.part[0] === arm);
        const turn = (a, y, z) => {
            const c = Math.cos(s * a);
            const n = Math.sin(s * a);
            const dy = y - shoulder[1];
            const dz = z - shoulder[2];
            return [shoulder[1] + dy * c - dz * n, shoulder[2] + dy * n + dz * c];
        };
        // Does the arm, left `left` out from hanging, keep clear of the torso?
        const clears = (left) => {
            for (const p of mine) {
                for (let i = 0; i < p.pos.length; i += 3) {
                    if (Math.hypot(p.pos[i + 1] - shoulder[1], p.pos[i + 2] - shoulder[2]) < B.hand * reach) continue;
                    const [y, z] = turn(out - left, p.pos[i + 1], p.pos[i + 2]);
                    if (Math.abs(z) < widest(y) + B.clear * H) return false;
                }
            }
            return true;
        };
        const step = Math.PI / 360;
        let a = out;
        while (a - step > 0 && clears(a - step)) a -= step;
        a = out - a; // the turn that leaves it there
        for (const p of mine) {
            for (let i = 0; i < p.pos.length; i += 3) {
                const [y, z] = turn(a, p.pos[i + 1], p.pos[i + 2]);
                p.pos[i + 1] = y;
                p.pos[i + 2] = z;
            }
        }
        joints[arm] = [...shoulder];
        const [gy, gz] = turn(a, hand[1], hand[2]);
        grip[arm] = [hand[0], gy, gz];
    }

    // The legs turn at the hip: the thigh's top, less half its radius.
    let hip = 0;
    for (const leg of [PART.LEG_FL, PART.LEG_FR]) {
        const thigh = argmax(bare.filter((p) => p.part[0] === leg), (p) => p.box.maxY);
        const at = thigh.box.maxY - (thigh.box.maxZ - thigh.box.minZ) / 4;
        joints[leg] = [thigh.middle[0], at, thigh.middle[2]];
        hip += at / 2;
    }
    for (const leg of [PART.LEG_FL, PART.LEG_FR]) joints[leg][1] = hip;
    joints[PART.HEAD] = neck ? [neck.middle[0], neck.box.minY, 0] : [head.middle[0], chin, 0];
    const torso = [0, hip, 0];
    joints[PART.TORSO] = torso;
    const k = frame ? hip / frame.hip : 1;

    // Where things are held and carried (items.js): a knife at the belt, on
    // the left; a basket on the back.
    const shoulderY = joints[PART.ARM_R][1];
    const beltY = hip + 0.1 * (shoulderY - hip);
    const backY = hip + 0.55 * (shoulderY - hip);
    const rig = {
        hip, k,
        shoulder: { [PART.ARM_L]: joints[PART.ARM_L], [PART.ARM_R]: joints[PART.ARM_R] },
        grip,
        belt: [0.3 * k, beltY, -(widest(beltY) + 0.04 * k)],
        back: [-(back[band(backY)] + 0.45 * k), backY, 0],
        head: { joint: joints[PART.HEAD], box: head.box, pos: head.pos },
    };
    return { joints, torso, root: torso, body: [k, k, k], hip, rig, skin: skin.slice(0, 3) };
}

// Each piece's colour role (DYE, looks.js), and its colour made what that
// role needs: skin as a share of the skin's colour (per channel), cloth as a
// shade of the main garment's (grey), any other as it is. (Pieces sorted by
// biped(), which found the skin's colour.)
function colourRoles(pieces, skin) {
    const same = (c, d) => Math.abs(c[0] - d[0]) + Math.abs(c[1] - d[1]) + Math.abs(c[2] - d[2]) < 0.01;
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const total = pieces.reduce((s, p) => s + p.area, 0);
    const byColour = new Map();
    for (const p of pieces) byColour.set(p.key, (byColour.get(p.key) ?? 0) + p.area);
    const isCloth = (p) => !same(p.col, skin) && !TONED.has(p.key) && byColour.get(p.key) >= CLOTH_SHARE * total;
    const main = argmax(pieces.filter(isCloth), (p) => byColour.get(p.key));
    for (const p of pieces) {
        const c = p.col.slice(0, 3);
        let rgb = c;
        if (same(c, skin) || TONED.has(p.key)) {
            p.dye = DYE.skin;
            rgb = c.map((v, k) => v / skin[k]);
        } else if (isCloth(p)) {
            p.dye = DYE.cloth;
            rgb = [1, 1, 1].map(() => lum(c) / lum(main.col));
        } else p.dye = DYE.own;
        for (let i = 0; i < p.col.length; i += 3) p.col.set(rgb, i);
    }
}

// Pieces (with `part` per vertex, and maybe a `dye`) and joints as one
// geometry like shapes.js's.
function geometryOf(pieces, joints) {
    let n = 0;
    for (const p of pieces) n += p.pos.length / 3;
    const position = new Float32Array(n * 3);
    const color = new Float32Array(n * 3);
    const rig = new Float32Array(n * 4);
    const dyed = pieces.some((p) => p.dye !== undefined);
    const dye = dyed ? new Float32Array(n) : null;
    let o = 0;
    for (const p of pieces) {
        position.set(p.pos, o * 3);
        color.set(p.col, o * 3);
        for (let v = 0; v < p.part.length; v++) {
            const j = joints[p.part[v]];
            rig.set([j[0], j[1], j[2], p.part[v]], (o + v) * 4);
        }
        if (dye) dye.fill(p.dye ?? DYE.own, o, o + p.part.length);
        o += p.part.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.setAttribute('rig', new THREE.BufferAttribute(rig, 4));
    if (dye) g.setAttribute('dye', new THREE.BufferAttribute(dye, 1));
    g.computeVertexNormals(); // unshared vertices: each gets its face's normal
    g.computeBoundingSphere();
    return g;
}

// The sorters, by body plan. Each takes the pieces (in our axes, standing,
// scaled), how they come ('baked', or to split by 'parts' or 'vertices'),
// the gait's hip height, the body the poses were written for, the entry's
// tuning and a baked file's joints; it gives every piece `part` (per
// vertex), may reshape pieces (a leg lengthened, an arm turned down), and
// returns { joints, torso, root, body, hip } (a biped also `rig` and `skin`).
const PLANS = { quadruped, biped };

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
    const body = pieces.length;
    if (config.plan === 'biped') {
        colourRoles(pieces, rig.skin);
        pieces.push(...hairPieces(rig.rig.head));
    }
    const geometry = geometryOf(pieces, rig.joints);
    const triangles = geometry.attributes.position.count / 3;
    return {
        geometry, pieces, ...rig, ownColors: true, lite: null, minPx: config.minPx ?? null,
        info: { triangles, split, parts: pieces.slice(0, body).map((p) => [p.name, PART_NAME[p.part[0]]]), skipped: glb.skipped },
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
    return { name: piece.name, pos, col: recolour(pos, piece), part, dye: piece.dye };
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

// A model fetched, read and converted once (with its far level): a promise
// of the shape.
const loading = new Map();
function load(key, url, entry, kind) {
    if (!loading.has(key)) {
        loading.set(key, (async () => {
            const at = new URL(url, import.meta.url);
            const res = await fetch(at);
            if (!res.ok) throw new Error(`${at.pathname}: ${res.status}`);
            const config = { ...DEFAULTS, ...entry };
            const shape = toShape(readGlb(await res.arrayBuffer()), config, kind);
            if (config.lite) shape.lite = await lite(shape, config.lite);
            return shape;
        })());
    }
    return loading.get(key);
}

// `kind`'s model: a promise of the shape, or of null for a kind without one
// (people come in bodies and outfits: loadPerson).
export function loadModel(kind) {
    const entry = MODELS[kind];
    if (!entry || typeof fetch === 'undefined') return Promise.resolve(null);
    return load(kind, entry.url, entry, kind);
}

// A person's model: one of BODIES in one of OUTFITS.
export function loadPerson(body, outfit = OUTFITS[0]) {
    if (typeof fetch === 'undefined') return Promise.resolve(null);
    return load(`${body}__${outfit}`, personUrl(body, outfit), PERSON, 'human');
}
