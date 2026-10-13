// The 3D view: the same world as the 2D map, drawn with three.js. Like the
// canvas renderer it only reads the world, never changes it, and main.js
// drives both through the same small interface:
//
//   attach(world)  resize(world)  updateCamera(world, target, dt)
//   draw(world, target, focus, senseRadius)  pick(world, px, py)  mode
//
// and, for what the page adds on top, only here: pose(id, code, seconds),
// hold(id, code) and release(id) set anyone's pose (animate.js's POSE codes);
// setBlood(on) and blood, the Blood setting; effects (effects.js): spray,
// pool and carcass.
//
// Coordinates: world x → three.js X, world y → Z, height → Y; one world unit
// is one three.js unit. The parts: the ground (terrain-mesh.js), the forests
// (forest.js), the grass tufts near the camera (tufts.js), creatures, camps,
// the followed creature's marker, the sky, and the camera with its controls
// (camera.js), which also keeps the floating origin (see util.js). How each
// biome looks in all of them is in biomes.js.
//
// Draw calls stay few: a handful of ground copies, two instanced meshes for
// all the trees (one per kind), one for all the tufts, three more (one per
// species, the dead included), two for blood (droplets and pools), one for
// spears in the air (thrown.js), the water sheet, the sky, two per visible
// camp, two for all the camps' racks, and two for a tribe's standing order
// (its pole and a hunt's range: order-marker.js).
//
// On the warm lakes float giant water lilies (lilies.js: pads and flowers,
// two draw calls), with frogs among them (frogs.js: the frogs and their
// ripples, two more). Both are scenery only: nothing in the world knows them.
//
// Items (package 3): what people hold and what lies about (items.js: one
// mesh per kind, glints, flames, glows), the camps' piles
// of wood, flint and hide (camps.js), arrows (thrown.js), and the marks of
// work and skills (sparks.js: chips and sparks, a streak, a ring of dust).
import * as THREE from 'three';
import { CameraRig } from './camera.js';
import { Ground } from './terrain-mesh.js';
import { Forest } from './forest.js';
import { Tufts } from './tufts.js';
import { Creatures } from './creatures.js';
import { Effects } from './effects.js';
import { Thrown, playerBow } from './thrown.js';
import { Items } from './items.js';
import { Sparks } from './sparks.js';
import { Camps } from './camps.js';
import { Marker } from './marker.js';
import { OrderMarkers } from './order-marker.js';
import { Lineup } from './poses.js';
import { groundOf } from './util.js';
import { stubTerrain } from './terrain-stub.js';
import { Lilies } from './lilies.js';
import { Frogs } from './frogs.js';

// A soft daytime sky: a light hazy blue at the horizon, a muted blue
// overhead. The fog has the horizon's colour, so the far ground fades into the
// haze the way distant hills do (aerial perspective).
const SKY = '#b3c9da';
const ZENITH = '#6f90ad';
// The fog starts at this fraction of the far distance: about halfway near the
// ground, so the near and middle ground stay crisp, and later from the map's
// height, so the map stays crisp and only its far edge, toward the horizon,
// fades.
const FOG_NEAR = { ground: 0.5, map: 0.62 };
const NONE = Object.freeze([]);

// A dome around the camera with the sky's gradient, drawn behind everything.
// Below the horizon it is the fog's colour. Above, it turns blue quickly
// over the first few degrees and then slowly toward the top: a band of haze
// along the horizon, as on a clear day.
function skyDome() {
    const material = new THREE.ShaderMaterial({
        uniforms: { horizon: { value: new THREE.Color(SKY) }, zenith: { value: new THREE.Color(ZENITH) } },
        vertexShader: `
            varying vec3 vDir;
            void main() {
                vDir = position;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: `
            uniform vec3 horizon;
            uniform vec3 zenith;
            varying vec3 vDir;
            void main() {
                float up = clamp(normalize(vDir).y, 0.0, 1.0);
                float t = 1.0 - pow(1.0 - up, 2.5);
                gl_FragColor = vec4(mix(horizon, zenith, t), 1.0);
                #include <colorspace_fragment>
            }`,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), material);
    dome.renderOrder = -1;
    dome.frustumCulled = false;
    return dome;
}

// DEV ONLY: `?stubterrain` shows a made-up terrain while the engine has none.
const STUB = new URLSearchParams(location.search).has('stubterrain');
// DEV ONLY: `?poses` (or `?poses=human`...) shows every pose lined up instead
// of the world (poses.js).
const LINEUP = new URLSearchParams(location.search).get('poses');

export class View3D {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
        this.gl.setClearColor(SKY);
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(SKY);
        this.scene.fog = new THREE.Fog(SKY, 1000, 3000);
        // Plenty of soft light from the sky (a little blue), some bounced off
        // the ground, and a fairly low sun (40°) from the north-west, the top
        // left of the map: it models the hills. Under a daytime sky the land
        // is a little brighter than the 2D view's colours, and slopes facing
        // away from the sun stay readable rather than going black.
        const sky = new THREE.HemisphereLight('#e0e9f0', '#6a6c5a', 2.6);
        const sun = new THREE.DirectionalLight('#fff6ea', 3.0);
        sun.position.set(-0.6, 0.62, -0.45);
        this.dome = skyDome();
        this.scene.add(sky, sun, this.dome);

        this.rig = new CameraRig(canvas);
        this.ground = new Ground(this.scene, this.gl);
        this.forest = new Forest(this.scene);
        this.tufts = new Tufts(this.scene);
        this.lilies = new Lilies(this.scene);
        this.frogs = new Frogs(this.scene);
        this.creatures = new Creatures(this.scene);
        this.effects = new Effects(this.scene, this.creatures.motion); // the dead, and blood
        this.thrown = new Thrown(this.scene); // spears in the air
        this.items = new Items(this.scene);   // items held and lying (package 3)
        this.sparks = new Sparks(this.scene); // chips, sparks, skills
        this.camps = new Camps(this.scene, this.gl);
        this.orders = new OrderMarkers(this.scene); // a tribe's standing order (orders.js)
        this.marker = new Marker(this.scene);
        this.lineup = LINEUP === null ? null : new Lineup(LINEUP);
        // JavaScript milliseconds per frame, for the last frame and smoothed:
        // our own updates (camera, ground, tufts, creatures, camps, marker),
        // and three.js's render call. The tufts keep their own finer numbers
        // in this.tufts.stats (refills and the frames without one).
        this.stats = { update: 0, render: 0, lastUpdate: 0, lastRender: 0 };
    }

    get mode() {
        return this.rig.mode;
    }

    set mode(mode) {
        this.rig.setMode(mode);
    }

    attach(world) {
        this.terrain = world.terrain ?? (STUB ? stubTerrain(world) : null);
        this.heightAt = groundOf(this.terrain, world.width, world.height);
        this.resize(world);
        this.ground.attach(world, this.terrain);
        this.forest.attach(world, this.terrain, this.ground);
        this.tufts.attach(world, this.terrain, this.ground);
        this.lilies.attach(world, this.terrain);
        this.frogs.attach(world, this.terrain, this.lilies.places);
        this.creatures.attach();
        this.effects.attach(this.heightAt);
        this.thrown.attach();
        this.items.attach();
        this.sparks.attach();
        this.camps.attach();
        this.orders.attach();
        this.rig.attach(world, this.terrain);
    }

    resize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.gl.setSize(w, h);
        this.rig.resize(w, h);
        this.lineup?.resize(w, h);
    }

    updateCamera(world, target, dt) {
        const t0 = performance.now();
        this.rig.update(world, target, dt);
        this.cameraMs = performance.now() - t0;
    }

    draw(world, target, focus, senseRadius) {
        if (this.lineup) {
            this.lineup.draw(this.gl);
            return;
        }
        const t0 = performance.now();
        const view = this.rig.view;
        this.scene.fog.far = view.fogFar;
        this.scene.fog.near = view.fogFar * (FOG_NEAR.ground + (FOG_NEAR.map - FOG_NEAR.ground) * view.mapness);
        this.dome.position.set(view.camX, view.camY, view.camZ);
        this.dome.scale.setScalar(view.fogFar * 0.9);
        this.ground.update(world);
        this.ground.place(view);
        this.forest.update(view, this.rig.pose.fy);
        this.tufts.update(world, view, this.rig.camera, this.heightAt);
        this.lilies.update(view);
        this.frogs.update(world, view, this.creatures.motion);
        // In first person we look out of the followed creature's eyes, so its
        // own body is not drawn (once the camera is close enough to be inside it).
        const inside = target && this.rig.mode === 'first' && this.rig.pose.dist < 6;
        // Strides, poses and the marks of death keep the moment drawn.
        const shown = world.shown ?? world.time;
        const motion = this.creatures.motion;
        motion.tick(shown, t0);
        this.effects.tick(motion.clock, shown);
        // (The body the page plays strikes and throws by itself: play/modes.js.)
        const player = world.player ?? null;
        const self = player !== null && !player.auto ? player.id : 0;
        const events = world.events ?? NONE;
        this.effects.handle(events, self);
        this.effects.follow(world.carcasses ?? NONE);
        this.thrown.handle(events, motion, self, playerBow(world));
        this.sparks.handle(events, this.heightAt, motion.clock);
        const hidden = inside ? target.pop.id[target.i] : 0;
        this.creatures.update(world, view, this.heightAt, hidden, this.effects);
        this.items.update(world, view, this.heightAt, motion, hidden, motion.clock);
        this.effects.update(view);
        this.thrown.update(world, view, this.heightAt, motion.clock);
        this.sparks.update(view, motion.clock);
        this.camps.update(world, view, this.heightAt);
        this.orders.update(world, view, this.heightAt);
        this.marker.update(world, view, this.heightAt, target, focus, senseRadius);
        const t1 = performance.now();
        this.gl.render(this.scene, this.rig.camera);
        const t2 = performance.now();
        const s = this.stats;
        s.lastUpdate = t1 - t0 + (this.cameraMs || 0);
        s.lastRender = t2 - t1;
        s.update += (s.lastUpdate - s.update) * 0.05;
        s.render += (s.lastRender - s.render) * 0.05;
    }

    // The id of whoever is drawn under pixel (px, py) (within 16 px), or 0.
    pick(world, px, py) {
        return this.creatures.pick(this.rig.camera, this.rig.w, this.rig.h, px, py);
    }

    // The world point {x, y} on the ground under pixel (px, py), or null
    // (the sky). Calls to a tribe are given there (play/calls.js).
    groundAt(px, py) {
        const out = { x: 0, y: 0 };
        return this.rig.groundAt(px, py, out) ? out : null;
    }

    // A one-shot pose on anyone (`seconds` at 1×; it defaults to the pose's own).
    pose(id, code, seconds) {
        this.creatures.motion.pose(id, code, seconds);
    }

    // A pose shown until release(id).
    hold(id, code) {
        this.creatures.motion.hold(id, code);
    }

    release(id) {
        this.creatures.motion.release(id);
    }

    get blood() {
        return this.effects.blood;
    }

    // Sprays and pools on or off (the dead fall either way). The panel's
    // switch calls this; main.js remembers the choice.
    setBlood(on) {
        this.effects.setBlood(on);
    }
}
