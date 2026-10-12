// Death and blood: the dead lying where they fell, dark sprays and pools.
//
// Drawing only, like the rest of the view. What happens comes from the
// world's events (a death, a spear or a jab striking, a butchering stroke),
// and the marks it leaves fade with the world's time. Everything lives in
// rings of a fixed size, so a massacre at 256× costs no more than a quiet
// day: past the cap, the oldest go first (and the oldest few are already
// sinking away, so none vanishes at once).
//
// - Carcasses: only their record is kept here; creatures.js draws them as
//   extra instances of their species, fallen over (the FALL pose). The
//   player's kills wait in the simulation to be butchered (spears.js), so
//   while it lists one (follow) its body stays (keep), shrinking as it is
//   cut up (cut), and goes when it is done (removeCarcass) or fades if left.
// - Sprays: a few small faceted droplets thrown up and out, which fall back
//   and lie on the ground for a moment.
// - Pools: dark, matte patches on the ground that spread, then fade.
//
// The Blood setting (on unless `?noblood`, or switched off before) hides
// sprays and pools; carcasses fall either way.
import * as THREE from 'three';
import { POSE, KINDS } from './animate.js';
import { SPECIES, offScreen } from './creatures.js';
import { wrapDelta } from './util.js';

const TAU = Math.PI * 2;
export const BLOOD = '#6e0f0f';  // droplets
const POOL_COLOR = '#560c0c';    // pools: darker, soaking in
const LIFE = 600;                // steps a carcass, and a pool, lasts
const CAPS = { carcasses: 300, droplets: 2000, pools: 300 };
const MARGIN = 30;               // near a cap, this many of the oldest are on their way out
const DROPS = 14;                // droplets in a spray of amount 1 (a kill)
const DROP = 0.17;               // a droplet's radius
const G = 24;                    // gravity on droplets, units/s² (seconds at 1×)
const LINGER = 0.5;              // seconds a droplet lies on the ground before it is gone
const MIN_PX = 0.6;              // droplets smaller than this on screen are not drawn
const POOL_SIZE = { herbivore: 2.3, carnivore: 2.4, human: 1.8 }; // radius under a carcass
const SPREAD = 1.5;              // seconds for a pool to spread
const POOL_ALPHA = 0.85;
const POOL_MIN_PX = 4;           // in the map view, pools stay at least this wide
const LIFT = 0.06;               // pools float this far above the ground (with a polygon offset)
const VIOLENT = new Set(['eaten', 'hunted', 'killed']);
const HIT = 0.8;                 // a spray's amount for a spear or a jab striking...
const STROKE = 0.4;              // ...and for a butchering stroke
const WOUND = 0.3;               // a blow goes in this far (× the body's length) from its middle
const KEEP_AGE = LIFE / 2;       // a kept carcass this old moves to the young end of the ring

// The Blood setting until the page says otherwise (main.js keeps it and
// calls setBlood): on, unless `?noblood` or switched off before (in
// localStorage, under main.js's key).
export function wantsBlood() {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('noblood')) return false;
    try {
        return localStorage.getItem('life-simulator.blood') !== 'off';
    } catch {
        return true;
    }
}

// A ring of records: parallel typed arrays, the oldest at `start`.
function ring(cap, fields) {
    const r = { cap, start: 0, count: 0 };
    for (const [name, Type] of Object.entries(fields)) r[name] = new Type(cap);
    return r;
}
// The slot for a new record: past the cap, the oldest's.
function push(r) {
    const j = (r.start + r.count) % r.cap;
    if (r.count < r.cap) r.count++;
    else r.start = (r.start + 1) % r.cap;
    return j;
}
// Let go of records born more than LIFE steps before `shown`.
function expire(r, shown) {
    while (r.count && shown - r.born[r.start] > LIFE) {
        r.start = (r.start + 1) % r.cap;
        r.count--;
    }
}
// How far a record has faded, 0..1: over the last 30% of its life, or as it
// nears its turn to go when the ring is nearly full (`rank` 0: next to go).
function fadeOf(age, rank) {
    const a = (age - LIFE * 0.7) / (LIFE * 0.3);
    const b = 1 - rank / MARGIN;
    const f = a > b ? a : b;
    return f < 0 ? 0 : f > 1 ? 1 : f;
}

// A flat, slightly ragged disc lying in the XZ plane, radius about 1.
function poolGeometry() {
    const g = new THREE.CircleGeometry(1, 9);
    const p = g.attributes.position;
    const ragged = [1, 0.82, 1.08, 0.9, 1.02, 0.78, 0.96, 1.1, 0.86];
    for (let v = 1; v < p.count; v++) {
        const r = ragged[(v - 1) % ragged.length];
        p.setXY(v, p.getX(v) * r, p.getY(v) * r);
    }
    g.rotateX(-Math.PI / 2);
    return g;
}

// Write a 3×3 basis (columns, scaled per column) and a position into a
// matrix at offset o.
function place(te, o, B, b, sx, sy, sz, x, y, z) {
    te[o] = B[b] * sx;
    te[o + 1] = B[b + 1] * sx;
    te[o + 2] = B[b + 2] * sx;
    te[o + 3] = 0;
    te[o + 4] = B[b + 3] * sy;
    te[o + 5] = B[b + 4] * sy;
    te[o + 6] = B[b + 5] * sy;
    te[o + 7] = 0;
    te[o + 8] = B[b + 6] * sz;
    te[o + 9] = B[b + 7] * sz;
    te[o + 10] = B[b + 8] * sz;
    te[o + 11] = 0;
    te[o + 12] = x;
    te[o + 13] = y;
    te[o + 14] = z;
    te[o + 15] = 1;
}

export class Effects {
    // motion: the creatures' Motion (animate.js), which knows how the dead
    // looked and takes the killers' poses.
    constructor(scene, motion) {
        this.motion = motion;
        this.ground = () => 0;
        this.blood = wantsBlood();
        this.clock = 0; // seconds at 1× (Motion's clock)
        this.shown = 0; // the moment drawn, in steps

        // (gone: not drawn any more; cut: how much of it is butchered, 0..1)
        this.dead = ring(CAPS.carcasses, {
            kind: Uint8Array, id: Float64Array, x: Float64Array, y: Float64Array, heading: Float64Array,
            gy: Float64Array, born: Float64Array, t0: Float64Array, scale: Float64Array, tribe: Float64Array, fade: Float64Array,
            gone: Uint8Array, cut: Float64Array,
        });
        this.kept = new Map();   // the player's kills the simulation still has: id → slot in `dead`
        this.listed = new Set(); // (scratch for follow)
        this.drops = ring(CAPS.droplets, {
            x: Float64Array, y: Float64Array, h: Float64Array, vx: Float64Array, vy: Float64Array, vh: Float64Array,
            t0: Float64Array, land: Float64Array, size: Float64Array, gy: Float64Array,
        });
        this.pools = ring(CAPS.pools, {
            x: Float64Array, y: Float64Array, gy: Float64Array, size: Float64Array, t0: Float64Array, born: Float64Array,
        });
        this.pools.basis = new Float64Array(CAPS.pools * 9); // how each lies: along, normal, across
        // Each droplet slot has a turn of its own, so the facets catch the light differently.
        this.turns = new Float64Array(CAPS.droplets * 9);
        const q = new THREE.Quaternion();
        const m = new THREE.Matrix4();
        for (let k = 0; k < CAPS.droplets; k++) {
            q.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
            const e = m.makeRotationFromQuaternion(q).elements;
            this.turns.set([e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]], k * 9);
        }

        // Room for every record at a few of the world's copies (the map view
        // shows up to nine; past the room, the rest are not drawn).
        this.dropMesh = new THREE.InstancedMesh(
            new THREE.OctahedronGeometry(1, 0),
            new THREE.MeshLambertMaterial({ color: BLOOD, flatShading: true }),
            CAPS.droplets * 2,
        );
        const poolMaterial = new THREE.MeshLambertMaterial({
            color: POOL_COLOR, transparent: true, depthWrite: false, flatShading: true,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6,
        });
        // Each pool fades on its own: an opacity per instance.
        poolMaterial.onBeforeCompile = (shader) => {
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nattribute float alpha;\nvarying float vAlpha;')
                .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = alpha;');
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
                .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse, opacity * vAlpha );');
        };
        poolMaterial.customProgramCacheKey = () => 'pools';
        const poolGeo = poolGeometry();
        this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(CAPS.pools * 9), 1).setUsage(THREE.DynamicDrawUsage);
        poolGeo.setAttribute('alpha', this.alpha);
        this.poolMesh = new THREE.InstancedMesh(poolGeo, poolMaterial, CAPS.pools * 9);
        this.poolMesh.renderOrder = 1; // after the ground, so it darkens it
        for (const mesh of [this.dropMesh, this.poolMesh]) {
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            mesh.frustumCulled = false; // checked one by one as they are written
            mesh.count = 0;
            scene.add(mesh);
        }
    }

    // A new world: its ground (world x, y → height), and nothing has happened yet.
    attach(ground) {
        this.ground = ground;
        for (const r of [this.dead, this.drops, this.pools]) {
            r.start = 0;
            r.count = 0;
        }
        this.kept.clear();
        this.clock = 0;
        this.shown = 0;
    }

    setBlood(on) {
        this.blood = !!on;
    }

    // A new frame: the clock (seconds at 1×) and the moment drawn (steps).
    // The old let go; how far each carcass has faded.
    tick(clock, shown) {
        this.clock = clock;
        this.shown = shown;
        if (this.kept.size) this.renew(shown);
        expire(this.dead, shown);
        expire(this.pools, shown);
        const d = this.drops;
        while (d.count && clock - d.t0[d.start] > d.land[d.start] + LINGER) {
            d.start = (d.start + 1) % d.cap;
            d.count--;
        }
        const c = this.dead;
        for (let q = 0; q < c.count; q++) {
            const j = (c.start + q) % c.cap;
            c.fade[j] = fadeOf(shown - c.born[j], q + c.cap - c.count);
        }
        for (const j of this.kept.values()) c.fade[j] = 0;
    }

    // Kept carcasses do not age: one half its life old moves to the young
    // end of the ring, as if it had just died (still lying, not falling).
    renew(shown) {
        const c = this.dead;
        for (const [id, j] of this.kept) {
            if (shown - c.born[j] <= KEEP_AGE) continue;
            if (c.count === c.cap) {
                // (The ring is full: the oldest makes way, and if it was kept, it is lost.)
                const lost = c.id[c.start];
                if (this.kept.get(lost) === c.start && lost !== id) this.kept.delete(lost);
            }
            const to = push(c);
            if (to !== j) {
                for (const f of ['kind', 'id', 'x', 'y', 'heading', 'gy', 't0', 'scale', 'tribe', 'cut']) c[f][to] = c[f][j];
                c.gone[j] = 1;
            }
            c.gone[to] = 0;
            c.born[to] = shown;
            this.kept.set(id, to);
        }
    }

    // The slot of the carcass of `id` in the ring, or -1.
    slotOf(id) {
        const c = this.dead;
        for (let q = c.count - 1; q >= 0; q--) {
            const j = (c.start + q) % c.cap;
            if (c.id[j] === id && !c.gone[j]) return j;
        }
        return -1;
    }

    // The player's kill `id` stays until let go (release, removeCarcass).
    // False if its body is not lying here (yet).
    keep(id) {
        if (this.kept.has(id)) return true;
        const j = this.slotOf(id);
        if (j < 0) return false;
        this.kept.set(id, j);
        return true;
    }

    // How much of it is butchered (0..1): it shrinks as it is cut up.
    cut(id, fraction) {
        const j = this.kept.get(id) ?? this.slotOf(id);
        if (j >= 0) this.dead.cut[j] = fraction;
    }

    // Gone at once (cut up).
    removeCarcass(id) {
        const j = this.kept.get(id) ?? this.slotOf(id);
        this.kept.delete(id);
        if (j >= 0) this.dead.gone[j] = 1;
    }

    // Let go: it fades from now, as any carcass at the end of its time.
    release(id) {
        const j = this.kept.get(id);
        if (j === undefined) return;
        this.kept.delete(id);
        this.dead.born[j] = Math.min(this.dead.born[j], this.shown - LIFE * 0.7);
    }

    // The simulation's list of the player's kills (world.carcasses): keep
    // and cut each one listed; let go of any it no longer lists.
    follow(list) {
        const listed = this.listed;
        listed.clear();
        for (let k = 0; k < list.length; k++) {
            const c = list[k];
            listed.add(c.id);
            if (this.keep(c.id)) this.cut(c.id, c.cut ?? 0);
        }
        if (this.kept.size > listed.size) {
            for (const id of this.kept.keys()) if (!listed.has(id)) this.release(id);
        }
    }

    // What happened (world.events, this frame's): the dead fall where they
    // died, a violent death bloodies the ground, and the killer strikes; a
    // spear or a jab striking sprays blood along the blow, and so, a little,
    // does each butchering stroke; a carcass cut up is gone. `self`: the body
    // the page plays, which strikes by itself (play/modes.js).
    handle(events, self = 0) {
        const m = this.motion;
        // At high speed a frame can bring hundreds of deaths: only the newest
        // that fit in the ring leave a body (the others would go at once).
        let older = -CAPS.carcasses;
        for (let k = 0; k < events.length; k++) if (events[k].type === 'death') older++;
        for (let k = 0; k < events.length; k++) {
            const e = events[k];
            if (e.type !== 'death') {
                this.mark(e);
                continue;
            }
            if (older-- <= 0) this.carcass(e.kind, e.id, e.x, e.y, e.heading, VIOLENT.has(e.cause));
            if (!m) continue;
            m.forget(e.id);
            if (!e.by || e.by === self) continue;
            if (e.cause === 'eaten') m.pose(e.by, POSE.POUNCE);
            else if (e.cause === 'hunted') m.pose(e.by, POSE.THROW);
            else if (e.cause === 'killed') m.pose(e.by, e.kind === 'human' ? POSE.JAB : POSE.THROW); // in a fight, or a spear at a predator
        }
    }

    // The marks of the hands' events (package 2): blood where a blow went
    // in, splashing back toward whoever struck it (who is watching); a
    // little at each butchering stroke; and a carcass cut up, or left to
    // spoil, goes.
    mark(e) {
        if (e.type === 'hit') {
            const s = SPECIES[e.kind];
            if (!s || !this.seen(e.x, e.y, this.ground(e.x, e.y))) return;
            const dx = e.dx ?? 0;
            const dy = e.dy ?? 0;
            const near = s.size * WOUND; // (its near side: the body would hide a splash from inside it)
            this.spray(e.x - dx * near, e.y - dy * near, s.center, -dx, -dy, HIT);
        } else if (e.type === 'butcher') {
            if (this.seen(e.x, e.y, this.ground(e.x, e.y))) this.spray(e.x, e.y, 0.9, 0, 0, STROKE);
        } else if (e.type === 'butchered') {
            this.removeCarcass(e.carcass);
        } else if (e.type === 'spoiled') {
            this.release(e.carcass);
        }
    }

    // A body that falls where it died and lies there for a while (LIFE
    // steps). `bloody`: with a spray and a pool.
    carcass(kind, id, x, y, heading, bloody) {
        const d = this.dead;
        const j = push(d);
        const look = this.motion?.describe(id); // its tribe's colour and its size
        d.kind[j] = KINDS.indexOf(kind);
        d.id[j] = id;
        d.x[j] = x;
        d.y[j] = y;
        d.heading[j] = heading;
        d.gy[j] = this.ground(x, y);
        d.born[j] = this.shown;
        d.t0[j] = this.clock;
        d.scale[j] = look ? look.scale : 1;
        d.tribe[j] = look ? look.tribe : 0;
        d.fade[j] = 0;
        d.gone[j] = 0;
        d.cut[j] = 0;
        for (const [kept, slot] of this.kept) if (slot === j) this.kept.delete(kept); // (pushed out of the ring)
        if (bloody) {
            const s = d.scale[j];
            this.pool(x, y, POOL_SIZE[kind] * s);
            if (this.seen(x, y, d.gy[j])) this.spray(x, y, SPECIES[kind].center * s, Math.cos(heading), Math.sin(heading), s);
        }
    }

    // Would droplets at (x, y), ground height gy, be big enough to see from
    // where the camera was last frame? (From high above they would be specks.)
    seen(x, y, gy) {
        const v = this.view;
        if (!v) return true;
        const ex = wrapDelta(x - v.fx, v.W) - v.camX;
        const ey = gy - v.camY;
        const ez = wrapDelta(y - v.fz, v.H) - v.camZ;
        return DROP * 1.3 >= MIN_PX * Math.sqrt(ex * ex + ey * ey + ez * ez) * v.unitPx;
    }

    // A spray of droplets from (x, y), `height` above the ground, thrown
    // mostly along (dirX, dirY) (0, 0: every way). `amount` 1 is a kill's.
    spray(x, y, height, dirX, dirY, amount = 1) {
        const n = Math.max(1, Math.round(DROPS * amount));
        const len = Math.hypot(dirX, dirY);
        const ux = len > 0 ? dirX / len : 0;
        const uy = len > 0 ? dirY / len : 0;
        const gy = this.ground(x, y);
        const r = this.drops;
        for (let k = 0; k < n; k++) {
            const j = push(r);
            const a = Math.random() * TAU;
            const out = 0.8 + Math.random() * 2.4;              // every way...
            const along = len > 0 ? 1.5 + Math.random() * 3 : 0; // ...and mostly this way
            const up = 2.5 + Math.random() * 4;
            r.x[j] = x;
            r.y[j] = y;
            r.h[j] = gy + height;
            r.vx[j] = ux * along + Math.cos(a) * out;
            r.vy[j] = uy * along + Math.sin(a) * out;
            r.vh[j] = up;
            r.t0[j] = this.clock;
            r.land[j] = (up + Math.sqrt(up * up + 2 * G * height)) / G; // when it reaches the ground
            r.size[j] = DROP * (0.6 + Math.random() * 0.7);
            r.gy[j] = gy;
        }
    }

    // A pool of blood at (x, y), spreading to radius `size`, lying along the
    // slope of the ground; it fades with the world's time.
    pool(x, y, size) {
        const p = this.pools;
        const j = push(p);
        const g = this.ground;
        p.x[j] = x;
        p.y[j] = y;
        p.gy[j] = g(x, y);
        p.size[j] = size;
        p.t0[j] = this.clock;
        p.born[j] = this.shown;
        // Its normal from the heights around it (world y is three.js Z),
        // and a direction along the ground, turned at random.
        let nx = (g(x - 1, y) - g(x + 1, y)) / 2;
        let ny = 1;
        let nz = (g(x, y - 1) - g(x, y + 1)) / 2;
        let l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        nz /= l;
        const a = Math.random() * TAU;
        let tx = Math.cos(a);
        let ty = 0;
        let tz = Math.sin(a);
        const dot = tx * nx + ty * ny + tz * nz;
        tx -= nx * dot;
        ty -= ny * dot;
        tz -= nz * dot;
        l = Math.hypot(tx, ty, tz);
        tx /= l;
        ty /= l;
        tz /= l;
        // Columns: along (x), the normal (y), and along × normal (z), so it is not mirrored.
        p.basis.set([tx, ty, tz, nx, ny, nz, ty * nz - tz * ny, tz * nx - tx * nz, tx * ny - ty * nx], j * 9);
    }

    // Write the droplets and pools in view (the world wraps: each at every
    // copy the camera can see, like the creatures).
    update(view) {
        this.view = view;
        if (!this.blood) {
            this.dropMesh.visible = false;
            this.poolMesh.visible = false;
            return;
        }
        this.writeDrops(view);
        this.writePools(view);
    }

    writeDrops(view) {
        const { W, H, fx, fz, minX, maxX, minZ, maxZ, camX, camY, camZ, planes, unitPx } = view;
        const near2 = view.personalSpace * view.personalSpace;
        const r = this.drops;
        const te = this.dropMesh.instanceMatrix.array;
        const room = this.dropMesh.instanceMatrix.count;
        const B = this.turns;
        let k = 0;
        for (let q = 0; q < r.count; q++) {
            const j = (r.start + q) % r.cap;
            let t = this.clock - r.t0[j];
            if (t < 0 || t > r.land[j] + LINGER) continue;
            let s = r.size[j];
            if (t > r.land[j]) {
                s *= 1 - (0.7 * (t - r.land[j])) / LINGER; // lying on the ground, soaking in
                t = r.land[j];
            }
            const h = Math.max(r.gy[j] + s * 0.4, r.h[j] + r.vh[j] * t - 0.5 * G * t * t);
            const dx = wrapDelta(r.x[j] + r.vx[j] * t - fx, W);
            const dz = wrapDelta(r.y[j] + r.vy[j] * t - fz, H);
            const ax0 = Math.ceil((minX - dx) / W);
            const ax1 = Math.floor((maxX - dx) / W);
            const az0 = Math.ceil((minZ - dz) / H);
            const az1 = Math.floor((maxZ - dz) / H);
            for (let ax = ax0; ax <= ax1; ax++) {
                for (let az = az0; az <= az1; az++) {
                    const rx = dx + ax * W;
                    const rz = dz + az * H;
                    const ex = rx - camX;
                    const ey = h - camY;
                    const ez = rz - camZ;
                    const d2 = ex * ex + ey * ey + ez * ez;
                    if (d2 < near2) continue;
                    if (s < MIN_PX * Math.sqrt(d2) * unitPx) continue; // a speck too small to see
                    if (offScreen(planes, rx, h, rz, s) || k >= room) continue;
                    place(te, k * 16, B, j * 9, s, s, s, rx, h, rz);
                    k++;
                }
            }
        }
        commit(this.dropMesh, k);
    }

    writePools(view) {
        const { W, H, fx, fz, minX, maxX, minZ, maxZ, camX, camY, camZ, planes, unitPx, mapness } = view;
        const p = this.pools;
        const te = this.poolMesh.instanceMatrix.array;
        const alpha = this.alpha.array;
        const room = this.poolMesh.instanceMatrix.count;
        let k = 0;
        for (let q = 0; q < p.count; q++) {
            const j = (p.start + q) % p.cap;
            const fade = fadeOf(this.shown - p.born[j], q + p.cap - p.count);
            const t = Math.min(1, Math.max(0, (this.clock - p.t0[j]) / SPREAD));
            const spread = 1 - (1 - t) * (1 - t);
            const a = POOL_ALPHA * (1 - fade);
            if (a <= 0.01 || p.size[j] * spread <= 0.01) continue;
            const gy = p.gy[j] + LIFT;
            const dx = wrapDelta(p.x[j] - fx, W);
            const dz = wrapDelta(p.y[j] - fz, H);
            const ax0 = Math.ceil((minX - dx) / W);
            const ax1 = Math.floor((maxX - dx) / W);
            const az0 = Math.ceil((minZ - dz) / H);
            const az1 = Math.floor((maxZ - dz) / H);
            for (let ax = ax0; ax <= ax1; ax++) {
                for (let az = az0; az <= az1; az++) {
                    const rx = dx + ax * W;
                    const rz = dz + az * H;
                    let full = p.size[j];
                    if (mapness > 0) {
                        const ex = rx - camX;
                        const ey = gy - camY;
                        const ez = rz - camZ;
                        const least = (Math.sqrt(ex * ex + ey * ey + ez * ez) * unitPx * POOL_MIN_PX * mapness) / 2;
                        if (least > full) full = least;
                    }
                    const sc = full * spread;
                    if (offScreen(planes, rx, gy, rz, sc) || k >= room) continue;
                    place(te, k * 16, p.basis, j * 9, sc, 1, sc, rx, gy, rz);
                    alpha[k] = a;
                    k++;
                }
            }
        }
        commit(this.poolMesh, k);
        if (k) {
            this.alpha.clearUpdateRanges();
            this.alpha.addUpdateRange(0, k);
            this.alpha.needsUpdate = true;
        }
    }
}

// (Meshes stay visible even when empty: hidden from the start, their shaders
// would first be compiled the moment blood first shows, stalling that frame.)
function commit(mesh, count) {
    mesh.visible = true;
    mesh.count = count;
    if (!count) return;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, count * 16);
    mesh.instanceMatrix.needsUpdate = true;
}
