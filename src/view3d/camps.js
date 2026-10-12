// Camps: a dark patch of trodden ground, and a pole flying the tribe's flag.
//
// The flag is the same drawing as in the panel (flag.js), painted once into a
// small canvas that becomes a texture. Pole and flag are a single mesh that
// turns to face the camera, so the flag is never seen edge-on, and in the map
// view it grows with distance so it still reads from high above.
import * as THREE from 'three';
import { drawFlag } from '../flag.js';
import { wrapDelta, TAU } from './util.js';

const POLE = 10;          // pole height (people are ~5 tall)
const FLAG_W = 6;
const FLAG_H = 4;
const FLAG_MIN_PX = 22;   // in the map view the flag stays at least this wide on screen
const POLE_COLOR = '#d9dcd6';
// Texture layout: a strip of pole colour on the left, a gap, then the flag.
const TEX_W = 72;
const TEX_H = 40;
const TEX_POLE = 6;
const TEX_FLAG = 12;

// Pole (a thin square column) and flag (a quad off its top), sharing one
// texture: the pole samples the strip, the flag the drawing.
function poleAndFlag() {
    const pos = [];
    const uv = [];
    const quad = (a, b, c, d, ua, ub, uc, ud) => {
        pos.push(...a, ...b, ...c, ...a, ...c, ...d);
        uv.push(...ua, ...ub, ...uc, ...ua, ...uc, ...ud);
    };
    const r = 0.18;
    const pu = [(TEX_POLE / 2) / TEX_W, 0.5];
    const sides = [[-r, -r, r, -r], [r, -r, r, r], [r, r, -r, r], [-r, r, -r, -r]];
    for (const [x0, z0, x1, z1] of sides) {
        quad([x0, 0, z0], [x1, 0, z1], [x1, POLE, z1], [x0, POLE, z0], pu, pu, pu, pu);
    }
    const u0 = TEX_FLAG / TEX_W;
    const fy = POLE - FLAG_H;
    quad([r, fy, 0], [r + FLAG_W, fy, 0], [r + FLAG_W, POLE, 0], [r, POLE, 0], [u0, 0], [1, 0], [1, 1], [u0, 1]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeBoundingSphere();
    return g;
}

// A disc lying on the ground around (cx, cy), following its rises and dips.
// Heights are relative to the centre, which is where the mesh is placed.
function groundDisc(radius, ground, cx, cy) {
    const SEG = 32;
    const RINGS = 3;
    const lift = 0.3;
    const h0 = ground(cx, cy);
    const pos = [0, lift, 0];
    for (let r = 1; r <= RINGS; r++) {
        const rad = (radius * r) / RINGS;
        for (let s = 0; s < SEG; s++) {
            const a = (s / SEG) * TAU;
            const x = Math.cos(a) * rad;
            const z = Math.sin(a) * rad;
            pos.push(x, ground(cx + x, cy + z) - h0 + lift, z);
        }
    }
    const index = [];
    const at = (r, s) => 1 + (r - 1) * SEG + (s % SEG);
    for (let s = 0; s < SEG; s++) index.push(0, at(1, s + 1), at(1, s));
    for (let r = 1; r < RINGS; r++) {
        for (let s = 0; s < SEG; s++) {
            index.push(at(r, s), at(r, s + 1), at(r + 1, s));
            index.push(at(r, s + 1), at(r + 1, s + 1), at(r + 1, s));
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(index);
    g.computeBoundingSphere();
    return g;
}

export class Camps {
    constructor(scene, gl) {
        this.scene = scene;
        this.anisotropy = Math.min(4, gl.capabilities.getMaxAnisotropy());
        this.geometry = poleAndFlag();
        this.discMaterial = new THREE.MeshBasicMaterial({
            color: '#101211', transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
            polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
        });
        this.tribes = new Map(); // tribe id → { material, disc, h0, seen }
        this.pool = [];          // drawn camps: { flag, disc } meshes, reused frame to frame
        this.frame = 0;
    }

    attach() {
        for (const id of [...this.tribes.keys()]) this.forget(id);
    }

    forget(id) {
        const t = this.tribes.get(id);
        t.material.map.dispose();
        t.material.dispose();
        t.disc.dispose();
        this.tribes.delete(id);
    }

    // What a tribe needs to be drawn: its flag texture and its ground patch.
    entry(tribe, ground, campRadius) {
        let t = this.tribes.get(tribe.id);
        if (!t) {
            const canvas = document.createElement('canvas');
            canvas.width = TEX_W;
            canvas.height = TEX_H;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = POLE_COLOR;
            ctx.fillRect(0, 0, TEX_POLE, TEX_H);
            drawFlag(ctx, tribe.flag, TEX_FLAG, 0, TEX_W - TEX_FLAG, TEX_H);
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.lineWidth = 2;
            ctx.strokeRect(TEX_FLAG + 1, 1, TEX_W - TEX_FLAG - 2, TEX_H - 2);
            const map = new THREE.CanvasTexture(canvas);
            map.colorSpace = THREE.SRGBColorSpace;
            map.anisotropy = this.anisotropy;
            // Unlit, so the flag shows its true colours from any side.
            const material = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide });
            t = {
                material,
                disc: groundDisc(campRadius, ground, tribe.camp.x, tribe.camp.y),
                h0: ground(tribe.camp.x, tribe.camp.y),
                seen: 0,
            };
            this.tribes.set(tribe.id, t);
        }
        return t;
    }

    item(n) {
        if (!this.pool[n]) {
            const flag = new THREE.Mesh(this.geometry, null);
            const disc = new THREE.Mesh(undefined, this.discMaterial);
            disc.renderOrder = 1; // after the ground, so it darkens it
            this.scene.add(flag, disc);
            this.pool[n] = { flag, disc };
        }
        return this.pool[n];
    }

    update(world, view, ground) {
        const frame = ++this.frame;
        const { W, H, fx, fz, camX, camY, camZ } = view;
        const campRadius = world.p.human.campRadius;
        const pad = campRadius + 40;
        let n = 0;
        for (const tribe of world.tribes) {
            const t = this.entry(tribe, ground, campRadius);
            t.seen = frame;
            const dx = wrapDelta(tribe.camp.x - fx, W);
            const dz = wrapDelta(tribe.camp.y - fz, H);
            const ax0 = Math.ceil((view.minX - pad - dx) / W);
            const ax1 = Math.floor((view.maxX + pad - dx) / W);
            const az0 = Math.ceil((view.minZ - pad - dz) / H);
            const az1 = Math.floor((view.maxZ + pad - dz) / H);
            for (let ax = ax0; ax <= ax1; ax++) {
                for (let az = az0; az <= az1; az++) {
                    const rx = dx + ax * W;
                    const rz = dz + az * H;
                    const { flag, disc } = this.item(n++);
                    flag.material = t.material;
                    disc.geometry = t.disc;
                    flag.position.set(rx, t.h0, rz);
                    disc.position.set(rx, t.h0, rz);
                    // Face the camera: turn the flag's front (+Z) toward it.
                    flag.rotation.y = Math.atan2(camX - rx, camZ - rz);
                    const ex = rx - camX;
                    const ey = t.h0 + POLE * 0.7 - camY;
                    const ez = rz - camZ;
                    const s = (Math.sqrt(ex * ex + ey * ey + ez * ez) * view.unitPx * FLAG_MIN_PX * view.mapness) / FLAG_W;
                    flag.scale.setScalar(s > 1 ? s : 1);
                    flag.visible = true;
                    disc.visible = true;
                }
            }
        }
        for (let i = n; i < this.pool.length; i++) {
            this.pool[i].flag.visible = false;
            this.pool[i].disc.visible = false;
        }
        // Now and then, let go of tribes that have died out.
        if (frame % 120 === 0) {
            for (const [id, t] of this.tribes) if (t.seen !== frame) this.forget(id);
        }
    }
}
