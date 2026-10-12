// The followed creature: a ring at its feet, the edge of what it can sense
// (in the follow and first-person views), and a thin line to whatever it is
// reacting to — the predator it flees, the prey it chases, the stranger it
// fights — coloured like that individual, as in the 2D view.
//
// Ring and circle are flat bands laid on the ground and re-draped over the
// terrain every frame (a few dozen height lookups). The line is a narrow
// ribbon turned toward the camera, because WebGL lines are always 1 pixel.
import * as THREE from 'three';
import { COLORS } from '../render.js';
import { SPECIES } from './creatures.js';
import { wrapDelta, TAU } from './util.js';

const LIFT = 0.35; // above the ground, so the band is not swallowed by it

// A band around a centre, on the ground. Dashed bands draw every other segment.
// (Also the range of a tribe's Hunt here order: order-marker.js.)
export class Band {
    constructor(scene, segments, color, opacity, dashed) {
        this.segments = segments;
        this.opacity = opacity;
        this.position = new THREE.BufferAttribute(new Float32Array(segments * 2 * 3), 3);
        this.position.setUsage(THREE.DynamicDrawUsage);
        const index = [];
        for (let s = 0; s < segments; s += dashed ? 2 : 1) {
            const a = s * 2;
            const b = ((s + 1) % segments) * 2;
            index.push(a, b, a + 1, a + 1, b, b + 1);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', this.position);
        g.setIndex(index);
        this.material = new THREE.MeshBasicMaterial({
            color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
        });
        this.mesh = new THREE.Mesh(g, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 2;
        this.mesh.visible = false;
        scene.add(this.mesh);
    }

    // Centre at render (rx, rz) = world (wx, wy); radius and width in units.
    set(rx, rz, wx, wy, radius, width, ground, fade = 1) {
        const p = this.position.array;
        const r0 = radius - width / 2;
        const r1 = radius + width / 2;
        for (let s = 0; s < this.segments; s++) {
            const a = (s / this.segments) * TAU;
            const c = Math.cos(a);
            const n = Math.sin(a);
            const o = s * 6;
            p[o] = rx + c * r0;
            p[o + 1] = ground(wx + c * r0, wy + n * r0) + LIFT;
            p[o + 2] = rz + n * r0;
            p[o + 3] = rx + c * r1;
            p[o + 4] = ground(wx + c * r1, wy + n * r1) + LIFT;
            p[o + 5] = rz + n * r1;
        }
        this.position.needsUpdate = true;
        this.material.opacity = this.opacity * fade;
        this.mesh.visible = fade > 0.02;
    }
}

export class Marker {
    constructor(scene) {
        this.ring = new Band(scene, 48, '#ffffff', 0.8, false);
        this.sense = new Band(scene, 96, COLORS.herbivore, 0.35, true);
        this.linePos = new THREE.BufferAttribute(new Float32Array(12), 3);
        this.linePos.setUsage(THREE.DynamicDrawUsage);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', this.linePos);
        g.setIndex([0, 1, 2, 2, 1, 3]);
        this.lineMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
        this.line = new THREE.Mesh(g, this.lineMaterial);
        this.line.frustumCulled = false;
        this.line.renderOrder = 2;
        this.line.visible = false;
        scene.add(this.line);
        this.color = new THREE.Color();
    }

    hide() {
        this.ring.mesh.visible = false;
        this.sense.mesh.visible = false;
        this.line.visible = false;
    }

    update(world, view, ground, target, focus, senseRadius) {
        if (!target) {
            this.hide();
            return;
        }
        const { W, H, fx, fz, camX, camY, camZ } = view;
        const px = (d) => d * view.unitPx; // one screen pixel, d units away, in world units
        const wx = target.pop.x[target.i];
        const wy = target.pop.y[target.i];
        const rx = wrapDelta(wx - fx, W);
        const rz = wrapDelta(wy - fz, H);
        const gy = ground(wx, wy);
        const dist = Math.hypot(rx - camX, gy - camY, rz - camZ);
        const spec = SPECIES[target.kind];

        // The ring grows with the body in the map view (see creatures.js), and
        // fades as the camera closes in on the eyes: in first person it would
        // be a band across the bottom of the screen.
        const grow = Math.max(1, (dist * view.unitPx * spec.minPx * view.mapness) / spec.size);
        const ringFade = Math.min(1, Math.max(0, (view.dist - 3) / 15));
        this.ring.set(rx, rz, wx, wy, spec.ring * grow, Math.max(0.45, 1.6 * px(dist)), ground, ringFade);
        this.sense.set(rx, rz, wx, wy, senseRadius, Math.max(0.3, 1.3 * px(dist)), ground, 1 - view.mapness);

        if (!focus) {
            this.line.visible = false;
            return;
        }
        // From the middle of one body to the middle of the other.
        const fwx = focus.pop.x[focus.i];
        const fwy = focus.pop.y[focus.i];
        const ax = rx;
        const ay = gy + spec.center * grow;
        const az = rz;
        const bx = rx + wrapDelta(fwx - wx, W);
        const bz = rz + wrapDelta(fwy - wy, H);
        const by = ground(fwx, fwy) + SPECIES[focus.kind].center * grow;
        // Widen it sideways to the line and to the view direction, each end
        // by its own distance, so it is about 2 pixels wide all along (in
        // first person it starts right under the eyes).
        const mx = (ax + bx) / 2 - camX;
        const my = (ay + by) / 2 - camY;
        const mz = (az + bz) / 2 - camZ;
        const lx = bx - ax;
        const ly = by - ay;
        const lz = bz - az;
        let sx = ly * mz - lz * my;
        let sy = lz * mx - lx * mz;
        let sz = lx * my - ly * mx;
        const sl = Math.hypot(sx, sy, sz) || 1;
        sx /= sl;
        sy /= sl;
        sz /= sl;
        const ha = 0.9 * px(Math.hypot(ax - camX, ay - camY, az - camZ));
        const hb = 0.9 * px(Math.hypot(bx - camX, by - camY, bz - camZ));
        const p = this.linePos.array;
        p[0] = ax - sx * ha; p[1] = ay - sy * ha; p[2] = az - sz * ha;
        p[3] = ax + sx * ha; p[4] = ay + sy * ha; p[5] = az + sz * ha;
        p[6] = bx - sx * hb; p[7] = by - sy * hb; p[8] = bz - sz * hb;
        p[9] = bx + sx * hb; p[10] = by + sy * hb; p[11] = bz + sz * hb;
        this.linePos.needsUpdate = true;
        const color = focus.kind === 'carnivore' ? COLORS.carnivore
            : focus.kind === 'herbivore' ? COLORS.herbivore
            : world.tribeById.get(focus.pop.tribe[focus.i])?.color ?? COLORS.herbivore;
        this.lineMaterial.color.set(color);
        this.line.visible = true;
    }
}
