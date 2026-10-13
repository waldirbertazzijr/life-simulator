// The hands (package 2): attacks, eating, and what E does (context.js),
// with the poses the body shows for each.
//
// Left click attacks (input.js): a tap, a light attack (a jab if a
// creature is within reach in front, else a throw); held, a heavy throw,
// charged for up to a second (its power). Each costs stamina, and none
// goes while the spear is still coming back (the simulation's reload, as
// its report says) or from a child. The lock-on aims it: the simulation
// leads the target. The weapon in hand (kit.js) decides how: a spear
// throws or jabs, a bow shoots, a club swings. E does what the place
// offers: butcher your kill (while E is held), store what you carry or take
// food at the rack, rest in camp; outside it, chop wood in forest or knap
// flint on rock (while E is held, until the load is full), or gather on
// grass (until E again or a move). R eats from the pouch. The body shows
// each (the poses: env.pose, hold, release).
//
// `m` is modes.js's Modes: who you are, your body, the world, the page.
import { STAMINA } from './body.js';
import { POSE } from '../view3d/keyframes.js';
import { HANDS, ITEMS, AIMED, SIGHT_PX, nearestAlong, mateOf } from './aim.js';
import { GATHERS, contextAt } from './context.js';
import { contents } from './pouch.js';
import { clamp, wrapDelta } from '../view3d/util.js';

// Seconds between bites from the pouch; how long an act may go unanswered
// by the simulation before it is taken as turned down.
const EAT_EVERY = 1;
export const ACK_WAIT = 0.6;
// What the hands do while E is held (let go, they stop); gathering food
// goes on until E again.
const HELD = new Set(['butcher', 'chop', 'knap']);
const WORK_POSE = { butcher: POSE.BUTCHER, gather: POSE.GATHER, chop: POSE.CHOP, knap: POSE.KNAP };
// The pose of an attack (and of a charge, held at its wind-up) by weapon.
export const ATTACK_POSE = { spear: POSE.THROW, bow: POSE.SHOOT, club: POSE.SWING };

export class Hands {
    constructor(m) {
        this.m = m;
        this.doing = null;       // { kind: 'gather' | 'butcher' | 'chop' | 'knap', id, acked, since } while at it
        this.attacked = -1;      // when an attack went, until the simulation shows the spear gone (m.clock)
        this.ate = -Infinity;    // when you last ate (m.clock)
        this.held = 0;           // the pose held on your body (POSE), or 0
    }

    // A new world: nothing in hand.
    reset() {
        this.doing = null;
        this.held = 0; // (the new world's bodies have no poses)
        this.attacked = -1;
    }

    // What you carry: the simulation's latest word, else what is drawn.
    carried(f) {
        const p = this.m.mine();
        if (p !== null && Number.isFinite(p.carry)) return p.carry;
        return f ? f.pop.carry[f.i] : 0;
    }

    // The wood and flint you carry, and the most you can (all of it the
    // simulation's word; nothing before it has said).
    load() {
        const p = this.m.mine();
        return { wood: p?.wood ?? 0, flint: p?.flint ?? 0, max: p?.loadMax ?? this.m.world.p.items?.load ?? 0 };
    }

    // All you carry, food, wood and flint, each with the most you can
    // (pouch.js contents, for the pouch's slot and the work bar).
    contents() {
        const m = this.m;
        return contents(m.world, m.mine(), this.carried(m.self ? m.world.find(m.self) : null));
    }

    // How much of the spear's reload is still to go, 0..1: all of it from the
    // moment you attack until the simulation's report shows it (or, should
    // it not take the attack up, a moment later).
    reloading() {
        const m = this.m;
        const p = m.mine();
        if (this.attacked >= 0) {
            if ((p !== null && p.reload > 0) || m.clock - this.attacked > ACK_WAIT) this.attacked = -1;
            else return 1;
        }
        return p !== null && p.reload > 0 ? Math.min(1, p.reload / m.world.p.human.reload) : 0;
    }

    // Can you attack now? (An adult with a weapon, the spear back, some
    // stamina, the world running.)
    canAttack(f) {
        const m = this.m;
        return !!f && f.pop.age[f.i] >= m.world.p.human.maturity && this.reloading() === 0
            && m.body.stamina > 0 && !m.env.getPaused() && m.kit.weapon() !== '';
    }

    // A light attack (info.heavy false) or a heavy one of info.power. The
    // weapon in hand decides how: a spear jabs what is within reach in
    // front, else is thrown; a bow shoots; a club swings at what is near.
    attack(info = {}) {
        const m = this.m;
        const w = m.world;
        const f = w.find(m.self);
        if (!this.canAttack(f)) return false;
        const heavy = info.heavy === true;
        const kind = m.kit.weapon();
        m.body.spend(heavy ? STAMINA.heavy : STAMINA.light);
        m.standUp();
        this.stop();
        m.kit.closeCraft();
        const yaw = m.body.yaw;
        const { dx, dy, sighted } = this.sight();
        const power = heavy ? clamp(Number(info.power) || 0, 0, 1) : 0;
        const arc = w.p.play?.jabArc ?? HANDS.jabArc;
        // What it goes for (your followers too, orders.js): the locked
        // target, which the simulation leads the throw onto; else what is
        // within reach or under the aim, told but not led (no aiming for you).
        const jab = kind !== 'spear' || heavy ? 0 : this.nearest(dx, dy, w.p.play?.jabRange ?? HANDS.jabRange, arc);
        const target = m.lock || jab || (kind === 'club' ? this.nearest(dx, dy, ITEMS.swing, arc) : sighted)
            || (kind === 'club' ? 0 : this.nearest(dx, dy, w.p.play?.heavyRange ?? HANDS.heavyRange, AIMED));
        w.act({ seq: m.body.nextSeq(), action: 'attack', heavy, dx, dy, power, target, lock: m.lock !== 0 || (sighted !== 0 && target === sighted) });
        m.body.heading = yaw; // (turned to throw)
        this.attacked = m.clock;
        // A charged throw carries on from its wind-up (the hold).
        const code = jab ? POSE.JAB : ATTACK_POSE[kind] ?? POSE.THROW;
        if (this.held === code) this.held = 0;
        m.env.pose?.(m.self, code);
        return true;
    }

    // Where a shot goes (dx, dy): at whoever is drawn under the crosshair
    // (never you or a tribe-mate: `sighted`, its id, which the simulation
    // then leads the shot onto, at its middle), else at the ground there,
    // else straight along your look. (Over the shoulder the camera sits
    // beside you, so the look's own line passes beside what the crosshair
    // is on.) With a lock-on, along your look: the lock is led onto.
    sight() {
        const m = this.m;
        const w = m.world;
        const b = m.body;
        let dx = Math.cos(b.yaw);
        let dy = Math.sin(b.yaw);
        if (m.lock) return { dx, dy, sighted: 0 };
        const sighted = m.env.aimed?.(SIGHT_PX, (id) => id === m.self || mateOf(w, id, m.tribe)) ?? 0;
        const f = sighted ? w.find(sighted) : null;
        const p = f ? { x: f.pop.x[f.i], y: f.pop.y[f.i] } : m.env.crosshair?.() ?? null;
        if (p) {
            const ex = wrapDelta(p.x - b.x, w.width);
            const ey = wrapDelta(p.y - b.y, w.height);
            const d = Math.hypot(ex, ey);
            if (d > 1) {
                dx = ex / d;
                dy = ey / d;
            }
        }
        return { dx, dy, sighted: f ? sighted : 0 };
    }

    // The nearest creature from your body along (dx, dy) (aim.js), never
    // you or a tribe-mate.
    nearest(dx, dy, range, arc) {
        const m = this.m;
        return nearestAlong(m.world, m.body, dx, dy, range, arc, m.self, m.tribe);
    }

    // R: a bite from the pouch (the simulation eats up to its eatMax, never
    // past full), at most once a second.
    eat() {
        const m = this.m;
        const f = m.world.find(m.self);
        if (!f || m.clock - this.ate < EAT_EVERY) return false;
        const p = m.mine();
        const energy = p !== null && Number.isFinite(p.energy) ? p.energy : f.pop.energy[f.i];
        if (!(this.carried(f) > 0) || energy >= m.world.p.human.maxEnergy) return false;
        this.ate = m.clock;
        m.world.act({ seq: m.body.nextSeq(), action: 'eat' });
        m.env.pose?.(m.self, POSE.EAT);
        return true;
    }

    // What E would do here (context.js), or null.
    interaction() {
        const m = this.m;
        const f = m.world.find(m.self);
        if (!f) return null;
        return contextAt(m.world, { x: m.body.x, y: m.body.y, tribe: m.tribe, carry: this.carried(f), load: this.load() });
    }

    // E: stand up from resting, stop gathering, or do what the place offers.
    interact() {
        const m = this.m;
        if (m.resting) {
            m.standUp();
            return;
        }
        if (this.doing) {
            this.stop();
            return;
        }
        const what = this.interaction();
        if (!what) return;
        if (what.kind === 'butcher') this.start('butcher', what.id);
        else if (what.kind in GATHERS) this.start(what.kind, 0); // gather, chop, knap
        else if (what.kind === 'rest') m.rest();
        else if (what.kind === 'pickup') m.world.act({ seq: m.body.nextSeq(), action: 'pickup', item: what.id });
        else m.world.act({ seq: m.body.nextSeq(), action: what.kind }); // store, take
    }

    // E let go: butchering, chopping and knapping last while E is held.
    letGo() {
        if (HELD.has(this.doing?.kind)) this.stop();
    }

    // Butcher the carcass `id`, gather, chop or knap: it goes on (the body
    // kneeling to it, swinging at a tree, striking stone) until it is done,
    // stopped, or turned down (keep).
    start(kind, id) {
        const m = this.m;
        const msg = kind === 'butcher' ? { action: 'butcher', on: true, id } : { action: 'gather', on: true };
        m.world.act({ seq: m.body.nextSeq(), ...msg });
        this.doing = { kind, id, acked: false, since: m.clock };
        this.holdPose(WORK_POSE[kind]);
    }

    // Stop what the hands are at (E let go, E again, a move, an attack).
    stop() {
        const d = this.doing;
        if (!d) return;
        this.doing = null;
        this.m.world.act({ seq: this.m.body.nextSeq(), action: d.kind === 'butcher' ? 'butcher' : 'gather', on: false });
        this.releasePose();
    }

    // Put down whatever the hands were at, on the page alone (a new body, the
    // map, death: the simulation puts its own down).
    drop() {
        this.doing = null;
        this.releasePose();
        this.attacked = -1;
    }

    // Each frame: what the simulation says the hands are at (it stops them
    // itself: the carcass cut up, the patch gathered thin, the pouch full),
    // the weapon drawn back while a heavy attack charges, and the seated
    // work of crafting while it goes on.
    keep() {
        const m = this.m;
        if (this.attacked >= 0) this.reloading(); // (has the simulation taken the attack up?)
        const d = this.doing;
        if (d) {
            const p = m.mine();
            // (Gathering food: `true` from a simulation that does not say what.)
            const at = p !== null && (d.kind === 'butcher' ? p.butchering === d.id
                : p.gathering === GATHERS[d.kind] || (d.kind === 'gather' && p.gathering === true));
            if (at) d.acked = true;
            else if (d.acked || m.clock - d.since > ACK_WAIT) {
                this.doing = null;
                this.releasePose();
            }
        }
        if (this.doing) return; // (its own pose is held)
        const charge = ATTACK_POSE[m.kit.weapon()] ?? POSE.THROW;
        const charging = m.input.charging === true && this.canAttack(m.world.find(m.self));
        const want = charging ? charge : m.kit.crafting() ? POSE.CRAFT : 0;
        if (want && this.held !== want) this.holdPose(want);
        else if (!want && this.held) this.releasePose();
    }

    holdPose(code) {
        this.held = code;
        this.m.env.hold?.(this.m.self, code);
    }

    releasePose() {
        if (!this.held) return;
        this.held = 0;
        this.m.env.release?.(this.m.self);
    }
}
