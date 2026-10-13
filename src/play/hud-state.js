// What the HUD shows each frame, as one plain object (hud.js draws it, in
// update): who you are and your bars, the compass's marks, what you carry
// and hold, your tribe's store, the prompt, the call in the slot, and the
// ring on the locked target. Filled in place every frame (no garbage),
// after the camera has moved, so the ring sits on what is drawn.
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
import { wrapDelta } from '../view3d/util.js';

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
    s.age = m.known ? ageText(m.known.age) : '';
    s.life = f ? f.pop.energy[f.i] / P.maxEnergy : 0;
    s.spirit = (p ? p.spirit : spiritMax) / spiritMax;
    s.stamina = b.stamina / STAMINA.max;
    s.tribe = tribe;
    s.yaw = b.yaw;
    s.camp = tribe ? Math.atan2(wrapDelta(tribe.camp.y - b.y, w.height), wrapDelta(tribe.camp.x - b.x, w.width)) : null;
    s.carry = f ? m.hands.carried(f) : 0;
    s.load = m.hands.load(); // (wood and flint, by the pouch)
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

// The prompt: what E would do (or is doing: context.js), and R while you
// carry food. A list of [key, what], or null.
export function promptOf(m, f) {
    if (m.resting) return [['E', 'Rise']];
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
