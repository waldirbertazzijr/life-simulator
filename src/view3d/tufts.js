// Grass tufts: little clumps of blades standing wherever the grass is thick.
//
// The ground's colour already shows the grass field, but from up close it is
// a painted floor. Tufts give it depth, and they make grazing visible: where a
// herd has eaten, the tufts thin out and shrink to nothing; when the grass
// grows back, so do they.
//
// How it works:
// - Every grass patch (10 × 10 units) has SLOTS places for a tuft, on a 5 × 5
//   grid with a little jitter. Where each one stands, how it is turned and at
//   what amount of grass it appears all come from a hash of its patch and slot
//   number, so a tuft is always in the same place and simply grows or shrinks
//   with the grass under it. Nothing jumps around between updates.
// - Only a disc of ground in front of the camera has tufts (farther away they
//   would be specks), and it shrinks to nothing when the camera is high up.
//   Every few frames, or when the camera has moved, the disc is refilled: one
//   pass over its patches that writes, per visible tuft, four numbers (where,
//   how tall) and a seed. That is the only JavaScript work; tens of
//   thousands of tufts are then one draw call (an instanced mesh).
// - The rest happens on the graphics card, in the vertex shader: turning each
//   tuft by its seed, a slight lean, the wind (a slow gust rolling across the
//   meadow plus a quick flutter), and a fade toward the edge of the disc so
//   the tufted ground has no hard border.
// - With terrain, the disc's patches skip water, cliffs, rock and steep slopes:
//   each slot's ground height (and whether it may hold a tuft) is worked out
//   once per world.
// - With biomes, each slot also gets its biome's grass colours (biomes.js):
//   deep green in meadows and wetland, yellowing on the steppe, brownish on
//   the tundra. Under the forest canopy most slots stay empty, and along
//   wetland shores some tufts are reeds: taller, darker, with straw heads.
//   That too is decided once per world; a tuft's colours are picked on the
//   graphics card from a small table, by a number packed into its seed.
import * as THREE from 'three';
import { TUFT_PALETTES, REEDS, biomeLook } from './biomes.js';
import { wrap, wrapDelta, hash, meshHeight, smoothstep } from './util.js';

const GRID = 5;           // places for a tuft in each grass patch: a GRID × GRID grid
const SLOTS = GRID * GRID;
const R_MAX = 225;        // the largest radius of the tufted disc (world units)
const TUFT_H = 1.5;       // height of a tuft on full grass (world units)
const MIN_PX = 2;         // a tuft shorter than this on screen (CSS pixels) is not drawn
const REFRESH = 8;        // frames between refills while the grass is changing
const SHOW = 0.12;        // grass below this has no tufts...
const FULL = 0.8;         // ...and from this up every slot has one
const UNDER_TREES = 0.75; // share of the slots left empty under a full forest canopy
const REED_H = 2.3;       // reeds are this much taller than a tuft
const REED_SHARE = 0.5;   // share of the wetland slots by the water that are reeds
const PALETTES = TUFT_PALETTES.length;

// Where slot s of a patch has its tuft, as a fraction (0..1) of the patch
// across and down: somewhere in its own cell of the GRID × GRID grid, chosen
// by the slot's hash h. One tuft per cell spreads them evenly; the jitter
// keeps them from lining up in rows.
const slotU = (s, h) => ((s % GRID) + 0.1 + 0.8 * ((h & 255) / 255)) / GRID;
const slotV = (s, h) => (((s / GRID) | 0) + 0.1 + 0.8 * (((h >>> 8) & 255) / 255)) / GRID;

// One tuft at the origin: a few thin blades fanned out around the middle and
// leaning outward, about one unit tall. Every vertex has an upward normal, so
// a tuft is lit like the flat ground it stands on. Its `color` attribute is
// not a colour but (shade, root 0 or tip 1, unused): the vertex shader turns
// it into a colour that runs from the root to the tip of its palette (each
// blade a slightly different shade).
function tuftGeometry() {
    const blades = [
        // angle around the middle, height, lean (how far out the tip goes), shade
        [0.0, 1.0, 0.26, 1.0],
        [0.9, 0.78, 0.34, 0.9],
        [1.8, 0.92, 0.24, 1.06],
        [2.75, 0.7, 0.36, 0.94],
        [3.7, 0.95, 0.28, 1.0],
        [4.6, 0.75, 0.33, 0.92],
        [5.5, 0.86, 0.27, 1.04],
        [1.2, 1.1, 0.08, 1.1],
    ];
    const pos = [];
    const col = [];
    const r0 = 0.1;   // blades start this far from the middle...
    const w = 0.075;  // ...and are this wide at the root, either side
    for (const [a, h, lean, shade] of blades) {
        const c = Math.cos(a);
        const s = Math.sin(a);
        const bx = c * r0;
        const bz = s * r0;
        pos.push(bx - s * w, 0, bz + c * w, bx + s * w, 0, bz - c * w, c * (r0 + lean), h, s * (r0 + lean));
        col.push(shade, 0, 0, shade, 0, 0, shade, 1, 0);
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill([0, 1, 0]).flat(), 3));
    return g;
}

// The extra vertex shader code. `tuft` and `seed` are per instance.
const VERTEX_PARS = /* glsl */ `
attribute vec4 tuft;   // where it stands (x, y, z, from the disc's centre) and how tall it is
attribute float seed;  // whole part: its palette; fraction: 0..1, the same for a tuft every time it is drawn
uniform vec3 uRoot[ ${PALETTES} ]; // the palettes: colour at the root of a blade...
uniform vec3 uTip[ ${PALETTES} ];  // ...and at its tip
uniform vec2 uCenter;  // the disc's centre now (it moves on between refills)
uniform vec2 uDisc;    // tufts shrink away between these distances from it...
uniform vec3 uCam;     // the camera
uniform vec2 uFar;     // ...and between these distances from the camera
uniform float uShow;   // 0..1: all of them, as the camera rises high
uniform vec2 uOrigin;  // world (x, y) of these coordinates' origin, for the wind
uniform vec2 uWaveK;   // the gusts' wave vector (it fits the world, which wraps)
uniform vec2 uWind;    // phases of the slow gusts and the quick flutter
`;

const VERTEX_MAIN = /* glsl */ `
vec3 transformed = vec3( position );
{
    int palette = int( seed );
    float sd = fract( seed );
    float fade = 1.0 - smoothstep( uDisc.x, uDisc.y, distance( tuft.xz, uCenter ) );
    fade *= ( 1.0 - smoothstep( uFar.x, uFar.y, distance( tuft.xyz, uCam ) ) ) * uShow;
    float a = sd * 6.2831853;
    float c = cos( a );
    float s = sin( a );
    transformed.xz = vec2( c * transformed.x - s * transformed.z, s * transformed.x + c * transformed.z );
    // A short tuft (thin grass, or one just growing in) is narrower too.
    float wide = ( 0.8 + 0.45 * fract( sd * 13.7 ) ) * min( 1.0, sqrt( tuft.w / ${TUFT_H.toFixed(2)} ) );
    transformed *= vec3( wide, tuft.w, wide ) * fade;
    // The whole tuft leans a little, each its own way; the wind bends it
    // more toward the tip (the base stays put), downwind and back.
    vec2 lean = vec2( cos( a * 5.0 ), sin( a * 5.0 ) ) * 0.22 * fract( sd * 7.31 );
    vec2 here = tuft.xz + uOrigin;
    float gust = 0.55 + 0.45 * sin( dot( uWaveK, here ) - uWind.x );
    float flutter = sin( uWind.y + sd * 6.2831853 );
    float bend = transformed.y * transformed.y;
    transformed.xz += lean * transformed.y + normalize( uWaveK ) * bend * ( 0.12 * gust + 0.025 * flutter );
    transformed += tuft.xyz;
    // Its palette's root-to-tip colour (color.g: 0 at the root, 1 at the tip),
    // the blade's shade (color.r) and a little of its own.
    vColor = mix( uRoot[ palette ], uTip[ palette ], color.g ) * color.r * ( 0.88 + 0.24 * fract( sd * 31.17 ) );
}
`;

// A palette's colours as three.js colours (linear, as the shader wants them).
const linear = (rgb) => new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);

export class Tufts {
    constructor(scene) {
        this.uniforms = {
            uCenter: { value: new THREE.Vector2() },
            uDisc: { value: new THREE.Vector2(1, 2) },
            uCam: { value: new THREE.Vector3() },
            uFar: { value: new THREE.Vector2(1, 2) },
            uShow: { value: 1 },
            uOrigin: { value: new THREE.Vector2() },
            uWaveK: { value: new THREE.Vector2(0.05, 0.02) },
            uWind: { value: new THREE.Vector2() },
            uRoot: { value: TUFT_PALETTES.map((p) => linear(p.root)) },
            uTip: { value: TUFT_PALETTES.map((p) => linear(p.tip)) },
        };
        this.material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
        this.material.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, this.uniforms);
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
                .replace('#include <begin_vertex>', VERTEX_MAIN);
            // Seen from behind, a double-sided triangle normally turns its
            // normal around; a blade should be lit the same from both sides.
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <normal_fragment_begin>',
                THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''),
            );
        };
        this.material.customProgramCacheKey = () => 'tufts';

        // Room for every slot of the largest disc (plus its rim of patches).
        const cap = Math.ceil(Math.PI * (R_MAX + 15) ** 2 / 100 * SLOTS);
        this.capacity = cap;
        this.data = new Float32Array(cap * 4);
        this.seeds = new Float32Array(cap);
        this.geometry = tuftGeometry();
        this.tuftAttr = new THREE.InstancedBufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage);
        this.seedAttr = new THREE.InstancedBufferAttribute(this.seeds, 1).setUsage(THREE.DynamicDrawUsage);
        this.geometry.setAttribute('tuft', this.tuftAttr);
        this.geometry.setAttribute('seed', this.seedAttr);
        this.geometry.instanceCount = 0;
        this.mesh = new THREE.Mesh(this.geometry, this.material);
        // The instances are spread over a disc the base geometry knows nothing
        // about, so three.js's own bounds check would hide them; the disc is
        // in front of the camera anyway.
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        scene.add(this.mesh);

        this.out = [0, 0];
        this.center = { x: 0, z: 0, r: 0 }; // the disc as last filled (world x, y and radius)
        // JavaScript cost: ms for the last refill and smoothed; ms per frame
        // (refills included) for the last frame and smoothed; tufts drawn.
        this.stats = { refillMs: 0, refillAvg: 0, refillMax: 0, refills: 0, frameMs: 0, frameAvg: 0, idleMs: 0, idleAvg: 0, count: 0 };
    }

    // A new world: where each slot's tuft stands on the ground, or that it has
    // none (water, cliffs, rock, steep slopes). From the ground (terrain-mesh.js)
    // come its per-patch rockiness, so tufts avoid what looks like rock, and
    // with biomes its tree cover and where the water is.
    attach(world, terrain, ground) {
        const { cols, rows, cellW, cellH } = world.grass;
        this.W = world.width;
        this.H = world.height;
        this.frame = 0;
        this.time = -1;
        this.center.r = 0;
        this.geometry.instanceCount = 0;
        this.mesh.visible = false;
        this.Y = null;
        this.palette = null;
        if (terrain) {
            const Y = new Float32Array(cols * rows * SLOTS);
            const out = this.out;
            const sea = terrain.seaLevel;
            const rock = ground.rock;
            for (let j = 0; j < rows; j++) {
                for (let i = 0; i < cols; i++) {
                    const k = i + j * cols;
                    for (let s = 0; s < SLOTS; s++) {
                        const h1 = hash(k * SLOTS + s);
                        const h2 = hash(h1 ^ 0x9e3779b9);
                        const x = (i + slotU(s, h1)) * cellW;
                        const y = (j + slotV(s, h1)) * cellH;
                        meshHeight(terrain, x, y, out);
                        // Thin out gradually on steeper or rockier ground.
                        const r = ((h2 >>> 16) & 255) / 255;
                        const ok = out[0] > sea + 0.3 && out[1] < 0.4 + 0.35 * r && rock[k] < 0.08 + 0.25 * r && !terrain.blocked(x, y);
                        Y[k * SLOTS + s] = ok ? out[0] : NaN;
                    }
                }
            }
            this.Y = Y;
            if (terrain.biomeGrid && ground.cover) this.attachBiomes(world, terrain, ground);
        }
        // The gusts: waves about 90 units long rolling across from the west
        // (a little north of it, as the map is drawn), every 4.5 seconds. Their
        // wave vector is rounded to whole waves across the world, so they line
        // up where the world joins itself.
        const len = 90;
        const dir = 0.4;
        const nx = Math.max(1, Math.round((this.W / len) * Math.cos(dir)));
        const nz = Math.max(1, Math.round((this.H / len) * Math.sin(dir)));
        this.uniforms.uWaveK.value.set((2 * Math.PI * nx) / this.W, (2 * Math.PI * nz) / this.H);
    }

    // With biomes: each slot's palette (its biome's grass, or reeds), and the
    // slots left empty under the trees.
    attachBiomes(world, terrain, ground) {
        const { cols, rows } = world.grass;
        const { biomeGrid } = terrain;
        const { cover, depth } = ground;
        const looks = terrain.biomes.map(biomeLook);
        const wetland = terrain.biomes.findIndex((b) => b.name === 'wetland');
        // Patches by the water: any water within two patches.
        const shore = new Uint8Array(cols * rows);
        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                let near = 0;
                for (let dj = -2; dj <= 2 && !near; dj++) {
                    const row = ((j + dj + rows) % rows) * cols;
                    for (let di = -2; di <= 2 && !near; di++) if (depth[row + ((i + di + cols) % cols)] >= 0) near = 1;
                }
                shore[i + j * cols] = near;
            }
        }
        const Y = this.Y;
        const palette = new Uint8Array(cols * rows * SLOTS);
        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                const k = i + j * cols;
                for (let s = 0; s < SLOTS; s++) {
                    const slot = k * SLOTS + s;
                    const h1 = hash(slot);
                    const h3 = hash(hash(h1 ^ 0x9e3779b9) ^ 0x85ebca6b);
                    // The biome a little way off (up to half a patch, by the
                    // hash): near a border, tufts of both sides mingle in a
                    // ragged band instead of meeting along the patch grid.
                    const pi = Math.floor(i + slotU(s, h1) + ((h3 & 255) / 255 - 0.5));
                    const pj = Math.floor(j + slotV(s, h1) + (((h3 >>> 8) & 255) / 255 - 0.5));
                    const b = biomeGrid[((pi + cols) % cols) + ((pj + rows) % rows) * cols];
                    let p = looks[b].tuft;
                    if (b === wetland && shore[k] && ((h3 >>> 24) & 255) / 255 < REED_SHARE) p = REEDS;
                    palette[slot] = p;
                    // Under the canopy, most slots stay empty.
                    if (((h3 >>> 16) & 255) / 255 < UNDER_TREES * cover[k]) Y[slot] = NaN;
                }
            }
        }
        this.palette = palette;
    }

    // Every frame: choose the disc for this view, refill it if needed, and
    // move it into place under the floating origin.
    update(world, view, camera, ground) {
        const t0 = performance.now();
        const { W, H } = this;
        const st = this.stats;
        // How far away a tuft is still MIN_PX tall, and how high the camera is
        // above the ground: together, how big a disc is worth filling.
        const far = TUFT_H / (MIN_PX * view.unitPx);
        const wx = view.fx + view.camX;
        const wz = view.fz + view.camZ;
        const above = view.camY - ground(wx, wz);
        const R = Math.min(R_MAX, Math.sqrt(Math.max(0, far * far - above * above)));
        // From high up (the map), even the nearest tufts are specks, and a disc
        // of specks covering part of the screen would look like a smudge: all
        // tufts shrink away together as the nearest ones drop from 7 to 4 pixels.
        const show = smoothstep(4, 7, TUFT_H / (above * view.unitPx));
        if (R < 20 || show <= 0) {
            this.mesh.visible = false;
            this.geometry.instanceCount = 0;
            this.center.r = 0;
            st.count = 0;
            this.measure(t0, false);
            return;
        }
        // Centre the disc ahead of the camera, so little of it is behind:
        // 0.55 R ahead when looking at the horizon, right under the camera
        // when looking straight down. The camera looks along −(e[8], e[9],
        // e[10]); seen from above, that is (−e[8], −e[10]), as long as the
        // cosine of its pitch.
        const e = camera.matrixWorld.elements;
        const cx = wrap(wx - e[8] * 0.55 * R, W);
        const cz = wrap(wz - e[10] * 0.55 * R, H);

        const c = this.center;
        const driftX = wrapDelta(cx - c.x, W);
        const driftZ = wrapDelta(cz - c.z, H);
        const moved = Math.hypot(driftX, driftZ) > 0.1 * c.r || R > c.r * 1.05 || R < c.r * 0.8;
        const due = ++this.frame >= REFRESH && world.time !== this.time;
        let refilled = false;
        if (moved || due) {
            const t1 = performance.now();
            this.refill(world, cx, cz, R);
            const ms = performance.now() - t1;
            st.refillMs = ms;
            st.refillAvg += (ms - st.refillAvg) * (st.refills ? 0.1 : 1);
            if (ms > st.refillMax) st.refillMax = ms;
            st.refills++;
            refilled = true;
        }

        const n = this.geometry.instanceCount;
        this.mesh.visible = n > 0;
        st.count = n;
        // The filled disc's centre, relative to the floating origin.
        const mx = wrapDelta(c.x - view.fx, W);
        const mz = wrapDelta(c.z - view.fz, H);
        this.mesh.position.set(mx, 0, mz);
        const u = this.uniforms;
        u.uCenter.value.set(wrapDelta(cx - c.x, W), wrapDelta(cz - c.z, H));
        u.uDisc.value.set(0.65 * R, 0.88 * R);
        u.uCam.value.set(view.camX - mx, view.camY, view.camZ - mz);
        u.uFar.value.set(0.6 * far, far);
        u.uShow.value = show;
        u.uOrigin.value.set(c.x, c.z);
        const t = performance.now() / 1000;
        u.uWind.value.set((t * 1.4) % (2 * Math.PI), (t * 8.2) % (2 * Math.PI));
        this.measure(t0, refilled);
    }

    measure(t0, refilled) {
        const st = this.stats;
        st.frameMs = performance.now() - t0;
        st.frameAvg += (st.frameMs - st.frameAvg) * 0.05;
        if (!refilled) {
            st.idleMs = st.frameMs;
            st.idleAvg += (st.idleMs - st.idleAvg) * 0.05;
        }
    }

    // Write every tuft in the disc of radius R around world (cx, cz), relative
    // to that centre.
    refill(world, cx, cz, R) {
        const grass = world.grass;
        const { cols, rows, cellW, cellH } = grass;
        const G = grass.g;
        const Y = this.Y;
        const P = this.palette;
        const { data, seeds, capacity } = this;
        const R2 = R * R;
        const reach = R + Math.hypot(cellW, cellH) / 2;
        const j0 = Math.floor((cz - reach) / cellH);
        const j1 = Math.floor((cz + reach) / cellH);
        let n = 0;
        for (let j = j0; j <= j1 && n < capacity; j++) {
            const pz = (j + 0.5) * cellH - cz; // the patch row's middle, from the centre
            const half = Math.sqrt(Math.max(0, reach * reach - pz * pz));
            const i0 = Math.floor((cx - half) / cellW);
            const i1 = Math.floor((cx + half) / cellW);
            const jj = ((j % rows) + rows) % rows;
            const row = jj * cols;
            const up = (jj === 0 ? rows - 1 : jj - 1) * cols;
            const down = (jj === rows - 1 ? 0 : jj + 1) * cols;
            for (let i = i0; i <= i1 && n < capacity; i++) {
                const ii = ((i % cols) + cols) % cols;
                const l = ii === 0 ? cols - 1 : ii - 1;
                const r = ii === cols - 1 ? 0 : ii + 1;
                // This patch and its eight neighbours, to blend between them.
                const g = G[row + ii];
                const gl = G[row + l];
                const gr = G[row + r];
                const gu = G[up + ii];
                const gul = G[up + l];
                const gur = G[up + r];
                const gd = G[down + ii];
                const gdl = G[down + l];
                const gdr = G[down + r];
                if (g < SHOW && gl < SHOW && gr < SHOW && gu < SHOW && gd < SHOW && gul < SHOW && gur < SHOW && gdl < SHOW && gdr < SHOW) continue;
                const k = row + ii;
                for (let s = 0; s < SLOTS; s++) {
                    let y = 0;
                    if (Y !== null) {
                        y = Y[k * SLOTS + s];
                        if (y !== y) continue; // NaN: no tuft can stand here
                    }
                    const h1 = hash(k * SLOTS + s);
                    const fu = slotU(s, h1);
                    const fv = slotV(s, h1);
                    const x = (i + fu) * cellW - cx;
                    const z = (j + fv) * cellH - cz;
                    if (x * x + z * z > R2) continue;
                    // The grass here, blended (bilinearly) from the patch
                    // centres around it, so tufts thin out smoothly rather
                    // than in 10-unit squares.
                    const a = fu - 0.5;
                    const b = fv - 0.5;
                    const ax = a < 0 ? -a : a;
                    const by = b < 0 ? -b : b;
                    const g0 = a < 0 ? g + (gl - g) * ax : g + (gr - g) * ax;
                    const g1 = b < 0
                        ? (a < 0 ? gu + (gul - gu) * ax : gu + (gur - gu) * ax)
                        : (a < 0 ? gd + (gdl - gd) * ax : gd + (gdr - gd) * ax);
                    const here = g0 + (g1 - g0) * by;
                    // Each slot has its own threshold: as the grass grows, more
                    // slots fill, each tuft growing in rather than popping up.
                    const thr = SHOW + (FULL - SHOW) * (((h1 >>> 16) & 1023) / 1023);
                    if (here <= thr) continue;
                    const h2 = hash(h1 ^ 0x9e3779b9);
                    const grow = Math.min(1, (here - thr) / 0.12);
                    const p = P !== null ? P[k * SLOTS + s] : 0;
                    const size = (0.8 + 0.4 * ((h2 >>> 24) / 255)) * (p === REEDS ? REED_H : 1);
                    const o = n * 4;
                    data[o] = x;
                    data[o + 1] = y;
                    data[o + 2] = z;
                    data[o + 3] = TUFT_H * size * (0.55 + 0.45 * here) * grow * (2 - grow);
                    seeds[n] = p + (h2 & 0xffff) / 65536;
                    if (++n >= capacity) break;
                }
            }
        }
        const c = this.center;
        c.x = cx;
        c.z = cz;
        c.r = R;
        this.frame = 0;
        this.time = world.time;
        this.geometry.instanceCount = n;
        if (n) {
            this.tuftAttr.clearUpdateRanges();
            this.tuftAttr.addUpdateRange(0, n * 4);
            this.tuftAttr.needsUpdate = true;
            this.seedAttr.clearUpdateRanges();
            this.seedAttr.addUpdateRange(0, n);
            this.seedAttr.needsUpdate = true;
        }
    }
}
