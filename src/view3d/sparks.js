// The marks of work and of weapon skills (package 3), small and brief:
// - wood chips flying from a stroke at a tree (`chop` events), flint sparks
//   from a stone struck (`knap`);
// - a spear's piercing throw: a bright streak along its flight;
// - a club's ground slam: a ring of dust spreading over the ground (and a
//   little dust thrown up);
// (- a bow's volley is three arrows: thrown.js.)
//
// Drawing only. Particles live in a ring of fixed size (the oldest go
// first); streaks and rings in a few meshes reused in turn.
import * as THREE from 'three';
import { offScreen } from './creatures.js';
import { wrapDelta } from './util.js';
import { kindName } from '../play/gear.js';
import { showWhile } from './items.js';

const CAP = 600;          // particles at most
const G = 22;             // gravity, units/s² (seconds at 1×)
const KIND = {
    chip: { n: 7, color: [0.5, 0.36, 0.2], size: 0.13, up: [2, 4], out: [1.2, 3], life: 0.9, fall: true },
    spark: { n: 9, color: [1.6, 1.25, 0.55], size: 0.06, up: [1, 3], out: [1.5, 4], life: 0.35, fall: false },
    dust: { n: 16, color: [0.62, 0.56, 0.45], size: 0.22, up: [0.5, 1.5], out: [3, 6], life: 0.8, fall: true },
};
const STREAK = { length: 34, life: 0.5, height: 3.2 };
const RING = { radius: 8, life: 0.8 };
const POOL = 3; // streaks and rings at once

const rand = (a, b) => a + Math.random() * (b - a);

export class Sparks {
    constructor(scene) {
        this.p = { start: 0, count: 0 };
        for (const f of ['x', 'y', 'h', 'vx', 'vy', 'vh', 't0', 'life', 'size', 'gy', 'fall']) this.p[f] = new Float64Array(CAP);
        this.p.rgb = new Float32Array(CAP * 3);
        this.mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial(), CAP);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
        this.mesh.frustumCulled = false;
        this.mesh.count = 0;
        scene.add(this.mesh);
        // Streaks: a long, thin, bright box; rings: a flat band on the ground.
        const streak = new THREE.BoxGeometry(1, 0.07, 0.07);
        streak.translate(0.5, 0, 0);
        const ring = new THREE.RingGeometry(0.8, 1, 28);
        ring.rotateX(-Math.PI / 2);
        this.streaks = [];
        this.rings = [];
        for (let k = 0; k < POOL; k++) {
            const s = new THREE.Mesh(streak, new THREE.MeshBasicMaterial({ color: '#fff3d0', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
            const r = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: '#b8a888', transparent: true, depthWrite: false, side: THREE.DoubleSide }));
            r.renderOrder = 1;
            s.visible = false;
            r.visible = false;
            s.frustumCulled = false;
            r.frustumCulled = false;
            scene.add(s, r);
            this.streaks.push({ mesh: s, t0: -1, x: 0, y: 0, gy: 0, dx: 1, dy: 0 });
            this.rings.push({ mesh: r, t0: -1, x: 0, y: 0, gy: 0 });
        }
        this.next = { streak: 0, ring: 0 };
        this.clock = 0;
    }

    attach() {
        this.p.start = 0;
        this.p.count = 0;
        for (const s of [...this.streaks, ...this.rings]) {
            s.t0 = -1;
            s.mesh.visible = false;
        }
    }

    // What happened (this frame's events): strokes at work, and skills.
    handle(events, ground, clock) {
        this.clock = clock;
        for (let k = 0; k < events.length; k++) {
            const e = events[k];
            if (e.type === 'chop') this.burst('chip', e.x, e.y, ground(e.x, e.y), 2.6);
            else if (e.type === 'knap') this.burst('spark', e.x, e.y, ground(e.x, e.y), 1.3);
            else if (e.type === 'skill') {
                const kind = kindName(e.kind);
                const gy = ground(e.x, e.y);
                const len = Math.hypot(e.dx ?? 0, e.dy ?? 0) || 1;
                if (kind === 'spear') this.streak(e.x, e.y, gy, (e.dx ?? 1) / len, (e.dy ?? 0) / len);
                else if (kind === 'club') {
                    this.ring(e.x, e.y, gy);
                    this.burst('dust', e.x, e.y, gy, 0.3);
                }
            }
        }
    }

    // A few particles of `what` from (x, y), `height` above the ground gy.
    burst(what, x, y, gy, height) {
        const K = KIND[what];
        const p = this.p;
        for (let n = 0; n < K.n; n++) {
            const j = (p.start + p.count) % CAP;
            if (p.count < CAP) p.count++;
            else p.start = (p.start + 1) % CAP;
            const a = Math.random() * Math.PI * 2;
            const out = rand(...K.out);
            p.x[j] = x;
            p.y[j] = y;
            p.h[j] = gy + height;
            p.vx[j] = Math.cos(a) * out;
            p.vy[j] = Math.sin(a) * out;
            p.vh[j] = rand(...K.up);
            p.t0[j] = this.clock;
            p.life[j] = K.life * rand(0.7, 1.2);
            p.size[j] = K.size * rand(0.7, 1.3);
            p.gy[j] = gy;
            p.fall[j] = K.fall ? 1 : 0;
            p.rgb.set(K.color, j * 3);
        }
    }

    streak(x, y, gy, dx, dy) {
        const s = this.streaks[this.next.streak++ % POOL];
        Object.assign(s, { t0: this.clock, x, y, gy, dx, dy });
    }

    ring(x, y, gy) {
        const r = this.rings[this.next.ring++ % POOL];
        Object.assign(r, { t0: this.clock, x, y, gy });
    }

    update(view, clock) {
        this.clock = clock;
        const { W, H, fx, fz, planes } = view;
        const p = this.p;
        while (p.count && clock - p.t0[p.start] > p.life[p.start]) {
            p.start = (p.start + 1) % CAP;
            p.count--;
        }
        const te = this.mesh.instanceMatrix.array;
        const tc = this.mesh.instanceColor.array;
        let k = 0;
        for (let q = 0; q < p.count; q++) {
            const j = (p.start + q) % CAP;
            const t = clock - p.t0[j];
            if (t < 0) continue;
            const x = wrapDelta(p.x[j] + p.vx[j] * t - fx, W);
            const z = wrapDelta(p.y[j] + p.vy[j] * t - fz, H);
            const h = Math.max(p.gy[j] + p.size[j], p.h[j] + p.vh[j] * t - (p.fall[j] ? 0.5 * G * t * t : 0));
            const s = p.size[j] * (1 - 0.6 * (t / p.life[j]));
            if (offScreen(planes, x, h, z, s)) continue;
            const o = k * 16;
            te.fill(0, o, o + 16);
            te[o] = s;
            te[o + 5] = s;
            te[o + 10] = s;
            te[o + 12] = x;
            te[o + 13] = h;
            te[o + 14] = z;
            te[o + 15] = 1;
            tc[k * 3] = p.rgb[j * 3];
            tc[k * 3 + 1] = p.rgb[j * 3 + 1];
            tc[k * 3 + 2] = p.rgb[j * 3 + 2];
            k++;
        }
        this.mesh.count = k;
        showWhile(this.mesh, k);
        if (k) {
            for (const [a, size] of [[this.mesh.instanceMatrix, 16], [this.mesh.instanceColor, 3]]) {
                a.clearUpdateRanges();
                a.addUpdateRange(0, k * size);
                a.needsUpdate = true;
            }
        }
        // The streak runs out along the throw and fades; the ring spreads and fades.
        for (const s of this.streaks) {
            const t = s.t0 < 0 ? Infinity : (clock - s.t0) / STREAK.life;
            s.mesh.visible = t >= 0 && t < 1;
            if (!s.mesh.visible) continue;
            const reach = STREAK.length * Math.min(1, t * 3);
            s.mesh.position.set(wrapDelta(s.x - fx, W), s.gy + STREAK.height, wrapDelta(s.y - fz, H));
            s.mesh.rotation.set(0, -Math.atan2(s.dy, s.dx), 0);
            s.mesh.scale.set(reach, 1 + 0.6 * (1 - t), 1 + 0.6 * (1 - t));
            s.mesh.material.opacity = 0.6 * (1 - t);
        }
        for (const r of this.rings) {
            const t = r.t0 < 0 ? Infinity : (clock - r.t0) / RING.life;
            r.mesh.visible = t >= 0 && t < 1;
            if (!r.mesh.visible) continue;
            const rad = RING.radius * (1 - (1 - t) * (1 - t));
            r.mesh.position.set(wrapDelta(r.x - fx, W), r.gy + 0.25, wrapDelta(r.y - fz, H));
            r.mesh.scale.set(rad, 1, rad);
            r.mesh.material.opacity = 0.7 * (1 - t);
        }
    }
}
