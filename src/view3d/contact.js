// Soft darkness where things meet the ground (the High setting, graphics.js):
// the light from the sky reaches less of the ground under a tree's crown
// and under a body. Two cheap fakes, no screen-space pass:
//
// - Under the trees: baked once per world into a texture over the whole
//   ground (CELL units a texel), each tree a soft dark pool as wide as its
//   crown, darker where crowns crowd (the forest floor). The ground takes it
//   as three.js's ambient-occlusion map (aoMap: it dims only the sky's light,
//   so a patch of sun between the trees stays bright). The ground's uv is
//   the world's, so the texture wraps with it.
// - Under the creatures: a soft dark oval under each body drawn near enough
//   (one instanced mesh, one draw call), lying on the ground's slope, long
//   for a sheep or a wolf, round for a person. Read from the creatures'
//   instances as creatures.js wrote them (their place, heading and size).
import * as THREE from 'three';
import { KINDS } from './animate.js';

const CELL = 1.5;        // world units per texel of the trees' darkness
const POOL = 1.3;        // a tree's pool reaches this many times its crown's radius
const DEPTH = 0.42;      // how dark the middle of one tree's pool is (of the sky's light)
const FLOOR = 0.32;      // and no darker than this, however crowded
const BLOB = {           // per species: the oval's half-length and half-width (at scale 1), and how dark its middle
    herbivore: [2.3, 1.35, 0.42],
    carnivore: [2.6, 1.1, 0.4],
    human: [1.05, 1.05, 0.36],
};
const NEAR = 260;        // bodies further than this from the camera get none
const CAP = 1024;

// The trees' darkness over a world W × H (forest.js trees()), as a texture.
export function treeShade(W, H, trees) {
    const cols = Math.max(1, Math.round(W / CELL));
    const rows = Math.max(1, Math.round(H / CELL));
    const cw = W / cols;
    const ch = H / rows;
    const light = new Float32Array(cols * rows).fill(1);
    trees((x, y, crown) => {
        const r = crown * POOL;
        const i0 = Math.floor((x - r) / cw);
        const i1 = Math.ceil((x + r) / cw);
        const j0 = Math.floor((y - r) / ch);
        const j1 = Math.ceil((y + r) / ch);
        for (let j = j0; j <= j1; j++) {
            const dy = (j + 0.5) * ch - y;
            const row = (((j % rows) + rows) % rows) * cols;
            for (let i = i0; i <= i1; i++) {
                const dx = (i + 0.5) * cw - x;
                const q = (dx * dx + dy * dy) / (r * r);
                if (q >= 1) continue;
                const k = row + (((i % cols) + cols) % cols);
                light[k] *= 1 - DEPTH * (1 - q) * (1 - q);
            }
        }
    });
    const bytes = new Uint8Array(cols * rows);
    for (let k = 0; k < bytes.length; k++) bytes[k] = Math.round(255 * Math.max(FLOOR, light[k]));
    const tex = new THREE.DataTexture(bytes, cols, rows, THREE.RedFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
}

// A soft round spot: dark in the middle, nothing at the rim.
function spot() {
    const n = 32;
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const dx = (x + 0.5) / n * 2 - 1;
            const dy = (y + 0.5) / n * 2 - 1;
            const q = Math.min(1, dx * dx + dy * dy);
            data.fill(Math.round(255 * (1 - q) ** 2), (y * n + x) * 4, (y * n + x) * 4 + 4);
        }
    }
    const tex = new THREE.DataTexture(data, n, n);
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
}

export class Contact {
    constructor(scene) {
        const geometry = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
        this.material = new THREE.MeshBasicMaterial({
            color: '#000000', alphaMap: spot(), transparent: true, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
        });
        // Its own darkness per oval, in the instance colour's red.
        this.material.onBeforeCompile = (shader) => {
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\ndiffuseColor.a *= vColor.r;')
                .replace('#include <color_fragment>', '');
        };
        this.material.customProgramCacheKey = () => 'contact';
        this.mesh = new THREE.InstancedMesh(geometry, this.material, CAP);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 1; // (after the ground, which it darkens)
        this.mesh.count = 0;
        this.mesh.visible = false;
        scene.add(this.mesh);
        this.scene = scene;
        this.on = false;
        this.ground = null;   // terrain-mesh.js Ground
        this.shade = null;    // the trees' darkness (treeShade), for the world it was baked for
        this.bakedFor = null;
        this.n = new THREE.Vector3();
        this.stats = { blobs: 0, bakeMs: 0 };
    }

    // On (High) or off. `world`, `ground`, `forest`: the view's, to bake the
    // trees' darkness for (once per world, when first needed).
    set(on, world, ground, forest) {
        this.on = on;
        this.ground = ground;
        this.mesh.visible = false;
        if (on && world && this.bakedFor !== forest.count + ':' + world.seed) {
            const t0 = performance.now();
            this.shade?.dispose();
            this.shade = treeShade(world.width, world.height, (fn) => forest.trees(fn));
            this.bakedFor = forest.count + ':' + world.seed;
            this.stats.bakeMs = +(performance.now() - t0).toFixed(1);
        }
        const material = ground.material;
        const map = on ? this.shade : null;
        if (material.aoMap !== map) {
            material.aoMap = map;
            material.needsUpdate = true;
        }
    }

    // Each frame, after the creatures are written: an oval under each body
    // near enough. `heightAt(x, y)`: the ground (world coordinates).
    update(creatures, view, heightAt) {
        const mesh = this.mesh;
        if (!this.on || view.mapness > 0.5 && view.dist > NEAR) {
            mesh.visible = false;
            this.stats.blobs = 0;
            return;
        }
        const m = mesh.instanceMatrix.array;
        const c = mesh.instanceColor.array;
        const { camX, camY, camZ, fx, fz } = view;
        const n = this.n;
        let k = 0;
        for (const kind of KINDS) {
            const [long, wide, dark] = BLOB[kind];
            for (const herd of [...creatures.herds[kind], ...creatures.far[kind]]) {
                if (!herd) continue;
                const te = herd.matrices;
                for (let h = 0; h < herd.n && k < CAP; h++) {
                    const o = h * 16;
                    const x = te[o + 12];
                    const y = te[o + 13];
                    const z = te[o + 14];
                    const ex = x - camX;
                    const ey = y - camY;
                    const ez = z - camZ;
                    if (ex * ex + ey * ey + ez * ez > NEAR * NEAR) continue;
                    const sc = te[o + 5];
                    if (!(sc > 0)) continue;
                    // The ground's slope here, and the body's heading along it.
                    const wx = x + fx;
                    const wz = z + fz;
                    n.set(heightAt(wx - 1, wz) - heightAt(wx + 1, wz), 2, heightAt(wx, wz - 1) - heightAt(wx, wz + 1)).normalize();
                    const hx = te[o] / sc;
                    const hz = te[o + 2] / sc;
                    const along = hx * n.x + hz * n.z;
                    let ax = hx - n.x * along;
                    let ay = -n.y * along;
                    let az = hz - n.z * along;
                    const al = Math.hypot(ax, ay, az) || 1;
                    ax /= al;
                    ay /= al;
                    az /= al;
                    // across = n × along
                    const bx = n.y * az - n.z * ay;
                    const by = n.z * ax - n.x * az;
                    const bz = n.x * ay - n.y * ax;
                    const p = k * 16;
                    const L = long * sc;
                    const Wd = wide * sc;
                    m[p] = ax * L; m[p + 1] = ay * L; m[p + 2] = az * L; m[p + 3] = 0;
                    m[p + 4] = n.x; m[p + 5] = n.y; m[p + 6] = n.z; m[p + 7] = 0;
                    m[p + 8] = -bx * Wd; m[p + 9] = -by * Wd; m[p + 10] = -bz * Wd; m[p + 11] = 0;
                    m[p + 12] = x; m[p + 13] = heightAt(wx, wz) + 0.06; m[p + 14] = z; m[p + 15] = 1;
                    c[k * 3] = dark;
                    k++;
                }
            }
        }
        mesh.count = k;
        mesh.visible = k > 0;
        this.stats.blobs = k;
        if (k) {
            for (const [a, size] of [[mesh.instanceMatrix, 16], [mesh.instanceColor, 3]]) {
                a.clearUpdateRanges();
                a.addUpdateRange(0, k * size);
                a.needsUpdate = true;
            }
        }
    }
}
