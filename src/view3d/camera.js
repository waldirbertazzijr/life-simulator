// The 3D camera: three ways of looking at the world, and the controls.
//
//   map    — a god view over the land. Drag pans, the wheel zooms, right-drag
//            (or ctrl/shift-drag) turns and tilts; on a phone one finger pans,
//            a pinch zooms and a two-finger twist turns. While someone is
//            followed the map keeps them centred, until you pan away. Zoomed
//            in close, it tilts toward the horizon, so the sky comes into view.
//   follow — behind and above the followed creature, turning as it turns.
//            Dragging swings the camera around it; the wheel moves closer.
//   first  — from its eyes, looking where it is heading. Dragging looks
//            around; the view drifts back to straight ahead when you let go.
//
// The keyboard (WASD or the arrow keys, the same) does the same as dragging,
// for as long as a key is held:
//   map    — W/S pan forward and back (the way the camera faces), A/D pan
//            left and right, Q/E turn; faster when zoomed out.
//   follow — A/D swing the camera around the creature, so the view turns
//            left or right; W/S move it closer or further.
//   first  — A/D look left and right, W/S look up and down; the view drifts
//            back to straight ahead once the keys are let go.
//
// All three are the same kind of camera: it looks at a focus point from a
// direction (yaw, pitch) and a distance. Switching views glides those numbers
// toward the new view's values, so every transition is smooth. In first
// person the distance shrinks to 1 and the focus sits just ahead of the eyes.
//
// While a creature is followed, the focus is kept as an offset from it and
// only that offset glides: the camera never trails behind a running animal,
// even at 64×.
import * as THREE from 'three';
import { wrap, wrapDelta, angleDelta, groundOf, meshHeight, smoothstep } from './util.js';

const DEG = Math.PI / 180;

// Per kind: eye height and how far ahead of the body's centre the eyes are
// (first person), the height the follow camera looks at, and how far back it
// sits. Bodies are drawn in shapes.js.
const BODY = {
    herbivore: { eye: 2.7, ahead: 2.4, center: 2, back: 70 },
    carnivore: { eye: 2.6, ahead: 3.6, center: 1.6, back: 90 },
    human: { eye: 4.1, ahead: 0.5, center: 2.6, back: 75 },
};

const MAP_PITCH = 52 * DEG;   // the map's starting tilt (90° looks straight down)
const MAP_TILT = [18 * DEG, 86 * DEG]; // how far right-drag tilts the map, zoomed out
const FOLLOW_PITCH = 28 * DEG;
const FIRST_PITCH = 5 * DEG;  // first person looks a little down
const GLIDE = 0.3;            // seconds: view changes and zoom settle in about this long
const PAN_GLIDE = 0.06;       // seconds: dragging the map follows the pointer closely
const TURN = { follow: 1.0, first: 0.35 }; // seconds: how calmly the view turns with the creature
// How far you can see (the fog's far end): in the map, proportional to the
// distance (a little beyond the screen's far corners, which are about 2.4×
// away at the starting tilt), but never less than the follow view's, so the
// map zoomed in still sees the hills on the horizon; fixed near the ground.
const FOG = { map: 3.0, follow: 1100, first: 700 };
const MAX_MAP_ZOOM = 1.3;     // × the distance that frames the whole world
const CLOSEST = 25;           // the map's closest zoom (its distance to the ground it looks at)
// Zoomed in close, the map tilts toward the horizon, as in Google Earth. As
// its distance falls from TILT_FROM to CLOSEST (eased, in log scale, as the
// wheel zooms), the slope of its line of sight (the tangent of the tilt)
// shrinks to FLATTEN times that of the user's tilt, the one right-drag sets
// and the map keeps zoomed out. That takes the starting 52° down to 15° at
// the closest zoom, and keeps every tilt reachable: right-drag's 18°–86°
// becomes 4°–72° there.
const TILT_FROM = 400;
const FLATTEN = Math.tan(15 * DEG) / Math.tan(MAP_PITCH);

// Held keys, per second: the map pans this many times the camera's distance
// (about a screen's height a second, at any zoom) and turns this fast; the
// follow camera swings round and zooms; first person looks around.
const KEY_RATE = { pan: 0.8, turn: 1.6, orbit: 1.8, zoom: 1.2, lookYaw: 1.6, lookPitch: 1.0 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

// The tilt the map shows at distance `dist`, given the user's tilt, and back
// (see TILT_FROM).
const flattening = (dist) => FLATTEN ** smoothstep(Math.log(TILT_FROM), Math.log(CLOSEST), Math.log(dist));
const tiltAt = (pitch, dist) => Math.atan(Math.tan(pitch) * flattening(dist));
const userTilt = (seen, dist) => Math.atan(Math.tan(seen) / flattening(dist));

// How far the map sees at distance `dist`.
const mapFog = (dist) => Math.max(dist * FOG.map, FOG.follow);

// Which held keys mean what. By physical key (event.code), so WASD sits under
// the same fingers on any keyboard layout. None of them is one of the panel's
// shortcuts (ui.js: space, 1–4, R, H, V, F, Esc).
const KEY_MAP = {
    KeyW: 'forward', ArrowUp: 'forward',
    KeyS: 'back', ArrowDown: 'back',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
    KeyQ: 'turnLeft',
    KeyE: 'turnRight',
};

// The keys held down, as three axes from −1 to 1: `x` (right − left), `y`
// (forward − back) and `turn` (E − Q). It knows nothing of cameras, so the
// same axes can steer something else later (in stage 3, the player's own
// person). Keys typed into a text field, or pressed with Ctrl/Cmd/Alt (the
// browser's own shortcuts), are left alone.
export class HeldKeys {
    constructor(target = window) {
        this.held = new Set();
        const typing = (e) => {
            const el = e.target;
            return el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
        };
        target.addEventListener('keydown', (e) => {
            const action = KEY_MAP[e.code];
            if (!action || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
            this.held.add(action);
            e.preventDefault(); // arrows would scroll the panel
        });
        target.addEventListener('keyup', (e) => {
            const action = KEY_MAP[e.code];
            if (action) this.held.delete(action);
        });
        // A key released while the window is not looking would stay held.
        window.addEventListener('blur', () => this.held.clear());
    }

    get any() {
        return this.held.size > 0;
    }

    axis(plus, minus) {
        return (this.held.has(plus) ? 1 : 0) - (this.held.has(minus) ? 1 : 0);
    }

    get x() {
        return this.axis('right', 'left');
    }

    get y() {
        return this.axis('forward', 'back');
    }

    get turn() {
        return this.axis('turnRight', 'turnLeft');
    }
}

export class CameraRig {
    constructor(canvas) {
        this.canvas = canvas;
        this.camera = new THREE.PerspectiveCamera(55, 1, 1, 5000);
        this.mode = 'map';
        this.w = 1;
        this.h = 1;
        this.W = 1;
        this.H = 1;
        this.ground = () => 0;
        this.surface = () => 0;
        this.lowest = 0;
        // The camera now (`pose`), what the map view wants (`map`), the follow
        // view's user offsets (`orbit`) and the first-person look-around (`look`).
        this.pose = { fx: 0, fz: 0, fy: 0, yaw: -Math.PI / 2, pitch: MAP_PITCH, dist: 1000, fov: 55, fogFar: 3000, mapness: 1 };
        this.map = { fx: 0, fz: 0, yaw: -Math.PI / 2, pitch: MAP_PITCH, dist: 1000, fit: 1000, track: false };
        this.orbit = { yaw: 0, pitch: FOLLOW_PITCH, zoom: 1 };
        this.look = { yaw: 0, pitch: 0 };
        this.want = { ...this.pose };
        this.anchor = 0;            // id of the creature the camera is attached to
        this.rel = { x: 0, z: 0 };  // focus − that creature's position
        this.heading = 0;           // its heading, smoothed
        // What the scene needs each frame: the floating origin (fx, fz), the
        // camera in render coordinates, and the box of ground that can be seen.
        // `planes`: the six planes of the camera's view, [nx, ny, nz, d] each,
        // so the scene can skip whatever is off screen.
        this.view = {
            W: 1, H: 1, fx: 0, fz: 0, camX: 0, camY: 0, camZ: 0,
            minX: 0, maxX: 0, minZ: 0, maxZ: 0, unitPx: 0.001, mapness: 1, dist: 1000, personalSpace: 0, fogFar: 3000,
            planes: new Float64Array(24),
        };
        this.v = new THREE.Vector3();
        this.frustum = new THREE.Frustum();
        this.viewProj = new THREE.Matrix4();
        this.pointers = new Map();
        this.dragged = false;
        this.bindInput();
        this.keys = new HeldKeys();
    }

    setMode(mode) {
        if (mode === this.mode) return;
        this.mode = mode;
        this.look.yaw = 0;
        this.look.pitch = 0;
        if (mode === 'map') {
            // Rise from wherever the camera is looking now; if someone is
            // followed, keep them centred.
            this.map.fx = this.pose.fx;
            this.map.fz = this.pose.fz;
            this.map.track = true;
        }
    }

    // A vertical field of view per mode, wide enough to take in the land
    // around. On a tall phone screen it is widened further so the view from
    // side to side is not a slit.
    fovFor(mode) {
        const aspect = this.w / this.h;
        const base = mode === 'map' ? 55 : mode === 'follow' ? 62 : 78;
        const across = mode === 'map' ? 0 : mode === 'follow' ? 34 : 62;
        const v = (2 * Math.atan(Math.tan((across * DEG) / 2) / aspect)) / DEG;
        return Math.min(Math.max(base, v), 90);
    }

    // The map distance at which the whole world fits on screen.
    fitDistance() {
        const vf = this.fovFor('map') * DEG;
        const hf = 2 * Math.atan(Math.tan(vf / 2) * (this.w / this.h));
        const across = this.W / 2 / Math.tan(hf / 2);
        const deep = (this.H * Math.sin(MAP_PITCH)) / 2 / Math.tan(vf / 2);
        return 1.08 * Math.max(across, deep);
    }

    resize(w, h) {
        this.w = w;
        this.h = h;
        this.map.fit = this.fitDistance();
        this.map.dist = Math.min(this.map.dist, this.map.fit * MAX_MAP_ZOOM);
    }

    // A new world: frame all of it, at an angle.
    attach(world, terrain) {
        this.W = world.width;
        this.H = world.height;
        this.ground = groundOf(terrain, this.W, this.H);
        // The ground as drawn (the mesh's triangles, see util.js), which the
        // eye must stay above.
        const out = [0, 0];
        this.surface = terrain ? (x, z) => (meshHeight(terrain, x, z, out), out[0]) : () => 0;
        this.lowest = 0;
        if (terrain) {
            this.lowest = Infinity;
            for (const h of terrain.height) if (h < this.lowest) this.lowest = h;
        }
        this.anchor = 0;
        this.orbit = { yaw: 0, pitch: FOLLOW_PITCH, zoom: 1 };
        const m = this.map;
        m.fx = this.W / 2;
        m.fz = this.H / 2;
        m.yaw = -Math.PI / 2; // looking toward −y: the map has the same layout as the 2D one
        m.pitch = MAP_PITCH;
        m.fit = this.fitDistance();
        m.dist = m.fit;
        m.track = false;
        Object.assign(this.pose, {
            fx: m.fx, fz: m.fz, fy: this.ground(m.fx, m.fz), yaw: m.yaw, pitch: tiltAt(m.pitch, m.dist),
            dist: m.dist, fov: this.fovFor('map'), fogFar: mapFog(m.dist), mapness: 1,
        });
        this.place();
    }

    // Glide toward what the current mode wants. `target` is the followed
    // creature ({ kind, pop, i }) or null; `dt` is real seconds.
    update(world, target, dt) {
        const { pose, map, W, H } = this;
        if (this.keys.any) this.steer(dt);
        const k = 1 - Math.exp(-dt / GLIDE);
        const id = target ? target.pop.id[target.i] : 0;
        const tracking = id !== 0 && (this.mode !== 'map' || map.track);
        let tx = 0;
        let tz = 0;
        if (target) {
            tx = target.pop.x[target.i];
            tz = target.pop.y[target.i];
            const h = target.pop.heading[target.i];
            if (id !== this.anchor) this.heading = h;
            else this.heading += angleDelta(h - this.heading) * (1 - Math.exp(-dt / TURN[this.mode === 'first' ? 'first' : 'follow']));
            this.heading = angleDelta(this.heading);
        }
        if (tracking && id !== this.anchor) {
            this.rel.x = wrapDelta(pose.fx - tx, W);
            this.rel.z = wrapDelta(pose.fz - tz, H);
        }
        this.anchor = tracking ? id : 0;

        // Where this mode wants the camera.
        const want = this.want;
        if (this.mode === 'map') {
            if (tracking) {
                map.fx = tx;
                map.fz = tz;
            }
            want.fx = map.fx;
            want.fz = map.fz;
            want.fy = this.ground(map.fx, map.fz);
            want.yaw = map.yaw;
            want.pitch = tiltAt(map.pitch, map.dist);
            want.dist = map.dist;
            want.fov = this.fovFor('map');
            want.fogFar = mapFog(map.dist);
            want.mapness = 1;
        } else if (target) {
            const b = BODY[target.kind];
            const gy = this.ground(tx, tz);
            if (this.mode === 'follow') {
                want.fx = tx;
                want.fz = tz;
                want.fy = gy + b.center;
                want.yaw = this.heading + this.orbit.yaw;
                want.pitch = this.orbit.pitch;
                want.dist = b.back * this.orbit.zoom;
                want.fov = this.fovFor('follow');
                want.fogFar = FOG.follow;
            } else {
                // The eyes, and a focus one unit in front of them.
                const yaw = this.heading + this.look.yaw;
                const pitch = FIRST_PITCH + this.look.pitch;
                const cp = Math.cos(pitch);
                want.fx = tx + Math.cos(this.heading) * b.ahead + Math.cos(yaw) * cp;
                want.fz = tz + Math.sin(this.heading) * b.ahead + Math.sin(yaw) * cp;
                want.fy = gy + b.eye - Math.sin(pitch);
                want.yaw = yaw;
                want.pitch = pitch;
                want.dist = 1;
                want.fov = this.fovFor('first');
                want.fogFar = FOG.first;
            }
            want.mapness = 0;
        } else {
            // Following someone who has just died: hold still where they were.
            Object.assign(want, pose);
        }

        // Glide.
        if (tracking) {
            this.rel.x += (wrapDelta(want.fx - tx, W) - this.rel.x) * k;
            this.rel.z += (wrapDelta(want.fz - tz, H) - this.rel.z) * k;
            pose.fx = wrap(tx + this.rel.x, W);
            pose.fz = wrap(tz + this.rel.z, H);
        } else {
            const kp = 1 - Math.exp(-dt / PAN_GLIDE);
            pose.fx = wrap(pose.fx + wrapDelta(want.fx - pose.fx, W) * kp, W);
            pose.fz = wrap(pose.fz + wrapDelta(want.fz - pose.fz, H) * kp, H);
        }
        pose.fy += (want.fy - pose.fy) * k;
        pose.yaw = angleDelta(pose.yaw + angleDelta(want.yaw - pose.yaw) * k);
        pose.pitch += (want.pitch - pose.pitch) * k;
        pose.dist *= Math.pow(want.dist / pose.dist, k);       // zoom glides evenly in log scale
        pose.fov += (want.fov - pose.fov) * k;
        pose.fogFar *= Math.pow(want.fogFar / pose.fogFar, k);
        pose.mapness += (want.mapness - pose.mapness) * k;

        // First-person look-around drifts back once the pointer (or the
        // keys) let go.
        if (!this.pointers.size && !(this.mode === 'first' && (this.keys.x || this.keys.y))) {
            const s = Math.exp(-dt / 0.8);
            this.look.yaw *= s;
            this.look.pitch *= s;
        }
        this.place();
    }

    // Put the three.js camera where the pose says, with the focus at the
    // origin, and work out which patch of ground it can see.
    place() {
        const { pose, camera, view } = this;
        const cp = Math.cos(pose.pitch);
        const sp = Math.sin(pose.pitch);
        const ex = -Math.cos(pose.yaw) * cp * pose.dist;
        const ez = -Math.sin(pose.yaw) * cp * pose.dist;
        let ey = pose.fy + sp * pose.dist;
        const near = clamp(pose.dist * 0.02, 0.2, 40);
        // Never look out from inside a hill: the eye stays above the ground as
        // drawn, where it is and around it as far as the near edge of the view
        // reaches (the map, zoomed in, skims the ground).
        const reach = 2 * near;
        let top = this.surface(pose.fx + ex, pose.fz + ez);
        for (const [ax, az] of CORNERS) top = Math.max(top, this.surface(pose.fx + ex + ax * reach, pose.fz + ez + az * reach));
        if (ey < top + 1.5) ey = top + 1.5;
        camera.position.set(ex, ey, ez);
        camera.lookAt(0, pose.fy, 0);
        camera.fov = pose.fov;
        camera.aspect = this.w / this.h;
        camera.near = near;
        camera.far = pose.fogFar * 1.05;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();

        // The visible ground: the camera's spot, plus where each corner of the
        // screen meets the lowest ground (or the fog, if it never does).
        let minX = ex;
        let maxX = ex;
        let minZ = ez;
        let maxZ = ez;
        const v = this.v;
        for (const [nx, ny] of CORNERS) {
            v.set(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize();
            let t = pose.fogFar;
            if (v.y < -1e-6) t = Math.min(t, (this.lowest - ey) / v.y);
            const px = ex + v.x * t;
            const pz = ez + v.z * t;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (pz < minZ) minZ = pz;
            if (pz > maxZ) maxZ = pz;
        }
        const pad = 25 + 0.05 * pose.fogFar;
        view.W = this.W;
        view.H = this.H;
        view.fx = pose.fx;
        view.fz = pose.fz;
        view.camX = ex;
        view.camY = ey;
        view.camZ = ez;
        view.minX = minX - pad;
        view.maxX = maxX + pad;
        view.minZ = minZ - pad;
        view.maxZ = maxZ + pad;
        view.unitPx = (2 * Math.tan((pose.fov * DEG) / 2)) / this.h; // world units per pixel, 1 unit away
        view.mapness = pose.mapness;
        view.dist = pose.dist;
        view.personalSpace = pose.dist < 6 ? 5 : 0; // first person: nobody is drawn this close to the eyes
        view.fogFar = pose.fogFar;
        this.frustum.setFromProjectionMatrix(this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        this.frustum.planes.forEach((p, i) => {
            view.planes[i * 4] = p.normal.x;
            view.planes[i * 4 + 1] = p.normal.y;
            view.planes[i * 4 + 2] = p.normal.z;
            view.planes[i * 4 + 3] = p.constant;
        });
    }

    // ---- Controls ----

    bindInput() {
        const el = this.canvas;
        el.addEventListener('pointerdown', (e) => {
            try {
                el.setPointerCapture(e.pointerId); // keep receiving moves outside the canvas
            } catch {
                // (synthetic events have no real pointer to capture)
            }
            this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (this.pointers.size === 1) {
                this.downX = e.clientX;
                this.downY = e.clientY;
                this.dragged = false;
                this.turning = e.button === 2 || e.ctrlKey || e.shiftKey;
            }
            this.pinch = null;
        });
        el.addEventListener('pointermove', (e) => {
            const p = this.pointers.get(e.pointerId);
            if (!p) return;
            const dx = e.clientX - p.x;
            const dy = e.clientY - p.y;
            p.x = e.clientX;
            p.y = e.clientY;
            if (this.pointers.size === 1) {
                // A few pixels of wobble is still a click.
                if (!this.dragged && Math.hypot(e.clientX - this.downX, e.clientY - this.downY) < 5) return;
                this.dragged = true;
                if (this.turning) this.turn(dx, dy);
                else this.pan(dx, dy);
            } else if (this.pointers.size === 2) {
                this.dragged = true;
                this.twoFingers();
            }
        });
        const up = (e) => {
            this.pointers.delete(e.pointerId);
            this.pinch = null;
        };
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('wheel', (e) => {
            e.preventDefault();
            const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
            this.zoom(Math.exp(dy * 0.0015));
        }, { passive: false });
        el.addEventListener('contextmenu', (e) => e.preventDefault());
        // A drag ends with a click; it must not also pick whoever is under the
        // pointer. (Registered before main.js's click handler, so it runs first.)
        el.addEventListener('click', (e) => {
            if (!this.dragged) return;
            this.dragged = false;
            e.stopImmediatePropagation();
        }, true);
    }

    // Pinch to zoom, twist to turn, move both fingers to pan.
    twoFingers() {
        const [a, b] = [...this.pointers.values()];
        const span = Math.hypot(b.x - a.x, b.y - a.y);
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const last = this.pinch;
        if (last) {
            if (span > 0 && last.span > 0) this.zoom(last.span / span);
            const twist = angleDelta(angle - last.angle);
            if (this.mode === 'map') this.map.yaw -= twist;
            else if (this.mode === 'follow') this.orbit.yaw -= twist;
            this.pan(mx - last.mx, my - last.my);
        }
        this.pinch = { span, angle, mx, my };
    }

    // Drag: move the map under the pointer; elsewhere, look around.
    pan(dx, dy) {
        if (this.mode !== 'map') {
            this.turn(dx, dy);
            return;
        }
        const { pose, map } = this;
        const perPx = pose.dist * this.view.unitPx;            // world units per pixel at the focus
        const deep = 1 / Math.max(0.4, Math.sin(pose.pitch));  // the ground is foreshortened up the screen
        const s = Math.sin(pose.yaw);
        const c = Math.cos(pose.yaw);
        map.fx = wrap(map.fx + (s * dx + c * dy * deep) * perPx, this.W);
        map.fz = wrap(map.fz + (-c * dx + s * dy * deep) * perPx, this.H);
        map.track = false; // panning lets go of whoever was centred
    }

    // Right-drag (or any drag outside the map): turn and tilt.
    turn(dx, dy) {
        if (this.mode === 'map') {
            // The drag tilts what is seen at this zoom, at the same rate at
            // any zoom, and is kept as the user's tilt it comes from.
            const { map } = this;
            map.yaw -= dx * 0.005;
            const lo = tiltAt(MAP_TILT[0], map.dist);
            const hi = tiltAt(MAP_TILT[1], map.dist);
            const seen = clamp(tiltAt(map.pitch, map.dist) + dy * 0.004, lo, hi);
            map.pitch = clamp(userTilt(seen, map.dist), MAP_TILT[0], MAP_TILT[1]);
        } else if (this.mode === 'follow') {
            this.orbit.yaw -= dx * 0.006;
            this.orbit.pitch = clamp(this.orbit.pitch + dy * 0.004, 4 * DEG, 85 * DEG);
        } else {
            this.look.yaw -= dx * 0.004;
            this.look.pitch = clamp(this.look.pitch - dy * 0.003, -40 * DEG, 50 * DEG);
        }
    }

    zoom(f) {
        if (this.mode === 'map') this.map.dist = clamp(this.map.dist * f, CLOSEST, this.map.fit * MAX_MAP_ZOOM);
        else if (this.mode === 'follow') this.orbit.zoom = clamp(this.orbit.zoom * f, 0.3, 3);
    }

    // Held keys, for `dt` seconds (see the header). They move what the mouse
    // moves (the map's focus, the follow orbit, the first-person look), so
    // the view glides after them just as it does after a drag.
    steer(dt) {
        const { x, y, turn } = this.keys;
        if (this.mode === 'map') {
            const map = this.map;
            if (x || y) {
                // Forward is the way the camera faces, flattened onto the ground.
                const step = KEY_RATE.pan * this.pose.dist * dt;
                const c = Math.cos(this.pose.yaw);
                const s = Math.sin(this.pose.yaw);
                map.fx = wrap(map.fx + (c * y - s * x) * step, this.W);
                map.fz = wrap(map.fz + (s * y + c * x) * step, this.H);
                map.track = false; // like a drag, it lets go of whoever was centred
            }
            map.yaw += turn * KEY_RATE.turn * dt;
        } else if (this.mode === 'follow') {
            // A larger yaw turns the view right (the camera swings left round the creature).
            this.orbit.yaw += x * KEY_RATE.orbit * dt;
            this.orbit.zoom = clamp(this.orbit.zoom * Math.exp(-y * KEY_RATE.zoom * dt), 0.3, 3);
        } else {
            this.look.yaw = clamp(this.look.yaw + x * KEY_RATE.lookYaw * dt, -120 * DEG, 120 * DEG);
            this.look.pitch = clamp(this.look.pitch - y * KEY_RATE.lookPitch * dt, -40 * DEG, 50 * DEG);
        }
    }
}
