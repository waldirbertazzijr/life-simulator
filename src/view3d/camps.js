// Camps: a dark patch of trodden ground, a pole flying the tribe's flag, and
// a rack where the tribe's food hangs to dry.
//
// The flag is the same drawing as in the panel (flag.js), painted once into a
// small canvas that becomes a texture. Pole and flag are a single mesh that
// turns to face the camera, so the flag is never seen edge-on, and in the map
// view it grows with distance so it still reads from high above.
//
// The rack shows the tribe's store: a strip of meat for every MEAT_EACH of
// food, up to MEAT_CAP, so a well-fed camp's rack is full, a hungry one's
// bare, and a raid can be seen emptying it. All racks are one instanced mesh,
// and all the meat another.
import * as THREE from 'three';
import { drawFlag } from '../flag.js';
import { rackShape, meatShape, RACK_RIDGE, RACK_HALF } from './shapes.js';
import { wrapDelta, TAU, hash } from './util.js';

// Near the ground the pole stands a little taller than a person (people are
// about 4.8 tall); in the map view the flag grows with distance, so it stays
// at least FLAG_MIN_PX wide on screen however small it is up close.
const POLE = 6.2;         // pole height
const FLAG_W = 3.3;
const FLAG_H = 2.2;
const FLAG_MIN_PX = 22;
const POLE_COLOR = '#d9dcd6';
// Texture layout: a strip of pole colour on the left, a gap, then the flag.
const TEX_W = 72;
const TEX_H = 40;
const TEX_POLE = 6;
const TEX_FLAG = 12;
const RACK_AT = 8;          // the rack stands this far from the pole...
export const MEAT_CAP = 10; // ...with at most this many strips of meat on it
const MEAT_EACH = 75;       // food per strip (about what one grazer brings in)
const RACK_MIN_PX = 4;      // a rack shorter than this on screen is not drawn...
const MEAT_MIN_PX = 1;      // ...nor its meat when a strip (half a unit wide) is narrower than this
const WOOD = '#6f604c';
const MEAT = '#874233';
// The place along the ridge the k-th strip takes: from the middle outward.
const SLOTS = [4, 5, 3, 6, 2, 7, 1, 8, 0, 9];

// Strips of meat on a rack for this much food in store: one as soon as there
// is any, one more for each MEAT_EACH, up to MEAT_CAP.
export function meatOnRack(store) {
    if (!(store > 0)) return 0;
    return Math.min(MEAT_CAP, Math.max(1, Math.round(store / MEAT_EACH)));
}

// Write a turn by `h` about the vertical, a scale and a move into a matrix
// (model +X along (cos h, sin h) in world (x, y), as for the creatures).
function place(te, o, h, sx, sy, x, y, z) {
    const c = Math.cos(h);
    const s = Math.sin(h);
    te.fill(0, o, o + 16);
    te[o] = sx * c;
    te[o + 2] = sx * s;
    te[o + 5] = sy;
    te[o + 8] = -sx * s;
    te[o + 10] = sx * c;
    te[o + 12] = x;
    te[o + 13] = y;
    te[o + 14] = z;
    te[o + 15] = 1;
}

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
        this.tribes = new Map(); // tribe id → { material, disc, h0, rack, seen }
        this.pool = [];          // drawn camps: { flag, disc } meshes, reused frame to frame
        this.frame = 0;
        const lit = (color) => new THREE.MeshLambertMaterial({ color, vertexColors: true, flatShading: true });
        this.racks = this.instanced(rackShape(), lit(WOOD), 32);
        this.meat = this.instanced(meatShape(), lit(MEAT), 32 * MEAT_CAP);
    }

    // An instanced mesh with room for `cap`, or (given `old`) a bigger one in its place.
    instanced(geometry, material, cap, old = null) {
        const mesh = new THREE.InstancedMesh(geometry, material, cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false; // camps are all over the world; only those in view are written
        mesh.count = 0;
        if (old) {
            this.scene.remove(old);
            old.dispose();
        }
        this.scene.add(mesh);
        return mesh;
    }

    room(name, need) {
        const mesh = this[name];
        if (need > mesh.instanceMatrix.count) {
            this[name] = this.instanced(mesh.geometry, mesh.material, Math.max(need, mesh.instanceMatrix.count * 2), mesh);
        }
        return this[name].instanceMatrix.array;
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
                rack: (hash(tribe.id) / 2 ** 32) * TAU, // which way from the pole the rack stands
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
        let racks = 0;
        let strips = 0;
        for (const tribe of world.tribes) {
            const t = this.entry(tribe, ground, campRadius);
            t.seen = frame;
            // The rack: beside the pole, its ridge across the line to it.
            const ox = Math.cos(t.rack) * RACK_AT;
            const oz = Math.sin(t.rack) * RACK_AT;
            const ry = ground(tribe.camp.x + ox, tribe.camp.y + oz);
            const along = t.rack + Math.PI / 2;
            const ux = Math.cos(along);
            const uz = Math.sin(along);
            const meat = meatOnRack(tribe.store);
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

                    // From high above a rack is a speck, and its meat less.
                    const perUnit = Math.sqrt(ex * ex + ey * ey + ez * ez) * view.unitPx; // world units per pixel there
                    if (perUnit * RACK_MIN_PX > 2 * RACK_HALF) continue;
                    const x = rx + ox;
                    const z = rz + oz;
                    place(this.room('racks', racks + 1), racks++ * 16, along, 1, 1, x, ry, z);
                    if (0.5 / perUnit < MEAT_MIN_PX) continue;
                    const te = this.room('meat', strips + meat);
                    for (let k = 0; k < meat; k++) {
                        // Strips hang a little turned and of different lengths, the same each time.
                        const slot = SLOTS[k];
                        const h = hash(tribe.id * 16 + slot);
                        const at = -RACK_HALF + (slot * 2 * RACK_HALF) / (MEAT_CAP - 1);
                        const twist = ((h & 255) / 255 - 0.5) * 0.7;
                        const long = 0.85 + 0.3 * (((h >>> 8) & 255) / 255);
                        place(te, strips++ * 16, along + twist, 1, long, x + ux * at, ry + RACK_RIDGE - 0.06, z + uz * at);
                    }
                }
            }
        }
        for (let i = n; i < this.pool.length; i++) {
            this.pool[i].flag.visible = false;
            this.pool[i].disc.visible = false;
        }
        for (const [mesh, count] of [[this.racks, racks], [this.meat, strips]]) {
            mesh.count = count;
            if (!count) continue;
            mesh.instanceMatrix.clearUpdateRanges();
            mesh.instanceMatrix.addUpdateRange(0, count * 16);
            mesh.instanceMatrix.needsUpdate = true;
        }
        // Now and then, let go of tribes that have died out.
        if (frame % 120 === 0) {
            for (const [id, t] of this.tribes) if (t.seen !== frame) this.forget(id);
        }
    }
}
