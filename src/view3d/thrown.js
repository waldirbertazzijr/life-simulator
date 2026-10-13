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
// - Arrows (package 3): a throw with a bow (`weapon` says so) is an arrow,
//   quicker and flatter, and the archer draws and looses (SHOOT). The
//   player's own flights say their kind (world.spears: an arrow, or a
//   spear; a volley is three real arrows); one that came down is an arrow
//   while it holds a bow. A club's blow (`swing`) is only the swing.
//
// Drawing only, like the rest of the view: one instanced mesh for all the
// spears, one for all the arrows.
import * as THREE from 'three';
import { POSE } from './animate.js';
import { offScreen } from './creatures.js';
import { part, merge } from './shapes.js';
import { wrapDelta } from './util.js';
import { kindName } from '../play/gear.js';
import { SPEAR_STRIDE } from '../spears.js';
import { showWhile } from './items.js';

const CAP = 64;          // drawn spears and arrows (others' and stuck ones) at most, the oldest let go first
const DRAWN = 0.4;       // seconds (at 1×) another's spear is in the air
const STUCK = 2;         // seconds a spear that came down stands in the ground
const RELEASE = 3.2;     // the height a spear leaves the hand at
const LOFT = 0.07;       // its arc rises this fraction of its length above the straight line
const AT_BODY = 2.0;     // the height it strikes a body at
const OVERSHOOT = 0.25;  // a miss flies this fraction farther than the target
const LENGTH = 3.6;      // the spear itself
const MIN_PX = 2;        // a spear shorter than this on screen is not drawn
const SHAFT = '#b39a72';
// Arrows: shorter, quicker, flatter.
// (Its speed and reach × a spear's, should the parameters not say.)
const ARROW = { length: 2.2, drawn: 0.25, loft: 0.03, speed: 1.6, range: 1.6 };

// A spear lying along +X, its middle at the origin: a shaft and a darker,
// knapped point.
export function spearShape() {
    return merge([
        part(new THREE.BoxGeometry(LENGTH - 0.4, 0.14, 0.14), { at: [-0.2, 0, 0], shade: 1 }),
        part(new THREE.OctahedronGeometry(0.22, 0), { at: [LENGTH / 2 - 0.25, 0, 0], scale: [2.3, 1, 1], shade: 0.32 }),
    ]);
}

// An arrow along +X, its middle at the origin: a thin shaft, a small point
// and pale fletching.
export function arrowShape() {
    const L = ARROW.length;
    return merge([
        part(new THREE.BoxGeometry(L - 0.2, 0.06, 0.06), { at: [-0.1, 0, 0], shade: 1 }),
        part(new THREE.OctahedronGeometry(0.11, 0), { at: [L / 2 - 0.12, 0, 0], scale: [2.2, 1, 0.8], shade: 0.32 }),
        part(new THREE.BoxGeometry(0.42, 0.2, 0.012), { at: [-L / 2 + 0.25, 0.08, 0], shade: 1.5 }),
        part(new THREE.BoxGeometry(0.42, 0.012, 0.2), { at: [-L / 2 + 0.25, 0, 0.08], shade: 1.5 }),
    ]);
}

// The height of a spear above the ground, `p` (0..1) along a flight `len`
// long that starts RELEASE high and ends `end` high; and its slope there.
const lift = (p, len, end, loft = LOFT) => RELEASE + (end - RELEASE) * p + 4 * loft * len * p * (1 - p);
const slope = (p, len, end, loft = LOFT) => (end - RELEASE + 4 * loft * len * (1 - 2 * p)) / len;

const instanced = (scene, geometry) => {
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ color: SHAFT, vertexColors: true, flatShading: true }), CAP * 4);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // each is checked against the view as it is written
    mesh.count = 0;
    scene.add(mesh);
    return mesh;
};

// Does the player hold a bow? (Its flights are then arrows.)
export function playerBow(world) {
    const p = world.player;
    if (!p || !p.weapon || !(world.items instanceof Map)) return false;
    return kindName(world.items.get(p.weapon)?.kind) === 'bow';
}

export class Thrown {
    constructor(scene) {
        this.mesh = instanced(scene, spearShape());
        this.arrows = instanced(scene, arrowShape());
        // Drawn ones: a ring, the oldest at `start`. (x0, y0) → (x1, y1),
        // ending `end` high; from t0 (seconds at 1×), flying for `fly`, then
        // stuck for `stay` (0: gone when it lands); `arrow` 1 for an arrow.
        this.ring = { start: 0, count: 0 };
        for (const f of ['x0', 'y0', 'x1', 'y1', 'end', 't0', 'fly', 'stay', 'arrow']) this.ring[f] = new Float64Array(CAP);
        this.clock = 0;
    }

    // A new world: nothing in the air.
    attach() {
        this.ring.start = 0;
        this.ring.count = 0;
    }

    add(x0, y0, x1, y1, end, fly, stay, arrow = 0) {
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
        r.arrow[j] = arrow;
    }

    // What happened (world.events, this frame's), with the motion (poses)
    // and `self`, the body the page plays (it poses itself). `bow`: whether
    // the player holds a bow (its miss is an arrow).
    handle(events, motion, self = 0, bow = false) {
        for (let k = 0; k < events.length; k++) {
            const e = events[k];
            if (e.type === 'throw') {
                if (e.hit === undefined) continue; // the player's: a real spear, in world.spears
                const arrow = kindName(e.weapon) === 'bow' ? 1 : 0;
                const fly = arrow ? ARROW.drawn : DRAWN;
                if (e.id !== self) motion?.pose(e.id, arrow ? POSE.SHOOT : POSE.THROW);
                if (e.hit) this.add(e.x, e.y, e.tx, e.ty, AT_BODY, fly, 0, arrow);
                else this.add(e.x, e.y, e.x + (e.tx - e.x) * (1 + OVERSHOOT), e.y + (e.ty - e.y) * (1 + OVERSHOOT), 0, fly, STUCK, arrow);
            } else if (e.type === 'jab') {
                if (e.id !== self) motion?.pose(e.id, POSE.JAB);
            } else if (e.type === 'swing') {
                if (e.id !== self) motion?.pose(e.id, POSE.SWING); // (a club: no flight)
            } else if (e.type === 'miss') {
                // The player's, come down, leaning back the way it flew.
                this.add(e.x - (e.dx ?? 0), e.y - (e.dy ?? 0), e.x, e.y, 0, 0, STUCK, bow ? 1 : 0);
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
        this.ka = 0;
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
            const arrow = r.arrow[j] === 1;
            const loft = arrow ? ARROW.loft : LOFT;
            if (t < r.fly[j]) {
                const p = t / r.fly[j];
                const x = r.x0[j] + dx * p;
                const y = r.y0[j] + dy * p;
                this.put(x, y, lift(p, len, r.end[j], loft), Math.atan2(dy, dx), Math.atan(slope(p, len, r.end[j], loft)), arrow);
            } else if (r.stay[j] > 0) {
                this.stuck(r.x1[j], r.y1[j], Math.atan2(dy, dx), arrow);
            }
        }
        // The player's, where they are at the moment drawn: spears and arrows
        // (SPEAR_STRIDE numbers each, the last its kind).
        const s = world.spears;
        if (s && s.length) {
            const Q = world.p.play;
            const I = world.p.items;
            const ago = (world.spearsAt ?? world.time) - (world.shown ?? world.time);
            for (let k = 0; k + SPEAR_STRIDE - 1 < s.length; k += SPEAR_STRIDE) {
                const vx = s[k + 2];
                const vy = s[k + 3];
                const arrow = kindName(s[k + 5]) === 'bow';
                // (Its range follows from its speed: a heavier throw goes
                // faster and farther; an arrow both, by items.arrowSpeed and
                // items.arrowRange.)
                const fast = arrow ? I?.arrowSpeed ?? ARROW.speed : 1;
                const speed = Math.hypot(vx, vy);
                const power = Q.heavySpeed > Q.throwSpeed ? (speed / fast - Q.throwSpeed) / (Q.heavySpeed - Q.throwSpeed) : 0;
                const range = (Q.throwRange + (Q.heavyRange - Q.throwRange) * Math.min(1, Math.max(0, power))) * (arrow ? I?.arrowRange ?? ARROW.range : 1);
                const p = s[k + 4] - (ago * speed) / range;
                if (p < 0 || p > 1) continue; // not thrown yet at the moment drawn, or down
                const x = s[k] - vx * ago;
                const y = s[k + 1] - vy * ago;
                const loft = arrow ? ARROW.loft : LOFT;
                this.put(x, y, lift(p, range, 0, loft), Math.atan2(vy, vx), Math.atan(slope(p, range, 0, loft)), arrow);
            }
        }
        for (const [mesh, n] of [[this.mesh, this.k], [this.arrows, this.ka]]) {
            mesh.count = n;
            if (mesh === this.arrows) showWhile(mesh, n);
            if (!n) continue;
            mesh.instanceMatrix.clearUpdateRanges();
            mesh.instanceMatrix.addUpdateRange(0, n * 16);
            mesh.instanceMatrix.needsUpdate = true;
        }
    }

    // A spear (or arrow) stuck in the ground at (x, y), leaning back the way it came.
    stuck(x, y, heading, arrow = false) {
        const tilt = arrow ? -0.6 : -0.95;
        const half = (arrow ? ARROW.length : LENGTH) / 2 - 0.3;
        const back = Math.cos(tilt) * half;
        this.put(x - Math.cos(heading) * back, y - Math.sin(heading) * back, -Math.sin(tilt) * half, heading, tilt, arrow);
    }

    // One spear (or arrow), its middle at (x, y) and `h` above the ground
    // there, pointing along `heading` tipped by `pitch` (up positive); at
    // each of its copies in view.
    put(x, y, h, heading, pitch, arrow = false) {
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
        const mesh = arrow ? this.arrows : this.mesh;
        const length = arrow ? ARROW.length : LENGTH;
        const te = mesh.instanceMatrix.array;
        const room = mesh.instanceMatrix.count;
        for (let ax = ax0; ax <= ax1; ax++) {
            for (let az = az0; az <= az1; az++) {
                const rx = dx + ax * W;
                const rz = dz + az * H;
                const ex = rx - camX;
                const ey = gy - camY;
                const ez = rz - camZ;
                const d2 = ex * ex + ey * ey + ez * ez;
                if (d2 < near2 || length < MIN_PX * Math.sqrt(d2) * unitPx) continue;
                if (offScreen(planes, rx, gy, rz, length / 2) || (arrow ? this.ka : this.k) >= room) continue;
                // Columns: along the spear (+X, turned and tipped), up, and across.
                const o = (arrow ? this.ka++ : this.k++) * 16;
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
