// Where you look, and what is within reach: the mouse's look and how far
// it tilts, lock-on (Q), what an attack or a tool goes for, and how far the
// hands reach. It only reads the world (the Mirror) and moves the look;
// modes.js, hands.js and kit.js act on what it finds.
import { DEG, wrapDelta, angleDelta, clamp } from '../view3d/util.js';

export const LOOK_RATE = 0.0024;  // radians per pixel of mouse movement
// How far the look tilts (positive looks down), and where it starts.
export const PITCH = { shoulder: [-72 * DEG, 60 * DEG], first: [-85 * DEG, 70 * DEG] }; // (far up: the sky is worth it)
export const START_PITCH = { shoulder: 9 * DEG, first: 4 * DEG };
// Lock-on (Q): the nearest creature within `range` and `cone` of the look;
// it is let go beyond `keep`. The view turns to it in about `ease` seconds.
export const LOCK = { range: 60, cone: 35 * DEG, keep: 90, ease: 0.25 };
// Heights, for aiming at things: the eyes, how much higher the shoulder
// camera's focus is, and the middle of each kind of body (creatures.js).
const EYE = 4.1;
const SHOULDER_UP = 0.7;
export const CENTER = { herbivore: 2.0, carnivore: 1.7, human: 2.4 };

// The simulation's reaches (params.play), should a world not have them.
export const HANDS = { jabRange: 5, jabArc: Math.PI / 4, heavyRange: 34, butcherReach: 4, rackReach: 8, takeMax: 40 };
export const AIMED = 12 * DEG; // a creature this near the aim is what an attack goes for
// A creature drawn this near the crosshair (px) is what a shot is aimed at: at
// its middle, and led like a locked one.
export const SIGHT_PX = 28;
// Items: a club's swing and a knife's cut reach this far; an item lying
// this near (at your feet) is picked up before the rack is used, one within
// `reach` (the simulation's) only when the rack offers nothing.
export const ITEMS = { swing: 4, cut: 3, feet: 3, reach: 6 };

// The id of the creature to lock on to from (x, y) looking along `yaw`:
// the nearest within `range` and `cone` of the look, never `self`; 0 if none.
export function lockTarget(world, x, y, yaw, self, range = LOCK.range, cone = LOCK.cone) {
    const { width: W, height: H } = world;
    let best = 0;
    let bestD = range;
    for (const pop of [world.herbivores, world.carnivores, world.humans]) {
        for (let i = 0; i < pop.n; i++) {
            if (pop.id[i] === self) continue;
            const dx = wrapDelta(pop.x[i] - x, W);
            const dy = wrapDelta(pop.y[i] - y, H);
            const d = Math.hypot(dx, dy);
            if (d > bestD || Math.abs(angleDelta(Math.atan2(dy, dx) - yaw)) > cone) continue;
            best = pop.id[i];
            bestD = d;
        }
    }
    return best;
}

// Keep the lock on `id` while it lives and is near: the look (the body's
// yaw and pitch, seen from `view`) turns toward it. Returns `id`, or 0 when
// the lock is let go.
export function keepLock(world, body, id, view, dt) {
    const t = world.find(id);
    if (!t) return 0;
    const dx = wrapDelta(t.pop.x[t.i] - body.x, world.width);
    const dy = wrapDelta(t.pop.y[t.i] - body.y, world.height);
    const d = Math.hypot(dx, dy);
    if (d > LOCK.keep) return 0;
    const k = 1 - Math.exp(-dt / LOCK.ease);
    body.yaw = angleDelta(body.yaw + angleDelta(Math.atan2(dy, dx) - body.yaw) * k);
    const ground = (x, y) => (world.terrain ? world.terrain.heightAt(x, y) : 0);
    const eye = ground(body.x, body.y) + EYE + (view === 'shoulder' ? SHOULDER_UP : 0);
    const at = ground(t.pop.x[t.i], t.pop.y[t.i]) + CENTER[t.kind];
    const want = clamp(Math.atan2(eye - at, Math.max(d, 1)), ...PITCH[view]);
    body.pitch += (want - body.pitch) * k;
    return id;
}

// The nearest creature to `from` (never `self` or one of `tribe`) within
// `range` and `arc` (radians, either way) of (dx, dy), as drawn: its id, or
// 0. Within the jab's reach and arc, it is what the simulation jabs.
export function nearestAlong(world, from, dx, dy, range, arc, self, tribe) {
    const cone = Math.cos(arc);
    let best = 0;
    let bestD = range;
    for (const pop of [world.herbivores, world.carnivores, world.humans]) {
        for (let i = 0; i < pop.n; i++) {
            if (pop.id[i] === self || (pop === world.humans && pop.tribe[i] === tribe)) continue;
            const ex = wrapDelta(pop.x[i] - from.x, world.width);
            const ey = wrapDelta(pop.y[i] - from.y, world.height);
            const d = Math.hypot(ex, ey);
            if (d > bestD || (d > 1e-9 && ex * dx + ey * dy < d * cone)) continue;
            best = pop.id[i];
            bestD = d;
        }
    }
    return best;
}

// Is `id` someone of `tribe`?
export function mateOf(world, id, tribe) {
    const f = world.find(id);
    return f !== null && f.kind === 'human' && f.pop.tribe[f.i] === tribe;
}
