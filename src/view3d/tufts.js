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
import * as THREE from 'three';
import { COLORS } from '../render.js';
import { wrap, wrapDelta } from './util.js';

const GRID = 5;           // places for a tuft in each grass patch: a GRID × GRID grid
const SLOTS = GRID * GRID;
const R_MAX = 225;        // the largest radius of the tufted disc (world units)
const TUFT_H = 1.5;       // height of a tuft on full grass (world units)
const MIN_PX = 2;         // a tuft shorter than this on screen (CSS pixels) is not drawn
const REFRESH = 8;        // frames between refills while the grass is changing
const SHOW = 0.12;        // grass below this has no tufts...
const FULL = 0.8;         // ...and from this up every slot has one
// The tuft's colours come from the grass palette (render.js): the root a bit
// darker than lush ground, the tip the lush green lifted toward pale straw.
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const ROOT = mix(COLORS.bare, COLORS.lush, 0.6);
const TIP = mix(COLORS.lush, [200, 208, 160], 0.38);

const smoothstep = (a, b, v) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

// A 32-bit integer hash (lowbias32): neighbouring inputs give unrelated outputs.
function hash(n) {
    n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
    n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
    return (n ^ (n >>> 16)) >>> 0;
}

// Where slot s of a patch has its tuft, as a fraction (0..1) of the patch
// across and down: somewhere in its own cell of the GRID × GRID grid, chosen
// by the slot's hash h. One tuft per cell spreads them evenly; the jitter
// keeps them from lining up in rows.
const slotU = (s, h) => ((s % GRID) + 0.1 + 0.8 * ((h & 255) / 255)) / GRID;
const slotV = (s, h) => (((s / GRID) | 0) + 0.1 + 0.8 * (((h >>> 8) & 255) / 255)) / GRID;

// One tuft at the origin: a few thin blades fanned out around the middle and
// leaning outward, about one unit tall. Every vertex has an upward normal, so
// a tuft is lit like the flat ground it stands on, and a colour that runs
// from the root to the tip (each blade a slightly different shade).
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
    const root = new THREE.Color().setRGB(ROOT[0] / 255, ROOT[1] / 255, ROOT[2] / 255, THREE.SRGBColorSpace);
    const tip = new THREE.Color().setRGB(TIP[0] / 255, TIP[1] / 255, TIP[2] / 255, THREE.SRGBColorSpace);
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
        for (let v = 0; v < 2; v++) col.push(root.r * shade, root.g * shade, root.b * shade);
        col.push(tip.r * shade, tip.g * shade, tip.b * shade);
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill([0, 1, 0]).flat(), 3));
    return g;
}

// The ground's height where the ground mesh (terrain-mesh.js) really is: its
// triangles, not the bilinear heightAt, so tufts neither float nor sink.
// Also returns the slope (rise over run) of that triangle in `out[1]`.
function meshHeight(T, x, y, out) {
    const { cols, rows, cellW, cellH, height: h } = T;
    const fx = x / cellW;
    const fy = y / cellH;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const i0 = ((i % cols) + cols) % cols;
    const j0 = ((j % rows) + rows) % rows;
    const i1 = i0 + 1 === cols ? 0 : i0 + 1;
    const j1 = j0 + 1 === rows ? 0 : j0 + 1;
    const a = h[i0 + j0 * cols];
    const b = h[i1 + j0 * cols];
    const c = h[i0 + j1 * cols];
    const d = h[i1 + j1 * cols];
    let gx;
    let gy;
    if (tx + ty <= 1) {
        out[0] = a + (b - a) * tx + (c - a) * ty; // triangle a, b, c
        gx = (b - a) / cellW;
        gy = (c - a) / cellH;
    } else {
        out[0] = d + (c - d) * (1 - tx) + (b - d) * (1 - ty); // triangle b, c, d
        gx = (d - c) / cellW;
        gy = (d - b) / cellH;
    }
    out[1] = Math.sqrt(gx * gx + gy * gy);
}

// The extra vertex shader code. `tuft` and `seed` are per instance.
const VERTEX_PARS = /* glsl */ `
attribute vec4 tuft;   // where it stands (x, y, z, from the disc's centre) and how tall it is
attribute float seed;  // 0..1, the same for a tuft every time it is drawn
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
    float fade = 1.0 - smoothstep( uDisc.x, uDisc.y, distance( tuft.xz, uCenter ) );
    fade *= ( 1.0 - smoothstep( uFar.x, uFar.y, distance( tuft.xyz, uCam ) ) ) * uShow;
    float a = seed * 6.2831853;
    float c = cos( a );
    float s = sin( a );
    transformed.xz = vec2( c * transformed.x - s * transformed.z, s * transformed.x + c * transformed.z );
    // A short tuft (thin grass, or one just growing in) is narrower too.
    float wide = ( 0.8 + 0.45 * fract( seed * 13.7 ) ) * min( 1.0, sqrt( tuft.w / ${TUFT_H.toFixed(2)} ) );
    transformed *= vec3( wide, tuft.w, wide ) * fade;
    // The whole tuft leans a little, each its own way; the wind bends it
    // more toward the tip (the base stays put), downwind and back.
    vec2 lean = vec2( cos( a * 5.0 ), sin( a * 5.0 ) ) * 0.22 * fract( seed * 7.31 );
    vec2 here = tuft.xz + uOrigin;
    float gust = 0.55 + 0.45 * sin( dot( uWaveK, here ) - uWind.x );
    float flutter = sin( uWind.y + seed * 6.2831853 );
    float bend = transformed.y * transformed.y;
    transformed.xz += lean * transformed.y + normalize( uWaveK ) * bend * ( 0.12 * gust + 0.025 * flutter );
    transformed += tuft.xyz;
    vColor *= 0.88 + 0.24 * fract( seed * 31.17 );
}
`;

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
    // none (water, cliffs, rock, steep slopes). `rock` is the ground's own
    // per-patch rockiness (terrain-mesh.js), so tufts avoid what looks like rock.
    attach(world, terrain, rock) {
        const { cols, rows, cellW, cellH } = world.grass;
        this.W = world.width;
        this.H = world.height;
        this.frame = 0;
        this.time = -1;
        this.center.r = 0;
        this.geometry.instanceCount = 0;
        this.mesh.visible = false;
        this.Y = null;
        if (terrain) {
            const Y = new Float32Array(cols * rows * SLOTS);
            const out = this.out;
            const sea = terrain.seaLevel;
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
                    const size = 0.8 + 0.4 * ((h2 >>> 24) / 255);
                    const o = n * 4;
                    data[o] = x;
                    data[o + 1] = y;
                    data[o + 2] = z;
                    data[o + 3] = TUFT_H * size * (0.55 + 0.45 * here) * grow * (2 - grow);
                    seeds[n] = (h2 & 0xffff) / 65536;
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
