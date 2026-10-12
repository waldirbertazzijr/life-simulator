// The ground: the shape of the land and the grass on it.
//
// The whole world is one mesh: a grid laid over the terrain's height nodes
// (or a single flat square when there is no terrain). Because the world wraps,
// that mesh is drawn as several copies side by side, as many as the camera can
// see (usually 3×3 or fewer), so its edge is never in view. All copies share
// one geometry, one material and one texture.
//
// The texture is the grass: one texel per grass patch, recoloured every few
// frames with the same palette and the same soft blur as the 2D map. The
// grass grid (10 units) is finer than the height grid (~20), so colour comes
// from the texture and shape from the mesh. Rock on steep or high ground and
// the dark beds of lakes come from the terrain and are baked into the same
// texture once; a flat, slightly see-through sheet at sea level is the water.
import * as THREE from 'three';
import { COLORS } from '../render.js';

const ROCK = COLORS.rock;        // muted warm grey, as on the 2D map
const SHORE = [44, 56, 52];      // lake bed near the shore...
const DEEP = [20, 28, 32];       // ...and where it is deep
const WATER = '#2e4a56';
const REFRESH = 6;               // frames between grass texture updates
const MAX_TILES = 25;

const smoothstep = (a, b, v) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

// Grass amount (0..255) → colour, as in the 2D view.
function grassPalette() {
    const lut = new Uint8Array(256 * 3);
    const [r0, g0, b0] = COLORS.bare;
    const [r1, g1, b1] = COLORS.lush;
    for (let i = 0; i < 256; i++) {
        const t = Math.pow(i / 255, 0.8);
        lut[i * 3] = Math.round(r0 + (r1 - r0) * t);
        lut[i * 3 + 1] = Math.round(g0 + (g1 - g0) * t);
        lut[i * 3 + 2] = Math.round(b0 + (b1 - b0) * t);
    }
    return lut;
}

// One copy of the world's ground, from the terrain's height nodes. The grid
// gets one extra row and column (copies of the first), so copies meet exactly.
function terrainGeometry(terrain) {
    const { cols, rows, cellW, cellH, height } = terrain;
    const nx = cols + 1;
    const nz = rows + 1;
    const position = new Float32Array(nx * nz * 3);
    const uv = new Float32Array(nx * nz * 2);
    for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
            const v = j * nx + i;
            position[v * 3] = i * cellW;
            position[v * 3 + 1] = height[(i % cols) + (j % rows) * cols];
            position[v * 3 + 2] = j * cellH;
            uv[v * 2] = i / cols;
            uv[v * 2 + 1] = j / rows;
        }
    }
    const index = new (nx * nz > 65535 ? Uint32Array : Uint16Array)(cols * rows * 6);
    let o = 0;
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const a = j * nx + i;
            const b = a + 1;
            const c = a + nx;
            const d = c + 1;
            index[o++] = a; index[o++] = c; index[o++] = b; // counter-clockwise seen from above
            index[o++] = b; index[o++] = c; index[o++] = d;
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
}

function flatGeometry(width, height) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, width, 0, 0, 0, 0, height, width, 0, height], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    g.computeBoundingSphere();
    return g;
}

export class Ground {
    constructor(scene, gl) {
        this.scene = scene;
        this.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
        this.material = new THREE.MeshLambertMaterial({ flatShading: true });
        this.tiles = [];
        this.geometry = null;
        this.texture = null;
        this.palette = grassPalette();
        this.water = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
            new THREE.MeshLambertMaterial({ color: WATER, transparent: true, opacity: 0.82, depthWrite: false }),
        );
        this.water.visible = false;
        this.water.frustumCulled = false;
        scene.add(this.water);
    }

    attach(world, terrain) {
        const { cols, rows } = world.grass;
        this.cols = cols;
        this.rows = rows;
        this.blurA = new Float32Array(cols * rows);
        this.blurB = new Float32Array(cols * rows);
        this.pixels = new Uint8Array(cols * rows * 4);

        this.texture?.dispose();
        const tex = new THREE.DataTexture(this.pixels, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping; // the world wraps, so the grass blends across its edge
        tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.LinearFilter; // a soft meadow rather than squares
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy = this.anisotropy;
        this.texture = tex;
        this.material.map = tex;
        this.material.needsUpdate = true;

        this.geometry?.dispose();
        this.geometry = terrain ? terrainGeometry(terrain) : flatGeometry(world.width, world.height);
        for (const t of this.tiles) t.geometry = this.geometry;

        this.bakeTerrain(world, terrain);
        this.water.visible = !!terrain;
        this.seaLevel = terrain ? terrain.seaLevel : 0;
        this.frame = 0;
        this.refresh(world);
    }

    // Per grass patch, once: how much rock shows (steep or high ground) and
    // how deep the water is (−1 on dry land).
    bakeTerrain(world, terrain) {
        const n = this.cols * this.rows;
        this.rock = new Float32Array(n);
        this.depth = new Float32Array(n).fill(-1);
        if (!terrain) return;
        const { cellW, cellH } = world.grass;
        const W = world.width;
        const H = world.height;
        const at = (x, y) => terrain.heightAt(((x % W) + W) % W, ((y % H) + H) % H);
        let top = 0;
        for (const h of terrain.height) if (h > top) top = h;
        const sea = terrain.seaLevel;
        const high0 = sea + 0.62 * (top - sea);
        const high1 = sea + 0.9 * (top - sea);
        const d = Math.max(terrain.cellW, terrain.cellH);
        for (let j = 0; j < this.rows; j++) {
            for (let i = 0; i < this.cols; i++) {
                const k = j * this.cols + i;
                const x = (i + 0.5) * cellW;
                const y = (j + 0.5) * cellH;
                const h = at(x, y);
                if (h < sea) {
                    this.depth[k] = sea - h;
                    continue;
                }
                const sx = (at(x + d, y) - at(x - d, y)) / (2 * d);
                const sy = (at(x, y + d) - at(x, y - d)) / (2 * d);
                const slope = Math.sqrt(sx * sx + sy * sy); // rise per unit run
                this.rock[k] = 0.7 * Math.max(smoothstep(0.55, 1.1, slope), smoothstep(high0, high1, h));
            }
        }
    }

    // Each patch is grazed on its own, so the raw field is speckled. A 3×3 box
    // blur (wrapping, like the world) turns it into a soft meadow, as in 2D.
    soften(g) {
        const { cols, rows, blurA: a, blurB: b } = this;
        for (let y = 0; y < rows; y++) {
            const row = y * cols;
            for (let x = 0; x < cols; x++) {
                const l = x === 0 ? cols - 1 : x - 1;
                const r = x === cols - 1 ? 0 : x + 1;
                a[row + x] = (g[row + l] + g[row + x] + g[row + r]) / 3;
            }
        }
        for (let y = 0; y < rows; y++) {
            const up = (y === 0 ? rows - 1 : y - 1) * cols;
            const down = (y === rows - 1 ? 0 : y + 1) * cols;
            const row = y * cols;
            for (let x = 0; x < cols; x++) b[row + x] = (a[up + x] + a[row + x] + a[down + x]) / 3;
        }
        return b;
    }

    refresh(world) {
        const g = this.soften(world.grass.g);
        const { pixels: px, palette: lut, rock, depth } = this;
        for (let k = 0, n = g.length; k < n; k++) {
            let r, gr, b;
            if (depth[k] >= 0) {
                const t = Math.min(1, depth[k] / 25);
                r = SHORE[0] + (DEEP[0] - SHORE[0]) * t;
                gr = SHORE[1] + (DEEP[1] - SHORE[1]) * t;
                b = SHORE[2] + (DEEP[2] - SHORE[2]) * t;
            } else {
                const c = Math.min(255, (g[k] * 255) | 0) * 3;
                r = lut[c];
                gr = lut[c + 1];
                b = lut[c + 2];
                const s = rock[k];
                if (s > 0) {
                    r += (ROCK[0] - r) * s;
                    gr += (ROCK[1] - gr) * s;
                    b += (ROCK[2] - b) * s;
                }
            }
            const o = k * 4;
            px[o] = r;
            px[o + 1] = gr;
            px[o + 2] = b;
            px[o + 3] = 255;
        }
        this.texture.needsUpdate = true;
    }

    update(world) {
        if (++this.frame % REFRESH === 0) this.refresh(world);
    }

    tile(n) {
        if (!this.tiles[n]) {
            const t = new THREE.Mesh(this.geometry, this.material);
            this.scene.add(t);
            this.tiles[n] = t;
        }
        return this.tiles[n];
    }

    // Lay out the copies of the world that the camera can see. Copy (kx, kz)
    // starts at world (kx·W, kz·H), which is kx·W − fx from the floating origin.
    place(view) {
        const { W, H, fx, fz } = view;
        const kx0 = Math.floor((view.minX + fx) / W);
        const kx1 = Math.floor((view.maxX + fx) / W);
        const kz0 = Math.floor((view.minZ + fz) / H);
        const kz1 = Math.floor((view.maxZ + fz) / H);
        let n = 0;
        for (let kx = kx0; kx <= kx1; kx++) {
            for (let kz = kz0; kz <= kz1 && n < MAX_TILES; kz++) {
                const t = this.tile(n++);
                t.position.set(kx * W - fx, 0, kz * H - fz);
                t.visible = true;
            }
        }
        for (let i = n; i < this.tiles.length; i++) this.tiles[i].visible = false;
        this.tileCount = n;

        if (this.water.visible) {
            this.water.position.set((view.minX + view.maxX) / 2, this.seaLevel, (view.minZ + view.maxZ) / 2);
            this.water.scale.set(view.maxX - view.minX, 1, view.maxZ - view.minZ);
        }
    }
}
