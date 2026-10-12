// Creatures as instanced meshes: one mesh per species, so a thousand grazers
// are a single draw call. Every frame each individual's matrix (standing on
// the ground, turned to its heading, scaled) is written straight into the
// instance buffer; people also get their tribe's colour per instance.
//
// The world wraps, so an individual is drawn at each of its copies the camera
// can see: usually just one, but from high above the map shows the world's
// neighbouring copies too, and they are not empty.
import * as THREE from 'three';
import { COLORS } from '../render.js';
import { herbivoreShape, carnivoreShape, personShape } from './shapes.js';
import { wrapDelta } from './util.js';

// size: rough length in world units; minPx: in the map view, bodies grow with
// distance so they stay at least this many pixels long; center: height of the
// middle of the body (what a click aims at).
export const SPECIES = {
    herbivore: { size: 5, minPx: 6, center: 2.0, ring: 4.5 },
    carnivore: { size: 7, minPx: 11, center: 1.7, ring: 6 },
    human: { size: 4.8, minPx: 10, center: 2.4, ring: 4 },
};
const CHILD = 0.62; // a child's size, relative to an adult

// Is a ball of radius r at (x, y, z) wholly outside one of the view's planes?
function offScreen(P, x, y, z, r) {
    for (let p = 0; p < 24; p += 4) if (P[p] * x + P[p + 1] * y + P[p + 2] * z + P[p + 3] < -r) return true;
    return false;
}

// One species: an InstancedMesh that grows when it runs out of room.
class Herd {
    constructor(scene, geometry, material, tinted) {
        this.scene = scene;
        this.geometry = geometry;
        this.material = material;
        this.tinted = tinted;
        this.capacity = 0;
        this.mesh = null;
        this.grow(1024);
    }

    grow(need) {
        const cap = Math.max(need, Math.ceil(this.capacity * 1.6), 256);
        const mesh = new THREE.InstancedMesh(this.geometry, this.material, cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (this.tinted) {
            mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
            mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
        // Instances move every frame, so precomputed bounds would be stale;
        // instead each one is checked against the view as it is written.
        mesh.frustumCulled = false;
        mesh.count = 0;
        if (this.mesh) {
            mesh.instanceMatrix.array.set(this.mesh.instanceMatrix.array);
            if (this.tinted) mesh.instanceColor.array.set(this.mesh.instanceColor.array);
            this.scene.remove(this.mesh);
            this.mesh.dispose();
        }
        this.scene.add(mesh);
        this.mesh = mesh;
        this.capacity = cap;
        this.matrices = mesh.instanceMatrix.array;
        this.colors = this.tinted ? mesh.instanceColor.array : null;
    }

    commit(count) {
        const { mesh } = this;
        mesh.count = count;
        if (!count) return;
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (this.tinted) {
            mesh.instanceColor.clearUpdateRanges();
            mesh.instanceColor.addUpdateRange(0, count * 3);
            mesh.instanceColor.needsUpdate = true;
        }
    }
}

export class Creatures {
    constructor(scene) {
        const mat = (color) => new THREE.MeshLambertMaterial({ color, vertexColors: true, flatShading: true });
        this.herds = {
            herbivore: new Herd(scene, herbivoreShape(), mat(COLORS.herbivore), false),
            carnivore: new Herd(scene, carnivoreShape(), mat(COLORS.carnivore), false),
            human: new Herd(scene, personShape(), mat('#ffffff'), true),
        };
        this.tribeColors = new Map(); // tribe id → linear RGB
        this.color = new THREE.Color();
        // Where each drawn instance's body is, for clicks.
        this.pickN = 0;
        this.pickPos = new Float32Array(4096 * 3);
        this.pickId = new Float64Array(4096);
        this.vp = new THREE.Matrix4();
    }

    // A new world: forget the tribes' colours (it reuses their ids).
    attach() {
        this.tribeColors.clear();
        this.pickN = 0;
    }

    tribeColor(world, id) {
        let c = this.tribeColors.get(id);
        if (!c) {
            const tribe = world.tribeById.get(id) ?? world.fallen.find((t) => t.id === id);
            this.color.set(tribe ? tribe.color : COLORS.herbivore); // three.js converts to linear
            c = [this.color.r, this.color.g, this.color.b];
            this.tribeColors.set(id, c);
        }
        return c;
    }

    // Write all three species. `hideId`: someone not to draw (whoever the
    // first-person camera is looking out of).
    update(world, view, ground, hideId) {
        if (this.tribeColors.size > 64) this.tribeColors.clear();
        this.pickN = 0;
        this.write(world, world.herbivores, 'herbivore', view, ground, hideId, 0);
        this.write(world, world.carnivores, 'carnivore', view, ground, hideId, 0);
        this.write(world, world.humans, 'human', view, ground, hideId, world.p.human.maturity);
    }

    write(world, pop, kind, view, ground, hideId, maturity) {
        const herd = this.herds[kind];
        const spec = SPECIES[kind];
        const { W, H, fx, fz, minX, maxX, minZ, maxZ, camX, camY, camZ, planes } = view;
        const grow = (view.unitPx * spec.minPx * view.mapness) / spec.size; // scale per unit of distance
        const near2 = view.personalSpace * view.personalSpace;
        const { x, y, heading, id, age, tribe } = pop;
        let te = herd.matrices;
        let tc = herd.colors;
        let k = 0;
        for (let i = 0; i < pop.n; i++) {
            if (id[i] === hideId) continue;
            // Its copies in view: offsets dx + ax·W with ax in [ax0, ax1].
            const dx = wrapDelta(x[i] - fx, W);
            const ax0 = Math.ceil((minX - dx) / W);
            const ax1 = Math.floor((maxX - dx) / W);
            if (ax0 > ax1) continue;
            const dz = wrapDelta(y[i] - fz, H);
            const az0 = Math.ceil((minZ - dz) / H);
            const az1 = Math.floor((maxZ - dz) / H);
            if (az0 > az1) continue;

            const gy = ground(x[i], y[i]);
            const c = Math.cos(heading[i]);
            const s = Math.sin(heading[i]);
            const base = maturity && age[i] < maturity ? CHILD : 1;
            const rgb = tc ? this.tribeColor(world, tribe[i]) : null;
            for (let ax = ax0; ax <= ax1; ax++) {
                for (let az = az0; az <= az1; az++) {
                    const rx = dx + ax * W;
                    const rz = dz + az * H;
                    const ex = rx - camX;
                    const ey = gy - camY;
                    const ez = rz - camZ;
                    const d2 = ex * ex + ey * ey + ez * ez;
                    if (d2 < near2) continue; // in first person, a neighbour's flank would fill the screen
                    let sc = base;
                    if (grow > 0) {
                        const up = Math.sqrt(d2) * grow;
                        if (up > 1) sc *= up;
                    }
                    const cy = gy + spec.center * sc;
                    if (offScreen(planes, rx, cy, rz, spec.size * sc)) continue;
                    if (k >= herd.capacity) {
                        herd.grow(k + 1);
                        te = herd.matrices;
                        tc = herd.colors;
                    }
                    // A turn by the heading about the vertical, a uniform
                    // scale, and a move: model +X ends up along (cos h, sin h)
                    // in world (x, y), which is three.js (X, Z).
                    const o = k * 16;
                    te[o] = sc * c;
                    te[o + 1] = 0;
                    te[o + 2] = sc * s;
                    te[o + 3] = 0;
                    te[o + 4] = 0;
                    te[o + 5] = sc;
                    te[o + 6] = 0;
                    te[o + 7] = 0;
                    te[o + 8] = -sc * s;
                    te[o + 9] = 0;
                    te[o + 10] = sc * c;
                    te[o + 11] = 0;
                    te[o + 12] = rx;
                    te[o + 13] = gy;
                    te[o + 14] = rz;
                    te[o + 15] = 1;
                    if (rgb) {
                        tc[k * 3] = rgb[0];
                        tc[k * 3 + 1] = rgb[1];
                        tc[k * 3 + 2] = rgb[2];
                    }
                    this.remember(rx, cy, rz, id[i]);
                    k++;
                }
            }
        }
        herd.commit(k);
    }

    remember(x, y, z, id) {
        const n = this.pickN;
        if (n >= this.pickId.length) {
            const pos = new Float32Array(n * 6);
            pos.set(this.pickPos);
            const ids = new Float64Array(n * 2);
            ids.set(this.pickId);
            this.pickPos = pos;
            this.pickId = ids;
        }
        this.pickPos[n * 3] = x;
        this.pickPos[n * 3 + 1] = y;
        this.pickPos[n * 3 + 2] = z;
        this.pickId[n] = id;
        this.pickN = n + 1;
    }

    // The id of whoever was drawn nearest to pixel (px, py), within 16 px, or 0.
    pick(camera, w, h, px, py) {
        const e = this.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
        const P = this.pickPos;
        let best = 0;
        let bestD2 = 16 * 16;
        for (let k = 0; k < this.pickN; k++) {
            const x = P[k * 3];
            const y = P[k * 3 + 1];
            const z = P[k * 3 + 2];
            const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
            if (cw <= 0) continue; // behind the camera
            const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw + 1) * 0.5 * w;
            const sy = (1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw) * 0.5 * h;
            const d2 = (sx - px) * (sx - px) + (sy - py) * (sy - py);
            if (d2 < bestD2) {
                bestD2 = d2;
                best = this.pickId[k];
            }
        }
        return best;
    }
}
