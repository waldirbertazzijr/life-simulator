// Low-poly bodies for the creatures, built in code from a few primitives.
//
// Each shape is one BufferGeometry in which every triangle has its own three
// vertices, so the normal of each vertex is its face's normal: that is what
// gives the faceted, flat-shaded look. Every vertex also carries a grey
// `color` (a shade) so parts of one body can be lighter or darker while the
// material (or, for people, each instance) supplies the hue.
//
// Bodies move (animate.js), so every vertex also says which part of the body
// it belongs to and where that part's joint is (the `rig` attribute: joint x,
// y, z, and the part). Legs reach up inside the body, so a swinging leg opens
// no gap at the hip.
//
// Units are world units. +X is the front, +Y is up, the feet are at y = 0;
// an animal's left side is −Z.
import * as THREE from 'three';
import { GAIT, PART } from './animate.js';

// Where each species' torso turns (and its head and arms with it), and where
// the whole body turns: the joints the vertex shader needs besides each
// part's own.
export const RIGS = {
    herbivore: { torso: [-0.15, 2.05, 0], root: [-0.15, 2.05, 0] },
    carnivore: { torso: [-0.15, 2.0, 0], root: [-0.15, 2.0, 0] },
    human: { torso: [0, GAIT.human.leg, 0], root: [0, GAIT.human.leg, 0] },
};

// One primitive, moved/rotated/scaled into place, with a shade, as part `of`
// a body whose joint is at `joint`.
export function part(geometry, { at = [0, 0, 0], scale = [1, 1, 1], rot = [0, 0, 0], shade = 1, of = PART.TORSO, joint = [0, 0, 0] } = {}) {
    const m = new THREE.Matrix4().compose(
        new THREE.Vector3(...at),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
        new THREE.Vector3(...scale),
    );
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    geometry.dispose();
    g.applyMatrix4(m);
    return { g, shade, of, joint };
}

// A convex solid from its corners and triangles, given in any winding: each
// triangle is turned to face away from the centre, so it is never culled.
function solid(points, faces) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const [x, y, z] of points) {
        cx += x / points.length;
        cy += y / points.length;
        cz += z / points.length;
    }
    const pos = [];
    for (const [a, b, c] of faces) {
        const A = points[a];
        let B = points[b];
        let C = points[c];
        const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
        const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const mx = (A[0] + B[0] + C[0]) / 3 - cx;
        const my = (A[1] + B[1] + C[1]) / 3 - cy;
        const mz = (A[2] + B[2] + C[2]) / 3 - cz;
        if (nx * mx + ny * my + nz * mz < 0) [B, C] = [C, B];
        pos.push(...A, ...B, ...C);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
}

// Concatenate parts into one geometry with face normals, shades and the rig.
export function merge(parts) {
    let n = 0;
    for (const p of parts) n += p.g.attributes.position.count;
    const position = new Float32Array(n * 3);
    const color = new Float32Array(n * 3);
    const rig = new Float32Array(n * 4);
    let o = 0;
    for (const p of parts) {
        const a = p.g.attributes.position.array;
        const count = p.g.attributes.position.count;
        position.set(a, o * 3);
        color.fill(p.shade, o * 3, o * 3 + a.length);
        for (let v = o; v < o + count; v++) rig.set([...p.joint, p.of], v * 4);
        o += count;
        p.g.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.setAttribute('rig', new THREE.BufferAttribute(rig, 4));
    g.computeVertexNormals(); // unshared vertices: each gets its face's normal
    g.computeBoundingSphere();
    return g;
}

// A square leg standing at (x, z), from the ground up to `top` (inside the
// body), turning at its hip `hip` high.
const leg = (x, z, hip, top, w, shade, of) => part(new THREE.BoxGeometry(w, top, w), { at: [x, top / 2, z], shade, of, joint: [x, hip, z] });

// A grazer: a round woolly body on four short legs, head low and forward.
// About 5 long and 3.5 tall (the 2D dot has a radius of 2.3).
export function herbivoreShape() {
    const torso = RIGS.herbivore.torso;
    const hip = GAIT.herbivore.leg;
    return merge([
        part(new THREE.IcosahedronGeometry(1, 1), { at: [-0.15, 2.05, 0], scale: [1.95, 1.3, 1.4], joint: torso }),
        part(new THREE.IcosahedronGeometry(1, 0), { at: [1.95, 2.45, 0], scale: [0.95, 0.72, 0.68], shade: 0.78, of: PART.HEAD, joint: [1.2, 2.45, 0] }),
        leg(1.05, -0.68, hip, 1.9, 0.42, 0.62, PART.LEG_FL),
        leg(1.05, 0.68, hip, 1.9, 0.42, 0.62, PART.LEG_FR),
        leg(-1.25, -0.68, hip, 1.9, 0.42, 0.62, PART.LEG_BL),
        leg(-1.25, 0.68, hip, 1.9, 0.42, 0.62, PART.LEG_BR),
    ]);
}

// A predator: a lean body, a long wedge of a head ending in a sharp snout,
// and a tail held out behind, so its heading reads at a glance (like the 2D
// triangle). About 7 long.
export function carnivoreShape() {
    const torso = RIGS.carnivore.torso;
    const neck = [1.25, 2.2, 0];
    const hip = GAIT.carnivore.leg;
    const head = { of: PART.HEAD, joint: neck };
    // The head: a five-sided wedge, wide at the skull and pointed at the nose.
    const skull = [[1.3, 2.75, 0], [1.4, 2.0, 0.55], [1.4, 2.0, -0.55], [1.2, 1.75, 0]];
    const nose = [3.4, 2.05, 0];
    const wedge = solid([...skull, nose], [
        [0, 1, 4], [1, 3, 4], [3, 2, 4], [2, 0, 4], [0, 2, 1], [1, 2, 3],
    ]);
    return merge([
        part(new THREE.IcosahedronGeometry(1, 0), { at: [-0.15, 2.0, 0], scale: [2.15, 0.9, 0.78], joint: torso }),
        { g: wedge, shade: 0.95, ...head },
        part(new THREE.ConeGeometry(0.2, 0.65, 4), { at: [1.4, 2.95, 0.28], shade: 0.8, ...head }), // ears
        part(new THREE.ConeGeometry(0.2, 0.65, 4), { at: [1.4, 2.95, -0.28], shade: 0.8, ...head }),
        part(new THREE.ConeGeometry(0.22, 1.4, 4), { at: [-2.75, 2.25, 0], rot: [0, 0, Math.PI / 2 - 0.45], shade: 0.8, joint: torso }),
        leg(1.2, -0.36, hip, 1.85, 0.3, 0.68, PART.LEG_FL),
        leg(1.2, 0.36, hip, 1.85, 0.3, 0.68, PART.LEG_FR),
        leg(-1.35, -0.4, hip, 1.85, 0.3, 0.68, PART.LEG_BL),
        leg(-1.35, 0.4, hip, 1.85, 0.3, 0.68, PART.LEG_BR),
    ]);
}

// A drying rack: two A-frames of poles carrying a ridge pole, about 6 long
// (along X) and 3.6 tall. Meat hangs from the ridge, RACK_RIDGE high.
export const RACK_RIDGE = 3.55;
export const RACK_HALF = 2.4; // meat hangs along the ridge from −RACK_HALF to RACK_HALF
export function rackShape() {
    const h = RACK_RIDGE + 0.15;
    const foot = 1.1;
    const lean = Math.atan2(foot, h);
    const pole = Math.hypot(foot, h);
    const legs = [];
    for (const x of [-2.8, 2.8]) {
        for (const z of [-1, 1]) {
            // From its foot (z · foot) up to the top of the frame (z = 0).
            legs.push(part(new THREE.BoxGeometry(0.18, pole, 0.18), { at: [x, h / 2, (z * foot) / 2], rot: [-z * lean, 0, 0], shade: 0.78 }));
        }
    }
    return merge([
        ...legs,
        part(new THREE.BoxGeometry(6.4, 0.16, 0.16), { at: [0, RACK_RIDGE, 0], shade: 0.95 }),
    ]);
}

// A strip of meat hanging from a tie, the tie's top at the origin.
export function meatShape() {
    return merge([
        part(new THREE.BoxGeometry(0.05, 0.25, 0.05), { at: [0, -0.12, 0], shade: 0.55 }),
        part(new THREE.IcosahedronGeometry(0.5, 0), { at: [0, -0.8, 0], scale: [0.48, 1.1, 0.22], shade: 1 }),
    ]);
}

// A person: a tapered six-sided torso (wider across the shoulders than front
// to back) on two legs, two arms hanging from the shoulders, and a round
// head. About 4.8 tall; children are scaled.
export function personShape() {
    const hip = GAIT.human.leg;
    const torso = RIGS.human.torso;
    const shoulder = 3.45;
    const arm = 1.75;
    const limb = (w, h, d, at, shade, of, joint) => part(new THREE.BoxGeometry(w, h, d), { at, shade, of, joint });
    return merge([
        part(new THREE.CylinderGeometry(0.78, 0.62, 2.05, 6), { at: [0, 2.75, 0], scale: [0.62, 1, 1], shade: 0.82, joint: torso }),
        part(new THREE.IcosahedronGeometry(0.62, 0), { at: [0.05, 4.15, 0], of: PART.HEAD, joint: [0, 3.75, 0] }),
        limb(0.36, 2.05, 0.4, [0, 1.025, -0.3], 0.6, PART.LEG_FL, [0, hip, -0.3]),
        limb(0.36, 2.05, 0.4, [0, 1.025, 0.3], 0.6, PART.LEG_FR, [0, hip, 0.3]),
        limb(0.26, arm, 0.26, [0, shoulder + 0.1 - arm / 2, -0.84], 0.74, PART.ARM_L, [0, shoulder, -0.84]),
        limb(0.26, arm, 0.26, [0, shoulder + 0.1 - arm / 2, 0.84], 0.74, PART.ARM_R, [0, shoulder, 0.84]),
    ]);
}
