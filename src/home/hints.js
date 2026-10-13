// First steps (spec §14): hints at the foot of the screen while in a body,
// as Elden Ring gives them. Each appears once, at the moment it matters,
// and fades once it is done (or after HINT.most seconds); one at a time,
// with a breath between them. Which have been seen, and whether hints are
// on at all (Settings), this browser remembers (HintStore).
//
// A hint's text marks keys in braces: "Hold {Shift} or {Space} to run"
// (hud.js draws each as a key). `when(f, h)` says it matters now and
// `done(f, h)` that it has been done, from the facts of the frame
// (factsOf: what modes.js knows) and what Hints has added up (`h`: seconds
// walked, run, the look turned, and acts seen: throw, eat, store, call).
// One done before it was ever shown is counted as seen: it was not needed.
//
// Pure, but for the storage it is given (localStorage; every access in
// try/catch: where it is refused, hints are on and nothing is remembered).
import { nightNow } from '../play/sleep.js';
import { when as calendarWhen } from '../calendar.js';
import { clockOf } from '../view3d/almanac.js';
import { wrapDelta } from '../view3d/util.js';

export const HINTS_KEY = 'life-simulator.hints';

// Seconds: the first waits for the camera to settle into the body; a
// breath between two; a hint stays this long at most.
export const HINT = { first: 1.5, gap: 2.5, most: 25 };
const PREY_NEAR = 60;  // an animal this near: the moment to throw
const NEAR_CAMP = 120; // carrying food this near camp: the moment to store it

// In order of precedence (the first that matters, not yet seen, shows).
export const HINTS = [
    {
        id: 'walk', text: '{W}{A}{S}{D} to walk · {Mouse} to look around',
        when: () => true,
        done: (f, h) => h.walked >= 2.5 && h.turned >= 0.8,
    },
    {
        id: 'sleep', text: 'Night is falling · {E} at camp to sleep until dawn',
        when: (f) => f.evening,
        done: (f) => f.asleep,
    },
    {
        id: 'run', text: 'Hold {Shift} or {Space} to run',
        when: (f) => f.moving,
        done: (f, h) => h.ran >= 1.2,
    },
    {
        id: 'gather', text: '{E} on good grass to gather food',
        when: (f) => f.can === 'gather' && !f.doing,
        done: (f) => f.doing === 'gather',
    },
    {
        id: 'throw', text: '{Left click} to throw your spear · hold it for a heavy throw',
        when: (f) => f.prey && f.armed,
        done: (f, h) => h.did.has('throw'),
    },
    {
        id: 'eat', text: '{R} to eat from your pouch',
        when: (f) => f.carry >= 1 && f.life < 0.9,
        done: (f, h) => h.did.has('eat'),
    },
    {
        id: 'store', text: "{E} at the camp's centre to store food at the rack",
        when: (f) => f.can === 'store' || (f.carry >= 5 && f.camp < NEAR_CAMP),
        done: (f, h) => h.did.has('store'),
    },
    {
        id: 'craft', text: '{C} at camp to craft',
        when: (f) => f.atCamp && f.items && !f.resting,
        done: (f) => f.crafting,
    },
    {
        id: 'call', text: '{↑} to choose a call · {G} to call your tribe',
        when: (f, h) => h.seen >= 4 && f.camp > NEAR_CAMP,
        done: (f, h) => h.did.has('call'),
    },
];

// A hint's text as parts: plain strings, and keys as { key }.
export function partsOf(text) {
    const out = [];
    for (const piece of text.split(/(\{[^}]+\})/)) {
        if (!piece) continue;
        out.push(piece.startsWith('{') ? { key: piece.slice(1, -1) } : piece);
    }
    return out;
}

// What this browser remembers: whether hints are on, and which were seen.
export class HintStore {
    constructor(storage) {
        this.storage = storage ?? null;
        this.on = true;
        this.seen = new Set();
        try {
            const kept = JSON.parse(this.storage?.getItem(HINTS_KEY) ?? 'null');
            if (kept && typeof kept === 'object') {
                this.on = kept.on !== false;
                if (Array.isArray(kept.seen)) for (const id of kept.seen) if (typeof id === 'string') this.seen.add(id);
            }
        } catch {
            // (nothing kept, or nothing readable: on, none seen)
        }
    }

    keep() {
        try {
            this.storage?.setItem(HINTS_KEY, JSON.stringify({ on: this.on, seen: [...this.seen] }));
        } catch {
            // (storage refused: for this visit only)
        }
    }

    setOn(on) {
        this.on = !!on;
        this.keep();
    }

    see(id) {
        this.seen.add(id);
        this.keep();
    }

    // Show them all again, from the first.
    again() {
        this.seen.clear();
        this.keep();
    }
}

// The facts of the frame, from modes.js's Modes `m` (in a body).
export function factsOf(m) {
    const w = m.world;
    const P = w.p.human;
    const f = m.self && !m.dying ? w.find(m.self) : null;
    const tribe = w.tribeById.get(m.tribe);
    const what = f && !m.resting ? m.hands.interaction() : null;
    const camp = tribe ? Math.hypot(wrapDelta(tribe.camp.x - m.body.x, w.width), wrapDelta(tribe.camp.y - m.body.y, w.height)) : Infinity;
    let prey = false;
    if (f) {
        for (const pop of [w.herbivores, w.carnivores]) {
            for (let i = 0; i < pop.n && !prey; i++) {
                prey = Math.hypot(wrapDelta(pop.x[i] - m.body.x, w.width), wrapDelta(pop.y[i] - m.body.y, w.height)) < PREY_NEAR;
            }
        }
    }
    const part = w.p.calendar ? calendarWhen(w.p.calendar, clockOf(w)).part : 'day';
    return {
        inBody: m.inBody && !!f && !m.over,
        moving: m.input.x !== 0 || m.input.y !== 0,
        running: m.input.sprinting === true && (m.input.x !== 0 || m.input.y !== 0) && m.body.speed > 0,
        yaw: m.body.yaw,
        can: what?.kind ?? null,
        doing: m.hands.doing?.kind ?? null,
        carry: f ? m.hands.carried(f) : 0,
        life: f ? f.pop.energy[f.i] / P.maxEnergy : 1,
        armed: !!f && f.pop.age[f.i] >= P.maturity && m.kit.weapon() !== '',
        prey,
        evening: part === 'dusk' || nightNow(w),
        asleep: m.asleep,
        resting: m.resting,
        atCamp: m.atCamp(),
        camp,
        items: w.p.items?.enabled === true,
        crafting: !!m.kit.menu,
    };
}

// The acts a hint waits for, by the events of your own person (or tribe).
const ACTS = { throw: 'throw', jab: 'throw', swing: 'throw', eat: 'eat', store: 'store' };

export class Hints {
    constructor(store) {
        this.store = store;
        this.current = null; // the hint shown, or null
        this.view = null;    // (what shown last gave)
        this.t = 0;          // seconds it has shown
        this.wait = HINT.first;
        this.inBody = false;
        this.yaw = null;
        // What has been added up (the hints' `h`).
        this.walked = 0;
        this.ran = 0;
        this.turned = 0;
        this.did = new Set();
    }

    get seen() {
        return this.store.seen.size;
    }

    // What hud.js shows: { id, parts } or null.
    get shown() {
        const h = this.current;
        if (!h) return null;
        if (this.view?.id !== h.id) this.view = { id: h.id, parts: partsOf(h.text) };
        return this.view;
    }

    // One of the frame's events (modes.js): `self`, your person; `tribe`, theirs.
    event(e, self, tribe) {
        if (ACTS[e.type] && e.id === self) this.did.add(ACTS[e.type]);
        if ((e.type === 'call' || e.type === 'rally') && e.tribe === tribe) this.did.add('call');
    }

    // Each frame in a body, with the frame's facts (factsOf).
    update(f, dt) {
        if (!f.inBody || !this.store.on) {
            if (!f.inBody) this.inBody = false;
            this.current = null;
            return;
        }
        if (!this.inBody) {
            this.inBody = true;
            this.wait = Math.max(this.wait, HINT.first);
            this.yaw = f.yaw;
        }
        if (f.moving) this.walked += dt;
        if (f.running) this.ran += dt;
        const turn = Math.abs(Math.atan2(Math.sin(f.yaw - this.yaw), Math.cos(f.yaw - this.yaw)));
        this.turned += turn;
        this.yaw = f.yaw;
        if (this.current) {
            this.t += dt;
            if (this.current.done(f, this) || this.t >= HINT.most) {
                this.current = null;
                this.wait = HINT.gap;
            }
            return;
        }
        // Done before it was needed: never needed.
        for (const hint of HINTS) if (!this.store.seen.has(hint.id) && hint.done(f, this)) this.store.see(hint.id);
        this.wait -= dt;
        if (this.wait > 0) return;
        for (const hint of HINTS) {
            if (this.store.seen.has(hint.id) || !hint.when(f, this)) continue;
            this.current = hint;
            this.t = 0;
            this.store.see(hint.id);
            return;
        }
    }
}
