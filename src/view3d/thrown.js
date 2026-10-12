// Spears in the air: the player's, which really fly (the simulation's
// spears.js; world.spears), and everyone else's, which are only drawn.
//
// - The player's: each snapshot says where each spear is, its velocity and
//   how far through its range (world.spears, as of world.spearsAt). They fly
//   straight at a fixed speed, so where one is at the moment drawn
//   (world.shown) is known exactly: no blending needed. It rises a little
//   and comes down at the end of its range.
// - Everyone else's: a `throw` event (with `hit`, the outcome decided on the
//   spot, humans.js) becomes a spear drawn from the thrower to the target in
//   DRAWN seconds; a miss flies a little past and sticks in the ground. The
//   thrower plays its throw.
// - A spear of the player's that came down (`miss`) stands stuck in the
//   ground for a moment.
//
// Drawing only, like the rest of the view: one instanced mesh for them all.
import * as THREE from 'three';
import { POSE } from './animate.js';
import { offScreen } from './creatures.js';
import { part, merge } from './shapes.js';
import { wrapDelta } from './util.js';

const CAP = 64;          // drawn spears (others' and stuck ones) at most, the oldest let go first
const DRAWN = 0.4;       // seconds (at 1×) another's spear is in the air
const STUCK = 2;         // seconds a spear that came down stands in the ground
const RELEASE = 3.2;     // the height a spear leaves the hand at
const LOFT = 0.07;       // its arc rises this fraction of its length above the straight line
const AT_BODY = 2.0;     // the height it strikes a body at
const OVERSHOOT = 0.25;  // a miss flies this fraction farther than the target
const LENGTH = 3.6;      // the spear itself
const MIN_PX = 2;        // a spear shorter than this on screen is not drawn
const SHAFT = '#b39a72';

// A spear lying along +X, its middle at the origin: a shaft and a darker,
// knapped point.
export function spearShape() {
    return merge([
        part(new THREE.BoxGeometry(LENGTH - 0.4, 0.14, 0.14), { at: [-0.2, 0, 0], shade: 1 }),
        part(new THREE.OctahedronGeometry(0.22, 0), { at: [LENGTH / 2 - 0.25, 0, 0], scale: [2.3, 1, 1], shade: 0.32 }),
    ]);
}

// The height of a spear above the ground, `p` (0..1) along a flight `len`
// long that starts RELEASE high and ends `end` high; and its slope there.
const lift = (p, len, end) => RELEASE + (end - RELEASE) * p + 4 * LOFT * len * p * (1 - p);
const slope = (p, len, end) => (end - RELEASE + 4 * LOFT * len * (1 - 2 * p)) / len;

export class Thrown {
    constructor(scene) {
        this.mesh = new THREE.InstancedMesh(
            spearShape(),
            new THREE.MeshLambertMaterial({ color: SHAFT, vertexColors: true, flatShading: true }),
            CAP * 4,
        );
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.frustumCulled = false; // each is checked against the view as it is written
        this.mesh.count = 0;
        scene.add(this.mesh);
        // Drawn ones: a ring, the oldest at `start`. (x0, y0) → (x1, y1),
        // ending `end` high; from t0 (seconds at 1×), flying for `fly`, then
        // stuck for `stay` (0: gone when it lands).
        this.ring = { start: 0, count: 0 };
        for (const f of ['x0', 'y0', 'x1', 'y1', 'end', 't0', 'fly', 'stay']) this.ring[f] = new Float64Array(CAP);
        this.clock = 0;
    }

    // A new world: nothing in the air.
    attach() {
        this.ring.start = 0;
        this.ring.count = 0;
    }

    add(x0, y0, x1, y1, end, fly, stay) {
        const r = this.ring;
        const j = (r.start + r.count) % CAP;
        if (r.count < CAP) r.count++;
        else r.start = (r.start + 1) % CAP;
        r.x0[j] = x0;
        r.y0[j] = y0;
        r.x1[j] = x1;
        r.y1[j] = y1;
        r.end[j] = end;
        r.t0[j] = this.clock;
        r.fly[j] = fly;
        r.stay[j] = stay;
    }

    // What happened (world.events, this frame's), with the motion (poses)
    // and `self`, the body the page plays (it poses itself).
    handle(events, motion, self = 0) {
        for (let k = 0; k < events.length; k++) {
            const e = events[k];
            if (e.type === 'throw') {
                if (e.hit === undefined) continue; // the player's: a real spear, in world.spears
                if (e.id !== self) motion?.pose(e.id, POSE.THROW);
                if (e.hit) this.add(e.x, e.y, e.tx, e.ty, AT_BODY, DRAWN, 0);
                else this.add(e.x, e.y, e.x + (e.tx - e.x) * (1 + OVERSHOOT), e.y + (e.ty - e.y) * (1 + OVERSHOOT), 0, DRAWN, STUCK);
            } else if (e.type === 'jab') {
                if (e.id !== self) motion?.pose(e.id, POSE.JAB);
            } else if (e.type === 'miss') {
                // The player's, come down, leaning back the way it flew.
                this.add(e.x - (e.dx ?? 0), e.y - (e.dy ?? 0), e.x, e.y, 0, 0, STUCK);
            }
        }
    }

    // Write every spear in view. world: the Mirror (spears, spearsAt,
    // shown, p.play); ground: world x, y → height; clock: seconds at 1×
    // (the motion's clock).
    update(world, view, ground, clock) {
        this.clock = clock;
        this.view = view;
        this.ground = ground;
        this.k = 0;
        const r = this.ring;
        while (r.count && clock - r.t0[r.start] > r.fly[r.start] + r.stay[r.start]) {
            r.start = (r.start + 1) % CAP;
            r.count--;
        }
        const W = view.W;
        const H = view.H;
        for (let q = 0; q < r.count; q++) {
            const j = (r.start + q) % CAP;
            const t = clock - r.t0[j];
            const dx = wrapDelta(r.x1[j] - r.x0[j], W);
            const dy = wrapDelta(r.y1[j] - r.y0[j], H);
            const len = Math.hypot(dx, dy);
            if (t < r.fly[j]) {
                const p = t / r.fly[j];
                const x = r.x0[j] + dx * p;
                const y = r.y0[j] + dy * p;
                this.put(x, y, lift(p, len, r.end[j]), Math.atan2(dy, dx), Math.atan(slope(p, len, r.end[j])));
            } else if (r.stay[j] > 0) {
                this.stuck(r.x1[j], r.y1[j], Math.atan2(dy, dx));
            }
        }
        // The player's, where they are at the moment drawn.
        const s = world.spears;
        if (s && s.length) {
            const Q = world.p.play;
            const ago = (world.spearsAt ?? world.time) - (world.shown ?? world.time);
            for (let k = 0; k + 4 < s.length; k += 5) {
                const vx = s[k + 2];
                const vy = s[k + 3];
                const speed = Math.hypot(vx, vy);
                // (Its range follows from its speed: a heavier throw goes faster and farther.)
                const power = Q.heavySpeed > Q.throwSpeed ? (speed - Q.throwSpeed) / (Q.heavySpeed - Q.throwSpeed) : 0;
                const range = Q.throwRange + (Q.heavyRange - Q.throwRange) * Math.min(1, Math.max(0, power));
                const p = s[k + 4] - (ago * speed) / range;
                if (p < 0 || p > 1) continue; // not thrown yet at the moment drawn, or down
                const x = s[k] - vx * ago;
                const y = s[k + 1] - vy * ago;
                this.put(x, y, lift(p, range, 0), Math.atan2(vy, vx), Math.atan(slope(p, range, 0)));
            }
        }
        const mesh = this.mesh;
        mesh.count = this.k;
        if (this.k) {
            mesh.instanceMatrix.clearUpdateRanges();
            mesh.instanceMatrix.addUpdateRange(0, this.k * 16);
            mesh.instanceMatrix.needsUpdate = true;
        }
    }

    // A spear stuck in the ground at (x, y), leaning back the way it came.
    stuck(x, y, heading) {
        const tilt = -0.95;
        const back = Math.cos(tilt) * (LENGTH / 2 - 0.3);
        this.put(x - Math.cos(heading) * back, y - Math.sin(heading) * back, -Math.sin(tilt) * (LENGTH / 2 - 0.3), heading, tilt);
    }

    // One spear, its middle at (x, y) and `h` above the ground there,
    // pointing along `heading` tipped by `pitch` (up positive); at each of
    // its copies in view.
    put(x, y, h, heading, pitch) {
        const v = this.view;
        const { W, H, fx, fz, minX, maxX, minZ, maxZ, camX, camY, camZ, planes, unitPx } = v;
        const near2 = v.personalSpace * v.personalSpace;
        const gy = this.ground(x, y) + h;
        const dx = wrapDelta(x - fx, W);
        const dz = wrapDelta(y - fz, H);
        const ax0 = Math.ceil((minX - dx) / W);
        const ax1 = Math.floor((maxX - dx) / W);
        const az0 = Math.ceil((minZ - dz) / H);
        const az1 = Math.floor((maxZ - dz) / H);
        const c = Math.cos(heading);
        const s = Math.sin(heading);
        const cp = Math.cos(pitch);
        const sp = Math.sin(pitch);
        const te = this.mesh.instanceMatrix.array;
        const room = this.mesh.instanceMatrix.count;
        for (let ax = ax0; ax <= ax1; ax++) {
            for (let az = az0; az <= az1; az++) {
                const rx = dx + ax * W;
                const rz = dz + az * H;
                const ex = rx - camX;
                const ey = gy - camY;
                const ez = rz - camZ;
                const d2 = ex * ex + ey * ey + ez * ez;
                if (d2 < near2 || LENGTH < MIN_PX * Math.sqrt(d2) * unitPx) continue;
                if (offScreen(planes, rx, gy, rz, LENGTH / 2) || this.k >= room) continue;
                // Columns: along the spear (+X, turned and tipped), up, and across.
                const o = this.k++ * 16;
                te[o] = c * cp;
                te[o + 1] = sp;
                te[o + 2] = s * cp;
                te[o + 3] = 0;
                te[o + 4] = -c * sp;
                te[o + 5] = cp;
                te[o + 6] = -s * sp;
                te[o + 7] = 0;
                te[o + 8] = -s;
                te[o + 9] = 0;
                te[o + 10] = c;
                te[o + 11] = 0;
                te[o + 12] = rx;
                te[o + 13] = gy;
                te[o + 14] = rz;
                te[o + 15] = 1;
            }
        }
    }
}
