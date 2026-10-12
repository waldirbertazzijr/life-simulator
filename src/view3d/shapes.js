// Low-poly bodies for the creatures, built in code from a few primitives.
//
// Each shape is one BufferGeometry in which every triangle has its own three
// vertices, so the normal of each vertex is its face's normal: that is what
// gives the faceted, flat-shaded look. Every vertex also carries a grey
// `color` (a shade) so parts of one body can be lighter or darker while the
// material (or, for people, each instance) supplies the hue.
//
// Units are world units. +X is the front, +Y is up, the feet are at y = 0.
import * as THREE from 'three';

// One primitive, moved/rotated/scaled into place, with a shade.
function part(geometry, { at = [0, 0, 0], scale = [1, 1, 1], rot = [0, 0, 0], shade = 1 } = {}) {
    const m = new THREE.Matrix4().compose(
        new THREE.Vector3(...at),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
        new THREE.Vector3(...scale),
    );
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    geometry.dispose();
    g.applyMatrix4(m);
    return { g, shade };
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

// Concatenate parts into one geometry with face normals and shades.
function merge(parts) {
    let n = 0;
    for (const p of parts) n += p.g.attributes.position.count;
    const position = new Float32Array(n * 3);
    const color = new Float32Array(n * 3);
    let o = 0;
    for (const p of parts) {
        const a = p.g.attributes.position.array;
        position.set(a, o * 3);
        color.fill(p.shade, o * 3, o * 3 + a.length);
        o += p.g.attributes.position.count;
        p.g.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.computeVertexNormals(); // unshared vertices: each gets its face's normal
    g.computeBoundingSphere();
    return g;
}

const leg = (x, z, h, w, shade) => part(new THREE.BoxGeometry(w, h, w), { at: [x, h / 2, z], shade });

// A grazer: a round woolly body on four short legs, head low and forward.
// About 5 long and 3.5 tall (the 2D dot has a radius of 2.3).
export function herbivoreShape() {
    return merge([
        part(new THREE.IcosahedronGeometry(1, 1), { at: [-0.15, 2.05, 0], scale: [1.95, 1.3, 1.4] }),
        part(new THREE.IcosahedronGeometry(1, 0), { at: [1.95, 2.45, 0], scale: [0.95, 0.72, 0.68], shade: 0.78 }),
        leg(1.05, 0.68, 1.15, 0.42, 0.62),
        leg(1.05, -0.68, 1.15, 0.42, 0.62),
        leg(-1.25, 0.68, 1.15, 0.42, 0.62),
        leg(-1.25, -0.68, 1.15, 0.42, 0.62),
    ]);
}

// A predator: a lean body, a long wedge of a head ending in a sharp snout,
// and a tail held out behind, so its heading reads at a glance (like the 2D
// triangle). About 7 long.
export function carnivoreShape() {
    // The head: a five-sided wedge, wide at the skull and pointed at the nose.
    const skull = [[1.3, 2.75, 0], [1.4, 2.0, 0.55], [1.4, 2.0, -0.55], [1.2, 1.75, 0]];
    const nose = [3.4, 2.05, 0];
    const head = solid([...skull, nose], [
        [0, 1, 4], [1, 3, 4], [3, 2, 4], [2, 0, 4], [0, 2, 1], [1, 2, 3],
    ]);
    return merge([
        part(new THREE.IcosahedronGeometry(1, 0), { at: [-0.15, 2.0, 0], scale: [2.15, 0.9, 0.78] }),
        { g: head, shade: 0.95 },
        part(new THREE.ConeGeometry(0.2, 0.65, 4), { at: [1.4, 2.95, 0.28], shade: 0.8 }), // ears
        part(new THREE.ConeGeometry(0.2, 0.65, 4), { at: [1.4, 2.95, -0.28], shade: 0.8 }),
        part(new THREE.ConeGeometry(0.22, 1.4, 4), { at: [-2.75, 2.25, 0], rot: [0, 0, Math.PI / 2 - 0.45], shade: 0.8 }),
        leg(1.2, 0.36, 1.45, 0.3, 0.68),
        leg(1.2, -0.36, 1.45, 0.3, 0.68),
        leg(-1.35, 0.4, 1.45, 0.3, 0.68),
        leg(-1.35, -0.4, 1.45, 0.3, 0.68),
    ]);
}

// A person: upright, a tapered six-sided body (wider across the shoulders
// than front to back) and a round head. About 4.8 tall; children are scaled.
export function personShape() {
    return merge([
        part(new THREE.CylinderGeometry(0.72, 0.95, 3.3, 6), { at: [0, 1.65, 0], scale: [0.72, 1, 1], shade: 0.82 }),
        part(new THREE.IcosahedronGeometry(0.72, 0), { at: [0.05, 4.05, 0], shade: 1 }),
    ]);
}
