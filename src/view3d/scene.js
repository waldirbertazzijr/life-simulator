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
// (forest.js), the grass tufts and flowers near the camera (tufts.js),
// creatures, camps, the followed creature's marker, the sky and its light
// (sky.js), the rain and snow (weather.js), and the camera with its controls
// (camera.js), which also keeps the floating origin (see util.js). How each
// biome looks in all of them is in biomes.js.
//
// Time and the seasons (stage 4): each frame the moment drawn (almanac.js
// clockOf: the Mirror's) gives the season's look (seasonLook), which every
// part takes: the sky and the light, the haze (haze.js), the grass's colour,
// the snow and the ice, the leaves, the flowers, the lilies, the weather.
//
// Draw calls stay few: a handful of ground copies, four instanced meshes for
// all the trees (one per kind), one for all the tufts and one for the
// flowers, the creatures (one per species, people one per body, each with a
// far level; the dead included), two for blood (droplets and pools), one for
// spears in the air (thrown.js), the water sheet, the sky's dome and its
// stars, the rain or the snow, two per visible camp, two for all the camps'
// racks, and two for a tribe's standing order (its pole and a hunt's range:
// order-marker.js).
//
// On the warm lakes float giant water lilies (lilies.js: pads and flowers,
// two draw calls), with frogs among them (frogs.js: the frogs and their
// ripples, two more). Both are scenery only: nothing in the world knows them.
//
// The graphics setting (graphics.js: High, Medium, Low; setQuality): Medium
// and High add shadows (shadows.js: one more pass, the shadow map, with the
// casters' draw calls); High adds the light's diffusion: a soft darkness
// where things meet the ground (contact.js: one draw call), glints on the
// snow, and the screen's passes (post.js: the light rays and the bloom).
// Low is the view as it was before them.
//
// Items (package 3): what people hold and what lies about (items.js: one
// mesh per kind, glints, flames, glows), the camps' piles
// of wood, flint and hide (camps.js), arrows (thrown.js), and the marks of
// work and skills (sparks.js: chips and sparks, a streak, a ring of dust).
import * as THREE from 'three';
import './haze.js'; // (first: it patches three.js's shaders before anything is compiled)
import { Shadows } from './shadows.js'; // (patches them too)
import { Post } from './post.js';
import { Contact } from './contact.js';
import { PRESETS, SUN_LIGHT_MIN, rayStrength } from './graphics.js';
import { moonOf } from './almanac.js';
import { CameraRig } from './camera.js';
import { Sky } from './sky.js';
import { Weather } from './weather.js';
import { clockOf, seasonLook } from './almanac.js';
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
import { groundOf, smoothstep, meshHeight } from './util.js';
import { stubTerrain } from './terrain-stub.js';
import { Lilies } from './lilies.js';
import { Looks } from './looks.js';
import { Preview } from './preview.js';
import { Frogs } from './frogs.js';

// The fog has the horizon's colour (and glows toward the sun: haze.js), so
// the far ground fades into the haze the way distant hills do (aerial
// perspective). It starts at this fraction of the far distance: about
// halfway near the ground, so the near and middle ground stay crisp, and
// later from the map's height, so the map stays crisp and only its far
// edge, toward the horizon, fades. Rain and snow draw it in (CLOUDED).
const FOG_NEAR = { ground: 0.5, map: 0.62 };
const CLOUDED = 0.4;
const NONE = Object.freeze([]);
// With the light's diffusion (High): how much brighter than white the moon's
// disc is at night (sky.js glare), and the snow's glints (terrain-mesh.js).
const GLARE = 1.9;
const GLINT = 5;
// With shadows: how much more a low sun lights the grass (terrain-mesh.js).
const GRASS_LIGHT = 0.45;

// DEV ONLY: `?stubterrain` shows a made-up terrain while the engine has none.
const STUB = new URLSearchParams(location.search).has('stubterrain');
// DEV ONLY: `?poses` (or `?poses=human`...) shows every pose lined up instead
// of the world (poses.js).
const LINEUP = new URLSearchParams(location.search).get('poses');

export class View3D {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color();
        this.scene.fog = new THREE.Fog('#b3c9da', 1000, 3000);
        // The sky and its light, the sun's or the moon's, by the time of day
        // (sky.js); the weather near the camera (weather.js).
        this.sky = new Sky(this.scene);
        this.weather = new Weather(this.scene);

        this.rig = new CameraRig(canvas);
        this.ground = new Ground(this.scene, this.gl);
        this.forest = new Forest(this.scene);
        this.tufts = new Tufts(this.scene);
        this.lilies = new Lilies(this.scene);
        this.frogs = new Frogs(this.scene);
        this.looks = new Looks(); // how each person looks (looks.js; the editor changes it)
        this.creatures = new Creatures(this.scene, this.looks);
        this.creatures.useModels(); // the sheep, the wolf and the people (models.js), swapped in once loaded
        this.effects = new Effects(this.scene, this.creatures.motion); // the dead, and blood
        this.thrown = new Thrown(this.scene); // spears in the air
        this.items = new Items(this.scene);   // items held and lying (package 3)
        this.items.rigOf = (id) => this.creatures.rigOf(id); // (in each body's hands)
        this.sparks = new Sparks(this.scene); // chips, sparks, skills
        this.camps = new Camps(this.scene, this.gl);
        this.orders = new OrderMarkers(this.scene); // a tribe's standing order (orders.js)
        this.marker = new Marker(this.scene);
        this.lineup = LINEUP === null ? null : new Lineup(LINEUP);
        // The graphics setting (setQuality): shadows, the darkness where
        // things meet the ground, and the screen's passes (made when needed).
        this.shadows = new Shadows(this.gl, this.scene, this.sky.light);
        this.contact = new Contact(this.scene);
        this.post = null;
        this.quality = 'low';
        this.world = null;
        this.toLight = new THREE.Vector3();
        this.ahead = new THREE.Vector3();
        this.lightColor = new THREE.Color();
        this.gl.info.autoReset = false; // (a frame is several render calls with the passes: counted whole, in draw)
        // JavaScript milliseconds per frame, for the last frame and smoothed:
        // our own updates (camera, ground, tufts, creatures, camps, marker),
        // and three.js's render call (with the passes). The tufts keep their
        // own finer numbers in this.tufts.stats (refills and the frames
        // without one). What the graphics card was given last frame: draw
        // calls, triangles, the shadow map drawn or not, full-screen passes.
        this.stats = { update: 0, render: 0, lastUpdate: 0, lastRender: 0, calls: 0, triangles: 0, shadowPass: 0, postPasses: 0 };
    }

    // The graphics setting: 'high', 'medium' or 'low' (graphics.js).
    setQuality(quality) {
        if (!PRESETS[quality]) return;
        this.quality = quality;
        const diffusion = PRESETS[quality].diffusion;
        this.shadows.set(quality);
        this.forest.shadowBox = this.shadows.on ? this.shadows.box : null;
        if (diffusion && !this.post) this.post = new Post(this.gl, this.scene, this.rig.camera);
        if (!diffusion && this.post) {
            this.post.dispose();
            this.post = null;
        }
        this.sky.glare = diffusion ? GLARE : 1;
        this.ground.glint.value = diffusion ? GLINT : 0;
        this.ground.grassLight.value = this.shadows.on ? GRASS_LIGHT : 0;
        this.contact.set(diffusion, this.world, this.ground, this.forest);
    }

    get mode() {
        return this.rig.mode;
    }

    set mode(mode) {
        this.rig.setMode(mode);
    }

    attach(world) {
        this.world = world;
        this.terrain = world.terrain ?? (STUB ? stubTerrain(world) : null);
        this.heightAt = groundOf(this.terrain, world.width, world.height);
        // The ground as drawn (its triangles: util.js), for what lies on it.
        const T = this.terrain;
        const out = [0, 0];
        this.surfaceAt = T ? (x, y) => (meshHeight(T, x, y, out), out[0]) : () => 0;
        this.resize(world);
        this.ground.attach(world, this.terrain);
        this.forest.attach(world, this.terrain, this.ground);
        this.tufts.attach(world, this.terrain, this.ground);
        this.lilies.attach(world, this.terrain);
        this.frogs.attach(world, this.terrain, this.lilies.places);
        this.looks.attach(world);
        this.creatures.attach();
        this.effects.attach(this.heightAt);
        this.thrown.attach();
        this.items.attach();
        this.sparks.attach();
        this.camps.attach();
        this.orders.attach();
        this.rig.attach(world, this.terrain);
        this.contact.set(!!this.post, world, this.ground, this.forest); // (the new world's trees)
        this.shadows.flag();
        // Every material now, hidden ones too (the stars wait for the night,
        // the rain and snow for their weather): a first compile later would
        // stall that frame. (With the screen's passes, as drawn into their
        // render target.)
        if (this.post) this.gl.setRenderTarget(this.post.scene);
        this.gl.compile(this.scene, this.rig.camera);
        this.gl.setRenderTarget(null);
    }

    resize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.gl.setSize(w, h);
        this.rig.resize(w, h);
        this.post?.resize();
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
        // The moment drawn, and what its season looks like (almanac.js).
        const cal = world.p.calendar;
        const look = seasonLook(cal, world.seed, clockOf(world));
        this.look = look;
        this.sky.update(look.w, cal, look.overcast, view, this.scene, t0 / 1000, this.gl.getPixelRatio());
        this.shadows.update(view, this.rig.camera, this.sky.now, look.w.sun.alt, look.overcast, this.rig.pose.fy);
        const clear = 1 - CLOUDED * look.overcast;
        this.scene.fog.far = view.fogFar * clear;
        this.scene.fog.near = view.fogFar * clear * (FOG_NEAR.ground + (FOG_NEAR.map - FOG_NEAR.ground) * view.mapness);
        this.ground.update(world, look);
        this.ground.place(view);
        this.forest.update(view, this.rig.pose.fy, look);
        this.tufts.update(world, view, this.rig.camera, this.heightAt, look);
        this.lilies.update(view, look);
        this.frogs.update(world, view, this.creatures.motion, look);
        this.weather.update(view, look, t0 / 1000, this.gl.getPixelRatio());
        // In first person we look out of the followed creature's eyes, so its
        // own body is not drawn (once the camera is close enough to be inside it).
        const inside = target && this.rig.mode === 'first' && this.rig.pose.dist < 6;
        // Strides, poses and the marks of death keep the moment drawn.
        const shown = world.shown ?? world.time;
        const motion = this.creatures.motion;
        motion.tick(shown, t0);
        this.effects.tick(motion.clock, shown);
        // (The body the page plays strikes and throws by itself: play/hands.js.)
        const player = world.player ?? null;
        const self = player !== null && !player.auto ? player.id : 0;
        const events = world.events ?? NONE;
        this.effects.handle(events, self);
        this.effects.follow(world.carcasses ?? NONE);
        this.thrown.handle(events, motion, self, playerBow(world));
        this.sparks.handle(events, this.heightAt, motion.clock);
        const hidden = inside ? target.pop.id[target.i] : 0;
        this.creatures.night = look.w.part === 'night';
        this.creatures.update(world, view, this.heightAt, hidden, this.effects);
        this.contact.update(this.creatures, view, this.surfaceAt);
        this.items.update(world, view, this.heightAt, motion, hidden, motion.clock, 1 - smoothstep(-0.1, 0.1, look.w.sun.alt));
        this.effects.update(view);
        this.thrown.update(world, view, this.heightAt, motion.clock);
        this.sparks.update(view, motion.clock);
        this.camps.update(world, view, this.heightAt);
        this.orders.update(world, view, this.heightAt);
        this.marker.update(world, view, this.heightAt, target, focus, senseRadius);
        if (this.post) this.aimRays(look);
        const t1 = performance.now();
        this.gl.info.reset();
        if (this.post) this.post.render();
        else this.gl.render(this.scene, this.rig.camera);
        const t2 = performance.now();
        const s = this.stats;
        s.lastUpdate = t1 - t0 + (this.cameraMs || 0);
        s.lastRender = t2 - t1;
        s.update += (s.lastUpdate - s.update) * 0.05;
        s.render += (s.lastRender - s.render) * 0.05;
        s.calls = this.gl.info.render.calls;
        s.triangles = this.gl.info.render.triangles;
        s.shadowPass = this.shadows.stats.drawn ? 1 : 0;
        s.postPasses = this.post ? this.post.passes : 0;
    }

    // The light rays this frame (post.js): from the sky's light (the sun, or
    // the moon at night: graphics.js), where it is on the screen.
    aimRays(look) {
        const d = this.sky.now;
        const w = look.w;
        const bySun = d.sun.intensity > SUN_LIGHT_MIN;
        const moon = moonOf(w);
        const camera = this.rig.camera;
        const dir = bySun ? this.sky.sunDir : this.sky.moonDir;
        const p = this.toLight.copy(dir).multiplyScalar(100).add(camera.position).project(camera);
        const front = dir.dot(camera.getWorldDirection(this.ahead)) > 0.05;
        const strength = rayStrength({
            by: bySun ? 'sun' : 'moon', alt: bySun ? w.sun.alt : moon.alt, x: p.x, y: p.y, front, lit: moon.lit, overcast: look.overcast,
        });
        const c = bySun ? d.sun.color : d.moon.color;
        this.lightColor.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
        this.post.aim(strength, (p.x + 1) / 2, (p.y + 1) / 2, this.lightColor);
    }

    // The id of whoever is drawn under pixel (px, py) (within `radius` px, 16;
    // skip(id) true passes someone over), or 0.
    pick(world, px, py, radius, skip) {
        return this.creatures.pick(this.rig.camera, this.rig.w, this.rig.h, px, py, radius, skip);
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

    // The character editor's turning preview (play/editor.js), on its canvas.
    preview(canvas) {
        return new Preview(canvas);
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
