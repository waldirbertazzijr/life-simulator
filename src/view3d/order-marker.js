// A tribe's standing order (orders.js) on the ground: a slim pole flying a
// pennant in the tribe's colours where the order points. Hunt here's stands
// at its marker, with a dashed ring in the tribe's colour as far out as its
// hunters range; Gather food's and Defend camp's are about the camp, so
// theirs stands in it, a few steps from the flag. (Only the tribe you lead
// ever has an order.)
//
// Like the camps' flags, the pole turns to face the camera, so the pennant
// is never seen edge-on, and in the map view it grows with distance so it
// still reads from high above.
import * as THREE from 'three';
import { Band } from './marker.js';
import { rackAngle } from './camps.js';
import { wrapDelta } from './util.js';

const POLE = 5;          // a little shorter than a camp's pole (6.2)
const PENNANT = 2.8;     // the pennant's length...
const PENNANT_H = 1.6;   // ...and height
const MIN_PX = 32;       // in the map view, the pole is at least this tall on screen
const BESIDE = 7;        // an order about the camp stands this far from its pole (away from the rack)
const POLE_COLOR = '#d9dcd6';

// A pole and a pennant split along its length: the tribe's first colour
// above, its second below. Vertex colours, one geometry per tribe.
function poleShape(colors) {
    const pos = [];
    const col = [];
    const c = new THREE.Color();
    const tri = (a, b, d, hex) => {
        pos.push(...a, ...b, ...d);
        c.set(hex);
        for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
    };
    const r = 0.13;
    const sides = [[-r, -r, r, -r], [r, -r, r, r], [r, r, -r, r], [-r, r, -r, -r]];
    for (const [x0, z0, x1, z1] of sides) {
        tri([x0, 0, z0], [x1, 0, z1], [x1, POLE, z1], POLE_COLOR);
        tri([x0, 0, z0], [x1, POLE, z1], [x0, POLE, z0], POLE_COLOR);
    }
    const top = [r, POLE, 0];
    const mid = [r, POLE - PENNANT_H / 2, 0];
    const low = [r, POLE - PENNANT_H, 0];
    const tip = [r + PENNANT, POLE - PENNANT_H / 2, 0];
    tri(top, mid, tip, colors[0]);
    tri(mid, low, tip, colors[1] ?? colors[0]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeBoundingSphere();
    return g;
}

export class OrderMarkers {
    constructor(scene) {
        this.scene = scene;
        this.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
        this.tribes = new Map(); // tribe id → { mesh, ring, seen }
        this.frame = 0;
    }

    attach() {
        for (const id of [...this.tribes.keys()]) this.forget(id);
    }

    forget(id) {
        const t = this.tribes.get(id);
        this.scene.remove(t.mesh, t.ring.mesh);
        t.mesh.geometry.dispose();
        t.ring.mesh.geometry.dispose();
        t.ring.material.dispose();
        this.tribes.delete(id);
    }

    entry(tribe) {
        let t = this.tribes.get(tribe.id);
        if (!t) {
            const mesh = new THREE.Mesh(poleShape(tribe.flag.colors), this.material);
            mesh.frustumCulled = false;
            const ring = new Band(this.scene, 96, tribe.color, 0.55, true);
            this.scene.add(mesh);
            t = { mesh, ring, seen: 0 };
            this.tribes.set(tribe.id, t);
        }
        return t;
    }

    update(world, view, ground) {
        const frame = ++this.frame;
        const { W, H, fx, fz, camX, camY, camZ } = view;
        for (const tribe of world.tribes) {
            const order = tribe.order;
            if (!order) continue;
            const t = this.entry(tribe);
            t.seen = frame;
            let wx = order.x;
            let wy = order.y;
            if (Math.abs(wrapDelta(wx - tribe.camp.x, W)) < 1 && Math.abs(wrapDelta(wy - tribe.camp.y, H)) < 1) {
                // About the camp: beside its flag, on the side away from the rack.
                const a = rackAngle(tribe.id) + Math.PI;
                wx = (((wx + Math.cos(a) * BESIDE) % W) + W) % W;
                wy = (((wy + Math.sin(a) * BESIDE) % H) + H) % H;
            }
            // The copy nearest the camera's focus.
            const rx = wrapDelta(wx - fx, W);
            const rz = wrapDelta(wy - fz, H);
            const gy = ground(wx, wy);
            const { mesh } = t;
            mesh.position.set(rx, gy, rz);
            mesh.rotation.y = Math.atan2(camX - rx, camZ - rz);
            const dist = Math.hypot(rx - camX, gy + POLE * 0.7 - camY, rz - camZ);
            const s = (dist * view.unitPx * MIN_PX * view.mapness) / POLE;
            mesh.scale.setScalar(s > 1 ? s : 1);
            mesh.visible = true;
            if (order.kind === 'hunt') {
                const width = Math.max(0.45, 1.4 * dist * view.unitPx);
                t.ring.set(rx, rz, wx, wy, world.p.orders.huntRange, width, ground);
            } else t.ring.mesh.visible = false;
        }
        for (const [id, t] of this.tribes) {
            if (t.seen === frame) continue;
            t.mesh.visible = false;
            t.ring.mesh.visible = false;
            if (frame % 120 === 0) this.forget(id); // (now and then, let go of orders that are over)
        }
    }
}
