// Hair, made in code to fit a head: the six styles of looks.js HAIR_STYLES,
// low-poly like the bodies, each a few pieces that ride on the head (they
// are part of it, so they nod, turn and fall with it in every pose).
//
// Every body carries all six (models.js adds them to its head); each person
// shows the one they wear, and the rest fold away to nothing in the vertex
// shader (animate.js). A piece's colour is a shade (its facets a little
// lighter or darker); the person's hair colour comes per person.
//
// The head is measured by models.js (biped's rig.head): its box and the
// joint it nods at, in our axes (+X the front, +Y up, the left side at −Z).
// The cap of each style is a slice of a low sphere a little larger than the
// head, cut along a hairline: how high it comes at the forehead, over the
// ears and at the nape (heights on the sphere, −1 at its bottom to 1 at its
// top).
import * as THREE from 'three';
import { PART } from './animate.js';
import { DYE, HAIR_STYLES } from './looks.js';
import { hash } from './util.js';

// Each style's cap: how far it stands off the head (a share of the head's
// size), and its hairline.
const CAPS = {
    short: { off: 0.12, front: 0.42, side: 0.16, back: -0.42 },
    long: { off: 0.13, front: 0.4, side: -0.2, back: -0.55 },
    braids: { off: 0.12, front: 0.42, side: 0.02, back: -0.45 },
    bun: { off: 0.11, front: 0.45, side: 0.1, back: -0.4 },
    topknot: { off: 0.09, front: 0.5, side: 0.24, back: -0.3 },
    shaved: { off: 0.035, front: 0.45, side: 0.12, back: -0.42 },
};
const NEAR = Math.cos(0.45); // the head's surface along a way: its points within this angle of it

// Non-indexed triangles of a geometry, moved by m.
function soup(geometry, m) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (m) g.applyMatrix4(m);
    const pos = Float32Array.from(g.attributes.position.array);
    geometry.dispose();
    g.dispose();
    return pos;
}

const matrix = (at, scale = [1, 1, 1]) => new THREE.Matrix4().compose(
    new THREE.Vector3(...at),
    new THREE.Quaternion(),
    new THREE.Vector3(...scale),
);

// A piece of hair of style `style` from triangles, its facets shaded.
function piece(style, name, pos) {
    const n = pos.length / 3;
    const col = new Float32Array(n * 3);
    for (let f = 0; f < n / 3; f++) {
        const shade = 0.88 + 0.16 * (hash(f * 31 + style * 977 + name.length) / 2 ** 32);
        col.fill(shade, f * 9, f * 9 + 9);
    }
    return { name: `hair ${HAIR_STYLES[style]} ${name}`, pos, col, part: new Uint8Array(n).fill(PART.HEAD), dye: DYE.hair + style };
}

// The hairline's height on the sphere at azimuth a (0 the front, ±π the back).
function hairline({ front, side, back }, a) {
    const mean = (front + back) / 2;
    const c0 = (mean + side) / 2;
    const c2 = (mean - side) / 2;
    return c0 + ((front - back) / 2) * Math.cos(a) + c2 * Math.cos(2 * a);
}

// How far the head's surface reaches from its middle along the unit way d:
// the farthest of its points near that way.
function surface(h, d) {
    let best = 0;
    const p = h.pos;
    for (let i = 0; i < p.length; i += 3) {
        const x = p[i] - h.c[0];
        const y = p[i + 1] - h.c[1];
        const z = p[i + 2] - h.c[2];
        const along = x * d[0] + y * d[1] + z * d[2];
        if (along > best && along > NEAR * Math.hypot(x, y, z)) best = along;
    }
    return best || Math.hypot(h.r[0] * d[0], h.r[1] * d[1], h.r[2] * d[2]);
}

// A cap: the faces of a low sphere above the hairline, each corner set off
// the head's own surface (so no facet of the head shows through).
function cap(h, line) {
    const sphere = new THREE.SphereGeometry(1, 10, 7).toNonIndexed();
    const p = sphere.attributes.position.array;
    const off = line.off * (h.r[0] + h.r[1] + h.r[2]) / 3;
    const placed = new Map(); // (corners are shared by faces: each worked out once)
    const corner = (x, y, z) => {
        const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
        let at = placed.get(key);
        if (!at) {
            const e = [x * h.r[0], y * h.r[1], z * h.r[2]];
            const l = Math.hypot(...e) || 1;
            const d = e.map((v) => v / l);
            const r = surface(h, d) + off;
            at = d.map((v, k) => h.c[k] + v * r);
            placed.set(key, at);
        }
        return at;
    };
    const out = [];
    for (let i = 0; i < p.length; i += 9) {
        const cx = (p[i] + p[i + 3] + p[i + 6]) / 3;
        const cy = (p[i + 1] + p[i + 4] + p[i + 7]) / 3;
        const cz = (p[i + 2] + p[i + 5] + p[i + 8]) / 3;
        const l = Math.hypot(cx, cy, cz) || 1;
        if (cy / l < hairline(line, Math.atan2(cz, cx))) continue;
        for (let k = 0; k < 9; k += 3) out.push(...corner(p[i + k], p[i + k + 1], p[i + k + 2]));
    }
    sphere.dispose();
    return Float32Array.from(out);
}

// The head as hair sees it: its middle c and half sizes r (its box), its
// surface (pos), the neck's root.
function measure(head) {
    const { box, joint, pos } = head;
    return {
        c: [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2],
        r: [(box.maxX - box.minX) / 2, (box.maxY - box.minY) / 2, (box.maxZ - box.minZ) / 2],
        pos,
        neck: joint[1],
    };
}

// A convex block from its eight corners (any order of faces: each triangle
// is turned to face away from the middle), as triangles.
const BLOCK = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]];
function block(corners) {
    const m = [0, 1, 2].map((k) => corners.reduce((s, c) => s + c[k], 0) / 8);
    const out = [];
    for (const [a, b, c] of BLOCK) {
        let [A, B, C] = [corners[a], corners[b], corners[c]];
        const u = [0, 1, 2].map((k) => B[k] - A[k]);
        const v = [0, 1, 2].map((k) => C[k] - A[k]);
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const away = [0, 1, 2].reduce((s, k) => s + n[k] * ((A[k] + B[k] + C[k]) / 3 - m[k]), 0);
        if (away < 0) [B, C] = [C, B];
        out.push(...A, ...B, ...C);
    }
    return Float32Array.from(out);
}

// What each style adds to its cap.
const EXTRAS = {
    short: () => [],
    shaved: () => [],
    // Hair falling behind the head to the shoulders: a broad mass down the
    // back, and a narrower lock behind each ear.
    long(h) {
        const top = h.c[1] + 0.15 * h.r[1];
        const bottom = h.neck - 0.2 * h.r[1];
        const out = [];
        for (const [a, size] of [[-0.95, 0.6], [0, 1.25], [0.95, 0.6]]) {
            const dir = [-Math.cos(a), 0, Math.sin(a)];
            const along = [Math.sin(a), 0, Math.cos(a)];
            const corners = [];
            for (const [y, reach, wide] of [[top, 0.86, size], [bottom, 1.04, 1.1 * size]]) {
                for (const w of [-0.5, 0.5]) {
                    for (const t of [-0.16, 0.16]) {
                        corners.push([0, 1, 2].map((k) => (k === 1 ? y
                            : h.c[k] + dir[k] * h.r[k] * (reach + t) + along[k] * w * wide * h.r[2])));
                    }
                }
            }
            out.push([`lock ${a}`, block(corners)]);
        }
        return out;
    },
    // Two braids from behind the ears, over the shoulders to the chest.
    braids(h) {
        const out = [];
        for (const side of [-1, 1]) {
            const knots = 4;
            for (let k = 0; k < knots; k++) {
                const t = k / (knots - 1);
                const at = [
                    h.c[0] - 0.35 * h.r[0] + 0.55 * h.r[0] * t,
                    h.c[1] - 0.25 * h.r[1] - t * (h.c[1] - h.neck + 0.55 * h.r[1]),
                    side * h.r[2] * (0.92 + 0.12 * t),
                ];
                const s = 0.17 * h.r[1] * (1 - 0.15 * t);
                out.push([`braid ${side} ${k}`, soup(new THREE.OctahedronGeometry(1, 0), matrix(at, [s, 1.5 * s, s]))]);
            }
        }
        return out;
    },
    // Gathered in a bun at the back of the head.
    bun: (h) => [['bun', soup(new THREE.IcosahedronGeometry(1, 0),
        matrix([h.c[0] - 0.95 * h.r[0], h.c[1] + 0.42 * h.r[1], 0], [0.42 * h.r[0], 0.4 * h.r[1], 0.42 * h.r[2]]))]],
    // Tied in a knot on the crown.
    topknot: (h) => [
        ['knot tie', soup(new THREE.CylinderGeometry(0.2 * h.r[2], 0.28 * h.r[2], 0.32 * h.r[1], 6),
            matrix([h.c[0] - 0.1 * h.r[0], h.c[1] + 1.08 * h.r[1], 0]))],
        ['knot', soup(new THREE.IcosahedronGeometry(1, 0),
            matrix([h.c[0] - 0.12 * h.r[0], h.c[1] + 1.32 * h.r[1], 0], [0.3 * h.r[2], 0.26 * h.r[1], 0.3 * h.r[2]]))],
    ],
};

// Every style's pieces for a head (models.js biped's rig.head).
export function hairPieces(head) {
    const h = measure(head);
    const out = [];
    HAIR_STYLES.forEach((name, style) => {
        out.push(piece(style, 'cap', cap(h, CAPS[name])));
        for (const [what, pos] of EXTRAS[name](h)) out.push(piece(style, what, pos));
    });
    return out;
}
