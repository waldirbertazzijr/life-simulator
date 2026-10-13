// Frogs among the water lilies: a little life at the water's edge that only
// the page knows about. They are not in the simulation and change nothing.
//
// Where they live comes from lily-places.js (some of the bigger pads, and
// spots on the shore around each colony), the same for a world every time.
// Only the homes near the camera have a frog (from farther away a frog is a
// speck): a fixed pool of POOL frogs goes to the nearest homes in reach,
// and a frog leaving that reach shrinks away and is free for another home.
//
// What a frog does:
// - sits, now and then turning a little;
// - hops in a short arc to another pad or a spot on the shore nearby;
// - plops into the water (a ripple ring), stays under a while, comes up
//   floating with only its head out, and climbs back onto a pad or the shore;
// - when any creature (the player's body too: it is one of the world's
//   people) comes within SCARE, jumps into the water at once, away from it,
//   and stays under until the coast is clear.
// Each frog's choices come from a random stream seeded by its home, not by
// Math.random. Time is the page's, stopped while the world is paused.
//
// Drawing: one instanced mesh for the frogs (their back legs stretch out in
// a leap, in the vertex shader) and one for the ripples, which grow and fade
// on the graphics card. Per frame: a few dozen frogs and one pass over the
// creatures for the scare.
import * as THREE from 'three';
import { stream } from './lily-places.js';
import { PAD_LIFT } from './lilies.js';
import { wrap, wrapDelta, meshHeight, smoothstep } from './util.js';

const POOL = 40;           // frogs at most, near the camera
const REACH = 130;         // homes this far from the camera have a frog...
const MIN_PX = 1.6;        // ...if a frog there is at least this long on screen
const SCARE = 7;           // a creature this close sends a frog into the water
const HOP = 7;             // the longest hop
const NEAR = 25;           // a frog keeps to the pads and shore within this of its home
const SIZE = [0.75, 1.0];  // a frog's scale (its model is about 0.85 long)
const RIPPLES = 24;
const RIPPLE_LIFE = 1.6;   // seconds

const SIT = 0;
const HOP_ = 1;
const UNDER = 2;
const FLOAT = 3;

const linear = (rgb) => new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);

// Muted greens, a few olive and brownish.
const TINTS = [[86, 132, 58], [108, 138, 56], [70, 112, 62], [116, 118, 66], [80, 124, 84], [100, 126, 52]].map(linear);

// A frog's geometry: an indexed mesh with a colour per corner (a shade the
// frog's own green is multiplied by) and `limb`: how far a corner moves when
// the frog leaps (> 0 back legs, < 0 front legs).
class Builder {
    constructor() {
        this.pos = [];
        this.col = [];
        this.limb = [];
        this.idx = [];
    }

    vertex(x, y, z, shade, limb = 0) {
        this.pos.push(x, y, z);
        this.col.push(...shade);
        this.limb.push(limb);
        return this.pos.length / 3 - 1;
    }

    // A triangle turned to face away from the point (ox, oy, oz).
    face(a, b, c, ox, oy, oz) {
        const P = this.pos;
        const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
        const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const mx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3 - ox;
        const my = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3 - oy;
        const mz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3 - oz;
        if (nx * mx + ny * my + nz * mz >= 0) this.idx.push(a, b, c);
        else this.idx.push(a, c, b);
    }

    // A squashed icosahedron, lighter and yellower underneath (the belly).
    blob(cx, cy, cz, sx, sy, sz, shade, belly = true) {
        const p = (1 + Math.sqrt(5)) / 2;
        const corners = [
            [-1, p, 0], [1, p, 0], [-1, -p, 0], [1, -p, 0], [0, -1, p], [0, 1, p],
            [0, -1, -p], [0, 1, -p], [p, 0, -1], [p, 0, 1], [-p, 0, -1], [-p, 0, 1],
        ];
        const len = Math.hypot(1, p);
        const first = this.pos.length / 3;
        for (const [x, y, z] of corners) {
            const u = y / len; // −1 underneath .. 1 on top
            const t = belly ? smoothstep(0.1, -0.6, u) : 0;
            const s = [shade[0] * (1 + 0.9 * t), shade[1] * (1 + 0.75 * t), shade[2] * (1 + 0.35 * t)];
            this.vertex(cx + (x / len) * sx, cy + u * sy, cz + (z / len) * sz, s);
        }
        const faces = [
            [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
            [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
        ];
        for (const [a, b, c] of faces) this.face(first + a, first + b, first + c, cx, cy, cz);
    }

    // A leg segment from A to B: a three-sided prism, with leap weights.
    segment(A, B, rA, rB, shade, wA, wB) {
        const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
        const len = Math.hypot(dx, dy, dz);
        const d = [dx / len, dy / len, dz / len];
        // Two directions across the segment.
        const up = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        let u = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
        const ul = Math.hypot(...u);
        u = u.map((v) => v / ul);
        const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
        const ring = (P, r, w) => [0, 1, 2].map((k) => {
            const a = (k / 3) * Math.PI * 2;
            const c = Math.cos(a) * r;
            const s = Math.sin(a) * r;
            return this.vertex(P[0] + u[0] * c + v[0] * s, P[1] + u[1] * c + v[1] * s, P[2] + u[2] * c + v[2] * s, shade, w);
        });
        const a = ring(A, rA, wA);
        const b = ring(B, rB, wB);
        const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2, mz = (A[2] + B[2]) / 2;
        for (let k = 0; k < 3; k++) {
            const j = (k + 1) % 3;
            this.face(a[k], b[k], a[j], mx, my, mz);
            this.face(a[j], b[k], b[j], mx, my, mz);
        }
        // Close the far end (a foot's toe, a hand).
        this.face(b[0], b[1], b[2], A[0], A[1], A[2]);
    }

    geometry() {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
        g.setAttribute('limb', new THREE.Float32BufferAttribute(this.limb, 1));
        g.setIndex(this.idx);
        g.computeVertexNormals();
        return g;
    }
}

// A frog sitting, facing +x, its feet at y = 0: a squat body, a broad head
// with two bulging eyes, front legs propping it up, back legs folded at its
// sides.
function frogGeometry() {
    const b = new Builder();
    const skin = [1, 1, 1];
    const dark = [0.78, 0.8, 0.72];
    b.blob(-0.06, 0.22, 0, 0.34, 0.17, 0.25, skin);
    b.blob(0.22, 0.29, 0, 0.2, 0.13, 0.22, skin);
    b.blob(0.27, 0.4, 0.11, 0.07, 0.065, 0.07, [0.55, 0.55, 0.45], false);
    b.blob(0.27, 0.4, -0.11, 0.07, 0.065, 0.07, [0.55, 0.55, 0.45], false);
    b.blob(0.31, 0.415, 0.13, 0.03, 0.03, 0.03, [0.12, 0.1, 0.1], false);
    b.blob(0.31, 0.415, -0.13, 0.03, 0.03, 0.03, [0.12, 0.1, 0.1], false);
    for (const side of [1, -1]) {
        // Front leg: shoulder to hand.
        b.segment([0.16, 0.18, 0.13 * side], [0.27, 0.0, 0.2 * side], 0.045, 0.035, dark, -0.4, -1);
        // Back leg folded: hip, knee forward and out, ankle back, foot forward.
        const hip = [-0.24, 0.16, 0.16 * side];
        const knee = [0.02, 0.1, 0.3 * side];
        const ankle = [-0.3, 0.04, 0.3 * side];
        const toe = [-0.02, 0.0, 0.36 * side];
        b.segment(hip, knee, 0.08, 0.055, skin, 0.15, 0.55);
        b.segment(knee, ankle, 0.05, 0.04, dark, 0.55, 0.85);
        b.segment(ankle, toe, 0.04, 0.03, dark, 0.85, 1);
    }
    return b.geometry();
}

// The leap, in the frog's vertex shader: back legs stretch out behind, front
// legs reach forward, the body lengthens.
const FROG_PARS = /* glsl */ `
attribute float limb;
attribute float leap;
`;
const FROG_MAIN = /* glsl */ `
vec3 transformed = vec3( position );
{
    float back = max( limb, 0.0 ) * leap;
    float front = max( -limb, 0.0 ) * leap;
    transformed += back * vec3( -0.62, 0.02 - 0.12 * transformed.y, -0.45 * transformed.z );
    transformed += front * vec3( 0.18, 0.04, 0.0 );
    transformed.x *= 1.0 + 0.12 * leap * ( 1.0 - abs( limb ) );
}
`;

// Ripple rings, grown and faded on the graphics card.
const RIPPLE_PARS = /* glsl */ `
attribute vec4 ripple;  // world x, height, world y, start (seconds)
attribute float rsize;
uniform vec2 uOrigin;
uniform vec2 uWorld;
uniform float uTime;
varying float vAlpha;
`;
const RIPPLE_MAIN = /* glsl */ `
vec3 transformed = vec3( position );
{
    float age = uTime - ripple.w;
    float live = step( 0.0, age ) * step( age, ${RIPPLE_LIFE.toFixed(2)} );
    float t = clamp( age / ${RIPPLE_LIFE.toFixed(2)}, 0.0, 1.0 );
    vAlpha = ( 1.0 - t ) * ( 1.0 - t ) * live;
    transformed *= rsize * ( 0.3 + 1.2 * sqrt( t ) ) * live;
    transformed += vec3(
        mod( ripple.x - uOrigin.x + 0.5 * uWorld.x, uWorld.x ) - 0.5 * uWorld.x,
        ripple.y,
        mod( ripple.z - uOrigin.y + 0.5 * uWorld.y, uWorld.y ) - 0.5 * uWorld.y );
}
`;

export class Frogs {
    constructor(scene) {
        const geometry = frogGeometry();
        this.leap = new THREE.InstancedBufferAttribute(new Float32Array(POOL), 1).setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('leap', this.leap);
        const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
        material.onBeforeCompile = (shader) => {
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', `#include <common>\n${FROG_PARS}`)
                .replace('#include <begin_vertex>', FROG_MAIN);
        };
        material.customProgramCacheKey = () => 'frogs';
        this.mesh = new THREE.InstancedMesh(geometry, material, POOL);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(POOL * 3), 3).setUsage(THREE.DynamicDrawUsage);
        this.mesh.count = 0;
        this.mesh.frustumCulled = false; // they move: the bounds would be stale
        scene.add(this.mesh);

        // Ripples.
        this.rippleUniforms = {
            uOrigin: { value: new THREE.Vector2() },
            uWorld: { value: new THREE.Vector2(1, 1) },
            uTime: { value: 0 },
        };
        const ring = new THREE.RingGeometry(0.86, 1, 28).rotateX(-Math.PI / 2);
        const rg = new THREE.InstancedBufferGeometry();
        rg.index = ring.index;
        rg.setAttribute('position', ring.attributes.position);
        rg.setAttribute('normal', ring.attributes.normal);
        this.rippleData = new Float32Array(RIPPLES * 4).fill(0);
        for (let i = 0; i < RIPPLES; i++) this.rippleData[i * 4 + 3] = -1e6; // long gone
        this.rippleSize = new Float32Array(RIPPLES);
        this.rippleAttr = new THREE.InstancedBufferAttribute(this.rippleData, 4).setUsage(THREE.DynamicDrawUsage);
        this.rippleSizeAttr = new THREE.InstancedBufferAttribute(this.rippleSize, 1).setUsage(THREE.DynamicDrawUsage);
        rg.setAttribute('ripple', this.rippleAttr);
        rg.setAttribute('rsize', this.rippleSizeAttr);
        rg.instanceCount = RIPPLES;
        const rm = new THREE.MeshBasicMaterial({ color: '#d2dfe1', transparent: true, opacity: 0.6, depthWrite: false });
        rm.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, this.rippleUniforms);
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', `#include <common>\n${RIPPLE_PARS}`)
                .replace('#include <begin_vertex>', RIPPLE_MAIN);
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
                .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vAlpha;');
        };
        rm.customProgramCacheKey = () => 'ripples';
        this.ripples = new THREE.Mesh(rg, rm);
        this.ripples.frustumCulled = false;
        this.ripples.renderOrder = 2; // over the water sheet
        this.ripples.visible = false;
        scene.add(this.ripples);
        this.rippleNext = 0;
        this.lastRipple = -1e9;

        this.frogs = [];
        for (let i = 0; i < POOL; i++) this.frogs.push({ slot: i, home: -1 });
        this.homes = [];
        this.byHome = new Map(); // home index → frog
        this.clock = 0;
        this.last = NaN;
        this.out = [0, 0];
        this.m = new Float32Array(16);
        this.stats = { homes: 0, active: 0, drawn: 0, frameMs: 0, frameAvg: 0 };
    }

    // A new world: the homes (lilies.places, from lily-places.js) and where
    // a frog can sit: every pad (its top) and every shore spot.
    attach(world, terrain, places) {
        for (const f of this.frogs) f.home = -1;
        this.byHome.clear();
        this.chosen = null;
        this.mesh.count = 0;
        this.terrain = terrain;
        this.W = world.width;
        this.H = world.height;
        this.sea = terrain ? terrain.seaLevel : 0;
        this.homes = terrain && places ? places.homes : [];
        this.pads = places ? places.pads : [];
        this.shore = places ? places.shore : [];
        // Spots: pads first, then the shore (x, y, height, pad radius or 0).
        const n = this.pads.length + this.shore.length;
        this.spots = { n, x: new Float64Array(n), y: new Float64Array(n), h: new Float64Array(n), r: new Float64Array(n) };
        const S = this.spots;
        this.pads.forEach((p, i) => {
            S.x[i] = p.x;
            S.y[i] = p.y;
            S.h[i] = this.sea + PAD_LIFT;
            S.r[i] = p.r;
        });
        this.shore.forEach((s, j) => {
            const i = this.pads.length + j;
            S.x[i] = s.x;
            S.y[i] = s.y;
            S.h[i] = s.h;
            S.r[i] = 0;
        });
        this.rippleUniforms.uWorld.value.set(this.W, this.H);
        this.stats.homes = this.homes.length;
    }

    // ---- the frogs' world -----------------------------------------------------

    depth(x, y) {
        meshHeight(this.terrain, wrap(x, this.W), wrap(y, this.H), this.out);
        return this.sea - this.out[0];
    }

    // The spots within NEAR of a home: all a frog living there ever uses (it
    // keeps close to home).
    around(home) {
        const S = this.spots;
        const list = [];
        for (let i = 0; i < S.n; i++) {
            if (Math.hypot(wrapDelta(S.x[i] - home.x, this.W), wrapDelta(S.y[i] - home.y, this.H)) < NEAR) list.push(i);
        }
        return list;
    }

    // Is (x, y) on one of the pads near frog f (with `margin` to spare)?
    onPad(f, x, y, margin) {
        const { W, H } = this;
        const S = this.spots;
        for (const i of f.near) {
            if (S.r[i] === 0) continue;
            const dx = wrapDelta(S.x[i] - x, W);
            const dy = wrapDelta(S.y[i] - y, H);
            const r = S.r[i] + margin;
            if (dx * dx + dy * dy < r * r) return true;
        }
        return false;
    }

    // Open water near (x, y), toward angle `a` if it can be (spreading out
    // to either side if not), between `d0` and `d1` away; null if none.
    water(f, x, y, a, d0, d1) {
        for (let k = 0; k < 9; k++) {
            const b = a + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.55;
            const c = Math.cos(b);
            const s = Math.sin(b);
            for (let d = d0; d <= d1; d += 0.6) {
                const px = x + c * d;
                const py = y + s * d;
                if (this.depth(px, py) > 0.18 && !this.onPad(f, px, py, 0.35)) return { x: wrap(px, this.W), y: wrap(py, this.H) };
            }
        }
        return null;
    }

    // Where on spot i a frog lands: anywhere on the inner part of a pad, or
    // about the shore spot (never below the water line).
    landing(f, i) {
        const S = this.spots;
        const a = f.rnd() * Math.PI * 2;
        const d = S.r[i] > 0 ? S.r[i] * 0.45 * Math.sqrt(f.rnd()) : 0.3 * f.rnd();
        const x = wrap(S.x[i] + Math.cos(a) * d, this.W);
        const y = wrap(S.y[i] + Math.sin(a) * d, this.H);
        let h = S.h[i];
        if (S.r[i] === 0) {
            meshHeight(this.terrain, x, y, this.out);
            h = Math.max(this.sea, this.out[0]);
        }
        return { x, y, h };
    }

    // A spot near frog f to hop to from (x, y), between 1.2 and `reach`
    // away, not `not`; the one nearest home when it has strayed. −1 if none.
    nearSpot(f, x, y, reach, not) {
        const S = this.spots;
        const home = this.homes[f.home];
        const strayed = Math.hypot(wrapDelta(home.x - x, this.W), wrapDelta(home.y - y, this.H)) > 10;
        let pick = -1;
        let seen = 0;
        let best = Infinity;
        for (const i of f.near) {
            if (i === not) continue;
            const dx = wrapDelta(S.x[i] - x, this.W);
            const dy = wrapDelta(S.y[i] - y, this.H);
            const d = Math.hypot(dx, dy) - S.r[i] * 0.5;
            if (d < 1.2 || d > reach) continue;
            if (strayed) {
                const back = Math.hypot(wrapDelta(home.x - S.x[i], this.W), wrapDelta(home.y - S.y[i], this.H));
                if (back < best) {
                    best = back;
                    pick = i;
                }
            } else if (f.rnd() * ++seen < 1) {
                pick = i; // one of them, each as likely
            }
        }
        return pick;
    }

    // ---- what a frog does -------------------------------------------------------

    spawn(f, homeIndex) {
        const home = this.homes[homeIndex];
        f.home = homeIndex;
        f.near = this.around(home);
        f.calm = 0;
        f.rnd = stream(home.seed);
        f.size = SIZE[0] + (SIZE[1] - SIZE[0]) * f.rnd();
        const tint = TINTS[Math.floor(f.rnd() * TINTS.length)];
        const shade = 0.9 + 0.2 * f.rnd();
        f.tint = [tint.r * shade, tint.g * shade, tint.b * shade];
        const spot = home.pad >= 0 ? home.pad : this.pads.length + home.shore;
        const at = this.landing(f, spot);
        f.spot = spot;
        f.x = at.x;
        f.y = at.y;
        f.h = at.h;
        f.heading = f.rnd() * Math.PI * 2;
        f.state = SIT;
        f.t = 0;
        f.next = 1 + 8 * f.rnd();
        f.turn = null;
        f.hop = null;
        f.threat = null;
        f.pitch = 0;
        f.leapAmount = 0;
        f.lift = 0;
    }

    // Leap from where it is to (x1, y1, h1). `into`: 'spot' (then spot i) or 'water'.
    jump(f, x1, y1, h1, into, spot) {
        const dx = wrapDelta(x1 - f.x, this.W);
        const dy = wrapDelta(y1 - f.y, this.H);
        const dist = Math.hypot(dx, dy);
        f.heading = Math.atan2(dy, dx);
        f.hop = {
            x0: f.x, y0: f.y, h0: f.h, dx, dy,
            h1: into === 'water' ? this.sea - 0.5 * f.size : h1,
            dur: 0.3 + 0.045 * dist,
            peak: 0.3 + 0.16 * dist,
            into, spot,
        };
        f.state = HOP_;
        f.t = 0;
        f.spot = -1;
    }

    // Into the water, away from angle `away` if given. With no water in
    // reach (a pad in the middle of a mat, a spot up the bank), a hop to
    // another spot instead, or else it stays put.
    plop(f, away) {
        const a = away ?? f.rnd() * Math.PI * 2;
        const onPad = f.spot >= 0 && this.spots.r[f.spot] > 0;
        const w = this.water(f, f.x, f.y, a, onPad ? this.spots.r[f.spot] * 0.6 + 0.8 : 1.2, 8);
        if (w) {
            this.jump(f, w.x, w.y, this.sea, 'water', -1);
            return;
        }
        const i = this.nearSpot(f, f.x, f.y, HOP, f.spot);
        if (i >= 0) {
            const at = this.landing(f, i);
            this.jump(f, at.x, at.y, at.h, 'spot', i);
            return;
        }
        f.t = 0;
        f.calm = 1; // (and does not look for a way out again for a second)
        f.next = 2 + 4 * f.rnd();
    }

    dive(f) {
        this.ripple(f.x, f.y, 0.9 * f.size + 0.3);
        f.state = UNDER;
        f.t = 0;
        f.spot = -1;
        f.next = 4 + 8 * f.rnd();
    }

    // From under the water: come up near a spot close to home.
    surface(f) {
        const home = this.homes[f.home];
        const target = this.nearSpot(f, home.x, home.y, 9, -1);
        const i = target >= 0 && f.rnd() < 0.7 ? target : home.pad >= 0 ? home.pad : this.pads.length + home.shore;
        const S = this.spots;
        const w = this.water(f, S.x[i], S.y[i], f.rnd() * Math.PI * 2, S.r[i] + 0.7, S.r[i] + 3.5);
        if (!w) {
            f.next = 3; // try again later
            f.t = 0;
            return;
        }
        f.x = w.x;
        f.y = w.y;
        f.h = this.sea;
        f.target = i;
        f.heading = Math.atan2(wrapDelta(S.y[i] - w.y, this.H), wrapDelta(S.x[i] - w.x, this.W));
        f.state = FLOAT;
        f.t = 0;
        f.next = 2 + 4 * f.rnd();
        this.ripple(f.x, f.y, 0.6 * f.size + 0.2);
    }

    // Sitting, its time has come: hop, plop, or turn a little.
    act(f) {
        const r = f.rnd();
        if (r < 0.5) {
            const i = this.nearSpot(f, f.x, f.y, HOP, f.spot);
            if (i >= 0) {
                const at = this.landing(f, i);
                this.jump(f, at.x, at.y, at.h, 'spot', i);
                return;
            }
        }
        if (r < 0.72) {
            this.plop(f, null);
            return;
        }
        f.turn = { from: f.heading, to: f.heading + (f.rnd() - 0.5) * 2.4, t: 0 };
        f.t = 0;
        f.next = 2 + 7 * f.rnd();
    }

    step(f, dt) {
        f.t += dt;
        if (f.state === SIT) {
            if (f.threat && f.t >= f.calm) {
                this.plop(f, Math.atan2(-f.threat.y, -f.threat.x));
                return;
            }
            if (f.turn) {
                f.turn.t = Math.min(1, f.turn.t + dt / 0.25);
                f.heading = f.turn.from + (f.turn.to - f.turn.from) * smoothstep(0, 1, f.turn.t);
                if (f.turn.t >= 1) f.turn = null;
            }
            if (f.t >= f.next) this.act(f);
        } else if (f.state === HOP_) {
            const hop = f.hop;
            const t = Math.min(1, f.t / hop.dur);
            f.x = wrap(hop.x0 + hop.dx * t, this.W);
            f.y = wrap(hop.y0 + hop.dy * t, this.H);
            f.h = hop.h0 + (hop.h1 - hop.h0) * t + hop.peak * 4 * t * (1 - t);
            f.pitch = 0.55 * (1 - 2 * t);
            f.leapAmount = smoothstep(0, 0.12, t) * (1 - (hop.into === 'water' ? 0 : smoothstep(0.75, 1, t)));
            if (t >= 1) {
                f.pitch = 0;
                f.leapAmount = 0;
                if (hop.into === 'water') {
                    this.dive(f);
                } else {
                    f.state = SIT;
                    f.spot = hop.spot;
                    f.h = hop.h1;
                    f.t = 0;
                    f.calm = 0;
                    f.next = 3 + 9 * f.rnd();
                }
                f.hop = null;
            }
        } else if (f.state === UNDER) {
            if (f.t >= f.next && !f.threat) this.surface(f);
        } else if (f.state === FLOAT) {
            // Rising to float with its eyes out, legs trailing.
            f.lift = Math.min(1, f.t / 0.5);
            f.h = this.sea - (0.75 - 0.4 * f.lift) * f.size;
            f.leapAmount = 0.8;
            if (f.threat) {
                f.leapAmount = 0;
                this.dive(f);
                return;
            }
            if (f.t >= f.next) {
                f.leapAmount = 0;
                const at = this.landing(f, f.target);
                this.jump(f, at.x, at.y, at.h, 'spot', f.target);
            }
        }
    }

    // ---- every frame -----------------------------------------------------------

    // `motion`: the creatures' Motion (animate.js), only to know whether the
    // world is moving (frogs wait while it is paused).
    // `look`: the season (almanac.js): with the lilies gone, the frogs sleep
    // in the mud.
    update(world, view, motion, look) {
        const t0 = performance.now();
        const real = Number.isNaN(this.last) ? 0 : Math.min(0.1, (t0 - this.last) / 1000);
        this.last = t0;
        const dt = motion && motion.dt > 0 ? real : 0;
        this.clock += dt;
        const st = this.stats;
        if (!this.homes.length || look.lilies < 0.5) {
            this.mesh.count = 0;
            this.ripples.visible = false;
            return;
        }
        const { W, H } = this;
        // The camera in the world.
        const cx = wrap(view.fx + view.camX, W);
        const cz = wrap(view.fz + view.camZ, H);
        const cy = view.camY;
        const reach = Math.min(REACH, (SIZE[1] * 0.85) / (MIN_PX * view.unitPx));
        // Which homes have a frog: again when the camera has moved a little,
        // or now and then.
        const was = this.chosen ?? (this.chosen = { x: NaN, y: 0, z: 0, reach: 0, frame: 0 });
        if (++was.frame >= 30 || Math.abs(wrapDelta(cx - was.x, W)) + Math.abs(wrapDelta(cz - was.z, H)) + Math.abs(cy - was.y) > 2
            || Math.abs(reach - was.reach) > 0.03 * reach || Number.isNaN(was.x)) {
            this.choose(cx, cy, cz, reach);
            Object.assign(was, { x: cx, y: cy, z: cz, reach, frame: 0 });
        }
        this.scare(world, cx, cz);

        let k = 0;
        const te = this.mesh.instanceMatrix.array;
        const tc = this.mesh.instanceColor.array;
        const tl = this.leap.array;
        for (const f of this.frogs) {
            if (f.home < 0) continue;
            this.step(f, dt);
            if (f.state === UNDER) continue;
            const rx = wrapDelta(f.x - view.fx, W);
            const rz = wrapDelta(f.y - view.fz, H);
            const d = Math.hypot(rx - view.camX, f.h - cy, rz - view.camZ);
            const fade = 1 - smoothstep(0.85 * reach, reach, d);
            if (fade <= 0) continue;
            const sc = f.size * fade;
            const ch = Math.cos(f.heading);
            const sh = Math.sin(f.heading);
            const cp = Math.cos(f.pitch);
            const sp = Math.sin(f.pitch);
            const o = k * 16;
            te[o] = ch * cp * sc;
            te[o + 1] = sp * sc;
            te[o + 2] = sh * cp * sc;
            te[o + 3] = 0;
            te[o + 4] = -ch * sp * sc;
            te[o + 5] = cp * sc;
            te[o + 6] = -sh * sp * sc;
            te[o + 7] = 0;
            te[o + 8] = -sh * sc;
            te[o + 9] = 0;
            te[o + 10] = ch * sc;
            te[o + 11] = 0;
            te[o + 12] = rx;
            te[o + 13] = f.h;
            te[o + 14] = rz;
            te[o + 15] = 1;
            tc[k * 3] = f.tint[0];
            tc[k * 3 + 1] = f.tint[1];
            tc[k * 3 + 2] = f.tint[2];
            tl[k] = f.leapAmount;
            k++;
        }
        this.mesh.count = k;
        if (k) {
            for (const [attr, size] of [[this.mesh.instanceMatrix, 16], [this.mesh.instanceColor, 3], [this.leap, 1]]) {
                attr.clearUpdateRanges();
                attr.addUpdateRange(0, k * size);
                attr.needsUpdate = true;
            }
        }
        const u = this.rippleUniforms;
        u.uOrigin.value.set(view.fx, view.fz);
        u.uTime.value = this.clock;
        this.ripples.visible = this.clock - this.lastRipple < RIPPLE_LIFE + 0.5;
        st.active = this.byHome.size;
        st.drawn = k;
        st.frameMs = performance.now() - t0;
        st.frameAvg += (st.frameMs - st.frameAvg) * 0.05;
    }

    // Give the nearest homes in reach a frog (at most POOL), and free the
    // frogs whose homes have left it. Homes are few (a hundred or so), so a
    // pass over all of them is cheap.
    choose(cx, cy, cz, reach) {
        const { W, H, homes } = this;
        const near = this.near ?? (this.near = []);
        near.length = 0;
        if (reach > 10) {
            for (let i = 0; i < homes.length; i++) {
                const h = homes[i];
                const dx = wrapDelta(h.x - cx, W);
                const dz = wrapDelta(h.y - cz, H);
                if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
                const d = Math.hypot(dx, h.h - cy, dz);
                if (d < reach) near.push(i, d);
            }
        }
        let keep = near.length / 2;
        if (keep > POOL) {
            // The nearest POOL of them.
            const order = Array.from({ length: keep }, (_, j) => j).sort((a, b) => near[a * 2 + 1] - near[b * 2 + 1]);
            const kept = order.slice(0, POOL).map((j) => near[j * 2]);
            near.length = 0;
            for (const i of kept) near.push(i, 0);
            keep = POOL;
        }
        const wanted = this.wanted ?? (this.wanted = new Set());
        wanted.clear();
        for (let j = 0; j < keep; j++) wanted.add(near[j * 2]);
        for (const [home, f] of this.byHome) {
            if (wanted.has(home)) continue;
            f.home = -1;
            this.byHome.delete(home);
        }
        for (const home of wanted) {
            if (this.byHome.has(home)) continue;
            const f = this.frogs.find((g) => g.home < 0);
            if (!f) break;
            this.spawn(f, home);
            this.byHome.set(home, f);
        }
    }

    // Any creature within SCARE of a frog (sitting, or floating) is a threat:
    // the frog will jump away from the nearest. One pass over the creatures
    // near the camera.
    scare(world, cx, cz) {
        const { W, H } = this;
        const active = this.active ?? (this.active = []);
        active.length = 0;
        // The box around the frogs (from the camera), widened by the scare.
        let x0 = Infinity;
        let x1 = -Infinity;
        let z0 = Infinity;
        let z1 = -Infinity;
        for (const f of this.frogs) {
            f.threat = null;
            if (f.home < 0 || f.state === HOP_) continue;
            active.push(f);
            const dx = wrapDelta(f.x - cx, W);
            const dz = wrapDelta(f.y - cz, H);
            if (dx < x0) x0 = dx;
            if (dx > x1) x1 = dx;
            if (dz < z0) z0 = dz;
            if (dz > z1) z1 = dz;
        }
        if (!active.length) return;
        const pad = SCARE * 1.6;
        x0 -= pad;
        x1 += pad;
        z0 -= pad;
        z1 += pad;
        for (const pop of [world.herbivores, world.carnivores, world.humans]) {
            const { x, y, n } = pop;
            for (let i = 0; i < n; i++) {
                const dx = wrapDelta(x[i] - cx, W);
                if (dx < x0 || dx > x1) continue;
                const dz = wrapDelta(y[i] - cz, H);
                if (dz < z0 || dz > z1) continue;
                for (const f of active) {
                    const ex = wrapDelta(x[i] - f.x, W);
                    const ey = wrapDelta(y[i] - f.y, H);
                    const d2 = ex * ex + ey * ey;
                    const r = f.state === UNDER ? pad : SCARE;
                    if (d2 < r * r && (!f.threat || d2 < f.threat.d2)) f.threat = { x: ex, y: ey, d2 };
                }
            }
        }
    }

    ripple(x, y, size) {
        const now = this.clock;
        for (const [delay, scale] of [[0, 1], [0.28, 0.6]]) {
            const i = this.rippleNext++ % RIPPLES;
            this.rippleData.set([x, this.sea + 0.04, y, now + delay], i * 4);
            this.rippleSize[i] = size * scale * 1.6;
        }
        this.rippleAttr.needsUpdate = true;
        this.rippleSizeAttr.needsUpdate = true;
        this.lastRipple = now;
        this.ripples.visible = true;
    }

    // Dev: every frog near the camera does something now.
    stir() {
        for (const f of this.frogs) if (f.home >= 0) f.next = 0;
    }
}
