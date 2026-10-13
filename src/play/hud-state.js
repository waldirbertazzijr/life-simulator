// What the HUD shows each frame, as one plain object (hud.js draws it, in
// update): who you are and your bars, the compass's marks (with the sun or
// the moon) and the date under it, what you carry
// (the pouch) and hold, your tribe's store, the prompt, the work under way,
// the call in the slot, and the ring on the locked target. Filled in place
// every frame, after the camera has moved, so the ring sits on what is
// drawn.
//
// Something new on the HUD: a field here, drawn in hud.js (update), with its
// markup and style in index.html.
//
// `m` is modes.js's Modes: who you are, your body, the world, the page.
import { STAMINA } from './body.js';
import { personName, ageText } from './names.js';
import { equipment } from './gear.js';
import { CENTER } from './aim.js';
import { DOING, sayE } from './context.js';
import { sleepWork } from './sleep.js';
import { wrapDelta } from '../view3d/util.js';
import { when, dateLabel } from '../calendar.js';
import { clockOf, moonOf } from '../view3d/almanac.js';

// Fill `s` (the HUD's state) for this frame, and return it.
export function fillHud(m, s) {
    const w = m.world;
    const P = w.p.human;
    const b = m.body;
    const f = m.self && !m.dying ? w.find(m.self) : null;
    const tribe = w.tribeById.get(m.tribe) ?? null;
    const p = w.player && w.player.id === m.self ? w.player : null;
    const spiritMax = w.p.play?.spiritMax ?? 100;
    const paused = m.env.getPaused();
    const id = m.dying ? m.dying.dead.id : m.self;
    s.name = personName(id);
    s.age = m.known ? ageText(m.known.age, P.maturity) : '';
    s.life = f ? f.pop.energy[f.i] / P.maxEnergy : 0;
    s.spirit = (p ? p.spirit : spiritMax) / spiritMax;
    s.stamina = b.stamina / STAMINA.max;
    s.tribe = tribe;
    s.yaw = b.yaw;
    s.camp = tribe ? Math.atan2(wrapDelta(tribe.camp.y - b.y, w.height), wrapDelta(tribe.camp.x - b.x, w.width)) : null;
    // The date, and the sun or the moon on the compass (skyMarks).
    const time = clockOf(w);
    s.date = dateLabel(w.p.calendar, time);
    s.sky = skyMarks(when(w.p.calendar, time), w.p.calendar);
    // The pouch (pouch.js): the kind in the down slot, its count and how full.
    const pouch = m.hands.contents();
    s.pouch = m.pouch.view(pouch);
    s.store = tribe ? tribe.store : 0;
    s.prompt = m.dying || m.kit.menu ? null : paused ? [['P', 'Resume']] : promptOf(m, f);
    s.reload = f ? m.hands.reloading() : 0;
    s.charge = m.input.charging === true ? m.input.charge : 0;
    s.crouch = b.crouch;
    // Your call, and your tribe's standing order on the compass (calls.js).
    s.call = m.calls.call;
    const order = tribe?.order ?? null;
    s.order = order ? Math.atan2(wrapDelta(order.y - b.y, w.height), wrapDelta(order.x - b.x, w.width)) : null;
    // What you hold (gear.js), and the store's materials; the craft menu
    // follows the store while it is open.
    s.gear = equipment(w, p);
    s.materials = s.gear.on && tribe ? { wood: tribe.wood ?? 0, flint: tribe.flint ?? 0, hide: tribe.hide ?? 0 } : null;
    s.item = crossName(s.gear, s.pouch);
    s.work = m.dying ? null : m.asleep ? sleepWork(w) : workOf(w, p, s.gear, pouch);
    s.hint = m.hints?.shown ?? null; // first steps (home/hints.js)
    if (m.kit.menu) m.kit.showCraft();
    s.ring = null;
    s.target = null;
    const t = m.lock ? w.find(m.lock) : null;
    if (t) {
        const tx = t.pop.x[t.i];
        const ty = t.pop.y[t.i];
        s.target = Math.atan2(wrapDelta(ty - b.y, w.height), wrapDelta(tx - b.x, w.width));
        const rig = m.env.rig();
        const h = (w.terrain ? w.terrain.heightAt(tx, ty) : 0) + CENTER[t.kind];
        if (rig && rig.project(tx, ty, h, m.point)) s.ring = m.point;
    }
    return s;
}

// The name under the cross, { text, tint (a rarity, or '') }: the pouch's
// ('Wood 5 / 8') while it shows wood or flint, else the weapon in hand's.
export function crossName(gear, pouch) {
    if (pouch && pouch.kind !== 'food') return { text: pouch.name, tint: '' };
    const w = gear?.weapon ?? null;
    return { text: w ? w.name : 'Unarmed', tint: w && !w.legacy ? w.rarity : '' };
}

// The work bar above the prompt (hud.js work): what your person is at, by
// the simulation's report `p`, as { label, progress (0..1) }, or null.
// Butchering, by the carcass's cut; chopping and knapping, by the load
// filling up; gathering, by the pouch filling (the simulation stops it
// when full); crafting, by the time left (gear.js). The hands' work comes
// first. `gear` is equipment()'s, `pouch` pouch.js's contents. A new timed
// act: a line here.
export function workOf(world, p, gear, pouch) {
    if (!p) return null;
    if (p.butchering) return { label: 'Butchering', progress: cutOf(world, p.butchering) };
    if (p.gathering === 'wood') return { label: 'Chopping wood', progress: share(pouch.load, pouch.max.wood) };
    if (p.gathering === 'flint') return { label: 'Knapping flint', progress: share(pouch.load, pouch.max.flint) };
    if (p.gathering === 'food' || p.gathering === true) return { label: 'Gathering', progress: share(pouch.food, pouch.max.food) };
    if (gear?.crafting) return { label: `Crafting a ${gear.crafting.kind}`, progress: gear.crafting.progress };
    return null;
}

const share = (v, most) => (most > 0 ? Math.min(1, Math.max(0, v / most)) : 0);

// How far the carcass `id` is cut up (0..1; the Mirror's `carcasses`).
function cutOf(world, id) {
    for (const c of world.carcasses ?? []) if (c.id === id) return share(c.cut ?? 0, 1);
    return 0;
}

// The sun, or by night the moon, as the compass shows it (hud.js): its
// bearing as a world angle (atan2(dy, dx), like the camp's: the sky's
// bearings run from the east through the north, which is −y), how high it
// is (radians), the moon's phase, and the sun's bearing (the moon is lit on
// its side); null when neither is up. `w` is the calendar's when() (`c`
// the calendar: the moon as the page draws it, almanac.js moonOf).
export function skyMarks(w, c) {
    if (w.sun.alt > -0.01) return { body: 'sun', angle: -w.sun.az, alt: w.sun.alt, phase: 0, sun: -w.sun.az };
    const moon = moonOf(w, c);
    if (moon.alt > 0) return { body: 'moon', angle: -moon.az, alt: moon.alt, phase: moon.phase, sun: -w.sun.az };
    return null;
}

// The prompt: what E would do (or is doing: context.js), and R while you
// carry food. A list of [key, what], or null.
export function promptOf(m, f) {
    if (m.resting) return [['E', m.asleep ? 'Wake' : 'Rise']];
    const out = [];
    const doing = m.hands.doing;
    if (doing) out.push(['E', DOING[doing.kind] ?? 'Butchering']);
    else {
        const what = m.hands.interaction();
        if (what) out.push(sayE(what));
    }
    if (f && m.hands.carried(f) >= 1) out.push(['R', 'Eat']);
    return out.length ? out : null;
}
