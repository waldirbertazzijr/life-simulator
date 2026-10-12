// Who you are, and where: the two ways to play (spec §4), stepping into a
// body and out to the map, resting at camp, deaths and heirs, the end of a
// line, and lock-on.
//
//   God  (the default) — a sandbox: become anyone, any time; when you die
//        you carry on as your heir, and with nobody left you are back on
//        the map.
//   Play — you lead one tribe: you begin as its most experienced adult, you
//        can only become its people, and when your line and your tribe are
//        gone the game is over and its story is told.
//
// In a body the world runs at 1× (16× while you rest at camp), the panel
// hides and the HUD shows. M rises to the map: your person stays yours but
// goes on autopilot (act 'auto'), so the AI walks it as anyone, at any
// speed, and it is drawn where the simulation has it; M again (or Return)
// steps back in, where the simulation then has it (`snap`). Only quitting
// (stop) lets go of it: control 0.
//
// The messages (sim.js, player.js): `control` takes someone over and starts
// the numbering of inputs and acts afresh; when `player.id` changes, the
// body starts where the snapshot has that person.
//
// Deaths. The simulation, once it has the person (it says so in `player`),
// chooses the heir itself, in the body or on autopilot, and says so
// (`heir`, `released`, `over` events). Before it has said so (or with a
// simulation that does not take control), the page chooses by the same
// rule: a living descendant (a child if possible), else the eldest adult of
// the tribe, else its eldest child. Either way YOU DIED shows first, for
// DEATH_SECONDS.
//
// The hands (package 2, at the end): attacks, butchering, gathering, eating
// and the store, and the poses they show.
//
// `env` is how this reaches the rest of the page (main.js): the world (the
// Mirror), the input, the HUD, the camera rig, follow, the view, the speed,
// pause, the panel (inBody, openPicker, changed), and the bodies' poses
// (pose, hold, release: the 3D view's).
import { Body, STAMINA } from './body.js';
import { personName, ageText, relation, YEAR } from './names.js';
import { POSE } from '../view3d/animate.js';
import { Calls, noticeFor, placed } from './calls.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
export const DEATH_SECONDS = 3.5;
const REST_SPEED = 16;
const MAP_CLOSE = 260;     // rising to the map: at most this far above your person
const LOOK_RATE = 0.0024;  // radians per pixel of mouse movement
// How far the look tilts (positive looks down), and where it starts.
const PITCH = { shoulder: [-35 * DEG, 60 * DEG], first: [-60 * DEG, 70 * DEG] };
const START_PITCH = { shoulder: 9 * DEG, first: 4 * DEG };
// Lock-on (Q): the nearest creature within `range` and `cone` of the look;
// it is let go beyond `keep`. The view turns to it in about `ease` seconds.
export const LOCK = { range: 60, cone: 35 * DEG, keep: 90, ease: 0.25 };
// Heights, for aiming at things: the eyes, how much higher the shoulder
// camera's focus is, and the middle of each kind of body (creatures.js).
const EYE = 4.1;
const SHOULDER_UP = 0.7;
const CENTER = { herbivore: 2.0, carnivore: 1.7, human: 2.4 };
// The hands: seconds between bites from the pouch; how long an act may go
// unanswered by the simulation before it is taken as turned down; and the
// simulation's reaches (params.play), should a world not have them.
const EAT_EVERY = 1;
const ACK_WAIT = 0.6;
const HANDS = { jabRange: 5, jabArc: Math.PI / 4, heavyRange: 34, butcherReach: 4, rackReach: 8, takeMax: 40 };
const AIMED = 12 * DEG; // a creature this near the aim is what an attack goes for

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
const angleDelta = (a) => {
    a %= TAU;
    return a > Math.PI ? a - TAU : a <= -Math.PI ? a + TAU : a;
};

// The tribe's most experienced adult: most kills, ties going to the eldest.
// 0 if it has no adults.
export function mostExperienced(world, tribeId) {
    const pop = world.humans;
    const adult = world.p.human.maturity;
    let best = -1;
    for (let i = 0; i < pop.n; i++) {
        if (pop.tribe[i] !== tribeId || pop.age[i] < adult) continue;
        if (best < 0 || pop.kills[i] > pop.kills[best] || (pop.kills[i] === pop.kills[best] && pop.age[i] > pop.age[best])) best = i;
    }
    return best >= 0 ? pop.id[best] : 0;
}

// The tribe's eldest adult, else its eldest child (not `except`); 0 if none.
export function eldestOf(world, tribeId, except = 0) {
    const pop = world.humans;
    const adult = world.p.human.maturity;
    let best = -1;
    for (let i = 0; i < pop.n; i++) {
        if (pop.tribe[i] !== tribeId || pop.id[i] === except) continue;
        const grown = pop.age[i] >= adult;
        const bestGrown = best >= 0 && pop.age[best] >= adult;
        if (best < 0 || (grown && !bestGrown) || (grown === bestGrown && pop.age[i] > pop.age[best])) best = i;
    }
    return best >= 0 ? pop.id[best] : 0;
}

// Who carries on after `dead` ({ id, tribe, generation }): { id, gap }, gap
// being how many generations below the dead the heir is (0: not of its
// line), or null when nobody is left.
export function pickHeir(world, dead) {
    const d = world.descendant(dead.id);
    const found = d ? world.find(d) : null;
    if (found) return { id: d, gap: found.pop.generation[found.i] - dead.generation };
    const e = eldestOf(world, dead.tribe, dead.id);
    return e ? { id: e, gap: 0 } : null;
}

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

const freshStory = () => ({ played: new Map() });

export class Modes {
    constructor(env) {
        this.env = env;
        this.world = env.world;
        this.input = env.input;
        this.hud = env.hud;
        this.body = new Body();
        this.game = 'god';
        this.self = 0;           // the person you play (on the map too), or 0
        this.tribe = 0;          // their tribe: yours
        this.known = null;       // the latest facts about them, kept for when they die
        this.inBody = false;
        this.view = 'shoulder';  // the body's camera: 'shoulder' or 'first' (V)
        this.mapSpeed = env.getSpeed();
        this.resting = false;
        this.restAcked = false;  // the simulation has said we sit (so its "not resting" counts)
        this.acked = false;      // the simulation has said it controls `self`
        this.seenId = 0;         // the person the latest `player` was about
        this.dying = null;       // { t, dead, outcome } while YOU DIED shows
        this.over = false;       // a Play game has ended; the story is shown
        this.lock = 0;           // the creature locked on to
        this.story = freshStory();
        this.aim = { yaw: 0, pitch: 0, crouch: false };      // for the camera (camera.js)
        this.pose = { id: 0, x: 0, y: 0, heading: 0 };      // for the Mirror
        this.bodyEnv = {
            terrain: null, W: 1, H: 1, top: 0, cruise: 0, crouchSpeed: 0, rollSpeed: 0, rollSteps: 0,
            paused: false, still: false, face: 'move',
        };
        this.hudState = {};
        this.point = { x: 0, y: 0 };
        // For checking (window.play.state): moves the simulation turned down
        // (each one a jump back), and the person's own reports placing the body.
        this.stats = { snaps: 0, placed: 0 };
        // The hands (see the end).
        this.clock = 0;          // seconds in a body, for the hands' waits
        this.doing = null;       // { kind: 'gather' | 'butcher', id, acked, since } while at it
        this.attacked = -1;      // when an attack went, until the simulation shows the spear gone (clock)
        this.ate = -Infinity;    // when you last ate (clock)
        this.held = 0;           // the pose held on your body (POSE), or 0
        this.calls = new Calls(); // leading your tribe (calls.js)
        this.input.onAction = (name, info) => this.action(name, info);
    }

    // ---- Who ----

    // Can the card offer "Become them" for this id?
    canBecome(id) {
        if (this.dying || this.over || !id || id === this.self) return false;
        const f = this.world.find(id);
        if (!f || f.kind !== 'human') return false;
        return this.game !== 'play' || !this.self || f.pop.tribe[f.i] === this.tribe;
    }

    // Step into person `id` (in Play, only one of your tribe's).
    become(id) {
        if (!this.canBecome(id)) return false;
        this.takeOver(id);
        return this.enter(true);
    }

    // Play: lead this tribe, as its most experienced adult.
    startPlay(tribeId) {
        if (this.dying) return false;
        const id = mostExperienced(this.world, tribeId) || eldestOf(this.world, tribeId);
        if (!id) return false;
        this.over = false;
        this.hud.hideSummary();
        this.story = freshStory();
        this.game = 'play';
        this.takeOver(id);
        return this.enter(true);
    }

    // `id` is yours from now on (the simulation is told on entering).
    takeOver(id) {
        this.standUp();
        this.dropHands();
        this.self = id;
        this.acked = false;
        this.lock = 0;
        const f = this.world.find(id);
        if (f) {
            this.tribe = f.pop.tribe[f.i];
            this.record(f);
        }
        this.env.changed();
    }

    // Tell the simulation: `id` is controlled now (inputs and acts are
    // numbered afresh).
    control(id) {
        this.world.control(id, this.game);
        this.body.seq = 0;
        this.acked = false;
    }

    // Into your person's body: a new one (`fresh`), or back from the map,
    // where the simulation has had it on autopilot.
    enter(fresh) {
        const w = this.world;
        const f = w.find(this.self);
        if (!f) return false;
        if (!this.inBody) this.mapSpeed = this.env.getSpeed();
        if (fresh || !this.acked) this.control(this.self);
        else {
            // Off autopilot: the simulation answers with a snap, and numbers
            // inputs afresh.
            w.act({ seq: this.body.nextSeq(), action: 'auto', on: false });
            this.body.seq = 0;
        }
        this.env.follow(this.self);
        this.inBody = true;
        this.calls.disarm();
        this.place(f);
        this.env.setSpeed(1);
        this.env.setView(this.view);
        this.input.setMode('body');
        this.env.inBody(true);
        this.hud.show(true);
        this.env.changed();
        return true;
    }

    // Stand the body where the simulation last had the person (or, until it
    // reports on it, where it is drawn), looking the way it faces.
    place(f) {
        const { pop, i } = f;
        const p = this.world.player;
        if (p && p.id === pop.id[i]) this.body.reset(p.x, p.y, Number.isFinite(p.heading) ? p.heading : pop.heading[i]);
        else this.body.reset(pop.x[i], pop.y[i], pop.heading[i]);
        this.body.pitch = START_PITCH[this.view];
        this.world.pose = null;
        this.world.snapped = false;
    }

    // Up to the map: your person walks on under the AI (autopilot), seen
    // from close enough to watch it.
    leave() {
        if (!this.inBody) return;
        this.standUp();
        this.world.act({ seq: this.body.nextSeq(), action: 'auto', on: true });
        this.exitBody();
        this.env.rig()?.closeIn?.(MAP_CLOSE);
    }

    // Out of the body, on the page: the map, its speed, the panel.
    exitBody() {
        this.inBody = false;
        this.seenId = 0; // (coming back, the simulation's report places the body afresh)
        this.dropHands(); // (on autopilot the simulation puts them down too)
        this.lock = 0;
        this.world.pose = null;
        this.env.setSpeed(this.mapSpeed);
        this.env.setView('map');
        this.input.setMode(this.self ? 'map' : 'off');
        this.env.inBody(false);
        this.hud.show(false);
        const rig = this.env.rig();
        if (rig) rig.aim = null;
        this.env.changed();
    }

    // Back into your person (M on the map, or Return).
    back() {
        if (this.inBody || !this.self || this.dying || this.over) return false;
        return this.enter(false);
    }

    // Let go of everyone: God mode, watching.
    stop() {
        if (this.inBody) {
            this.standUp();
            this.exitBody();
        }
        if (this.self) this.world.control(0, this.game);
        this.acked = false;
        this.self = 0;
        this.known = null;
        this.game = 'god';
        this.calls.disarm();
        this.input.setMode('off');
        this.env.changed();
    }

    // A new world: nobody is played any more (the simulation's new world has
    // no player either).
    reset() {
        if (this.inBody) this.env.setSpeed(this.mapSpeed);
        this.inBody = false;
        this.doing = null;
        this.held = 0; // (the new world's bodies have no poses)
        this.attacked = -1;
        this.self = 0;
        this.known = null;
        this.tribe = 0;
        this.game = 'god';
        this.resting = false;
        this.dying = null;
        this.over = false;
        this.lock = 0;
        this.acked = false;
        this.seenId = 0;
        this.story = freshStory();
        this.calls.reset();
        this.world.pose = null;
        this.input.setMode('off');
        this.env.inBody(false);
        this.hud.clear();
        this.hud.show(false);
        const rig = this.env.rig();
        if (rig) rig.aim = null;
        this.env.changed();
    }

    // ---- Resting at camp ----

    atCamp() {
        const w = this.world;
        const t = w.tribeById.get(this.tribe);
        if (!t) return false;
        const dx = wrapDelta(t.camp.x - this.body.x, w.width);
        const dy = wrapDelta(t.camp.y - this.body.y, w.height);
        return dx * dx + dy * dy < w.p.human.campRadius ** 2;
    }

    rest() {
        this.resting = true;
        this.restAcked = false;
        this.world.act({ seq: this.body.nextSeq(), action: 'rest', on: true });
        this.env.setSpeed(REST_SPEED);
    }

    standUp() {
        if (!this.resting) return;
        this.resting = false;
        this.world.act({ seq: this.body.nextSeq(), action: 'rest', on: false });
        if (this.inBody) this.env.setSpeed(1);
    }

    // ---- What the keys do (input.js names them) ----

    action(name, info) {
        if (name === 'map') {
            if (this.inBody) this.leave();
            else this.back();
            return;
        }
        if (name === 'call' && !this.inBody) {
            this.armCall(); // G on the map
            return;
        }
        if (!this.inBody || this.dying) return;
        switch (name) {
            case 'move':
                this.standUp();
                this.stopHands();
                break;
            case 'roll': {
                this.standUp();
                this.stopHands();
                const f = this.world.find(this.self);
                if (f && this.body.roll(this.input, this.envFor(f))) this.world.act({ seq: this.body.nextSeq(), action: 'roll' });
                break;
            }
            case 'crouch':
                this.standUp();
                this.body.crouch = !this.body.crouch;
                break;
            case 'interact':
                this.interact();
                break;
            case 'interact-end':
                if (this.doing?.kind === 'butcher') this.stopHands(); // (butchering lasts while E is held)
                break;
            case 'attack':
                this.attack(info);
                break;
            case 'eat':
                this.eat();
                break;
            case 'lock':
                this.lock = this.lock ? 0 : lockTarget(this.world, this.body.x, this.body.y, this.body.yaw, this.self);
                break;
            case 'view':
                this.view = this.view === 'shoulder' ? 'first' : 'shoulder';
                this.body.pitch = clamp(this.body.pitch, ...PITCH[this.view]);
                this.env.setView(this.view);
                break;
            case 'pause':
                this.env.setPaused(!this.env.getPaused());
                break;
            case 'cycle-call':
                this.calls.cycle();
                break;
            case 'call':
                this.callHere();
                break;
            default:
                // craft, the other arrows, tool, art: later packages.
                break;
        }
    }

    // ---- Leading your tribe (calls.js; the simulation's side is orders.js) ----

    // G in a body: the call in the slot, at the ground under the crosshair
    // (where you stand, looking at the sky); a rally, around you.
    callHere() {
        const kind = this.calls.call.kind;
        const at = kind === 'rally' ? null : this.env.crosshair?.() ?? null;
        this.world.act({ seq: this.body.nextSeq(), action: 'call', kind, x: at ? at.x : this.body.x, y: at ? at.y : this.body.y });
    }

    // On the map: ready a call (by default the slot's) to be given where you
    // click next; asked for again, let it go. One about the camp (Gather
    // food, Defend camp) is given at once.
    armCall(kind) {
        if (this.inBody || !this.self || this.dying || this.over) return;
        if (this.calls.armed && (kind === undefined || kind === this.calls.armed)) this.calls.disarm();
        else {
            this.calls.arm(kind);
            const camp = this.world.tribeById.get(this.tribe)?.camp;
            if (!placed(this.calls.armed) && camp) this.callAt(camp.x, camp.y);
        }
        this.env.changed();
    }

    // A click on the map at (x, y), with a call armed: it is given there,
    // once. False if no call was armed (the click is the map's).
    callAt(x, y) {
        const kind = this.calls.armed;
        if (!kind || this.inBody || !this.self) return false;
        this.calls.disarm();
        this.world.act({ seq: this.body.nextSeq(), action: 'call', kind, x, y });
        this.env.changed();
        return true;
    }

    // The tribe's answer to a call ('call', 'refused', 'rally' events), if
    // it is yours: a notice.
    answered(e) {
        if (this.self && e.tribe === this.tribe) this.hud.notice?.(noticeFor(e), e.type === 'refused');
    }

    // ---- Each frame ----

    // The body's surroundings for body.js: the land, its speeds, and which
    // way it should face.
    envFor(f) {
        const w = this.world;
        const P = w.p.human;
        const Q = w.p.play ?? {};
        const e = this.bodyEnv;
        e.terrain = w.terrain;
        e.W = w.width;
        e.H = w.height;
        e.top = P.speed * f.pop.speedGene[f.i];
        e.cruise = P.cruise;
        e.crouchSpeed = Q.crouchSpeed ?? 0.35;
        e.rollSpeed = Q.rollSpeed ?? 1.2;
        e.rollSteps = Q.rollSteps ?? 5;
        e.paused = this.env.getPaused();
        e.still = this.resting;
        const target = this.lock ? w.find(this.lock) : null;
        e.face = this.view === 'first' ? 'look'
            : target ? Math.atan2(wrapDelta(target.pop.y[target.i] - this.body.y, w.height), wrapDelta(target.pop.x[target.i] - this.body.x, w.width))
            : 'move';
        return e;
    }

    // Before the Mirror's update: look, move the body, tell the simulation.
    move(dt) {
        if (!this.inBody) return;
        const look = this.input.takeLook();
        if (this.dying) return;
        const w = this.world;
        const body = this.body;
        body.yaw = angleDelta(body.yaw + look.dx * LOOK_RATE);
        body.pitch = clamp(body.pitch + look.dy * LOOK_RATE, ...PITCH[this.view]);
        // Until the simulation says it has this body, steered by hand (not on
        // autopilot), the page has nothing to tell it: where the page draws
        // a person is a moment behind the simulation, several steps at
        // speed, and a move from there would be turned down. The first such
        // report places the body (it may carry the snap of an heir or of
        // autopilot's end: that is this placing). After that, a snap means a
        // move was turned down.
        const p = w.player;
        const mine = p !== null && p.id !== 0 && p.id === this.self && !p.auto;
        const seen = mine ? p.id : 0;
        if (seen !== this.seenId) {
            this.seenId = seen;
            if (mine) {
                body.snap(p.x, p.y);
                if (Number.isFinite(p.heading)) body.heading = p.heading;
                w.snapped = false;
                this.stats.placed++;
            }
        }
        if (w.snapped) {
            w.snapped = false;
            if (mine) {
                body.snap(p.x, p.y);
                this.stats.snaps++;
            }
        }
        const f = w.find(this.self);
        if (!f) return;
        const env = this.envFor(f);
        body.update(dt, this.input, env);
        const pose = this.pose;
        pose.id = this.self;
        pose.x = body.x;
        pose.y = body.y;
        pose.heading = body.heading;
        w.pose = pose;
        if (env.paused || !mine) return;
        const msg = body.message();
        if (msg) w.input(msg);
    }

    // After the Mirror's update: what the simulation says, what happened,
    // the banners' timing, lock-on, and the camera's aim.
    after(dt) {
        const w = this.world;
        const p = w.player;
        if (p && this.self && p.id === this.self) {
            this.acked = true;
            if (this.resting) {
                if (p.resting) this.restAcked = true;
                else if (this.restAcked) this.standUp(); // (it stood us up: a bite)
            }
        }
        for (const e of w.events) this.event(e);
        if (this.dying) {
            this.dying.t -= dt;
            if (this.dying.t <= 0) this.carryOn();
        }
        if (this.inBody && !this.dying) {
            this.clock += dt;
            this.keepHands();
        }
        const f = this.self && !this.dying ? w.find(this.self) : null;
        if (f) {
            this.tribe = f.pop.tribe[f.i];
            this.record(f);
        }
        this.keepLock(dt);
        const rig = this.env.rig();
        if (rig) {
            if (this.inBody) {
                this.aim.yaw = this.body.yaw;
                this.aim.pitch = this.body.pitch;
                this.aim.crouch = this.body.crouch;
                rig.aim = this.aim;
            } else rig.aim = null;
        }
    }

    event(e) {
        switch (e.type) {
            case 'bite':
                if (e.id !== this.self || !this.self) break;
                this.hud.flash();
                this.standUp();
                break;
            case 'death':
                if (e.kind === 'human' && e.id === this.self && this.self && !this.dying) this.died();
                break;
            case 'heir':
                if (this.dying && e.from === this.dying.dead.id) this.dying.outcome = { kind: 'heir', id: e.to, gap: null, told: true, parent: e.parent ?? 0 };
                break;
            case 'released':
                if (this.dying) this.dying.outcome = { kind: 'none' };
                break;
            case 'over':
                if (this.dying) this.dying.outcome = { kind: 'over' };
                break;
            case 'call':
            case 'refused':
            case 'rally':
                this.answered(e);
                break;
        }
    }

    // Your person has died: YOU DIED, and then (carryOn) whoever is next.
    died() {
        const k = this.known;
        this.dying = {
            t: DEATH_SECONDS,
            dead: { id: this.self, tribe: k ? k.tribe : this.tribe, generation: k ? k.generation : 0 },
            outcome: null,
        };
        this.standUp();
        this.dropHands();
        this.lock = 0;
        this.world.pose = null;
        this.input.clear();
        this.hud.banner('died');
    }

    carryOn() {
        const { dead, outcome } = this.dying;
        this.dying = null;
        let next = outcome;
        if (next?.kind === 'heir' && !this.world.find(next.id)) next = null; // (gone already)
        if (!next) {
            // The simulation did not say (it does not have the person, or not
            // yet): choose here.
            const h = pickHeir(this.world, dead);
            next = h ? { kind: 'heir', id: h.id, gap: h.gap, told: false, parent: 0 }
                : { kind: this.game === 'play' ? 'over' : 'none' };
        }
        if (next.kind === 'heir') this.handOff(dead, next);
        else if (next.kind === 'over') this.gameOver();
        else this.stop();
    }

    handOff(dead, next) {
        const f = this.world.find(next.id);
        const followed = this.env.followed();
        this.takeOver(next.id);
        this.hud.banner('line', this.lineText(dead, next, f));
        if (next.told) {
            // The simulation has the heir already (numbering afresh).
            this.acked = true;
            this.body.seq = 0;
        } else if (this.inBody) {
            this.control(next.id);
        } // (on the map, the heir is taken over on returning to it: back)
        if (this.inBody) {
            this.env.follow(next.id);
            this.place(f);
            this.env.setView(this.view);
        } else if (followed === dead.id) {
            this.env.follow(next.id, true);
        }
    }

    // "Your line continues — Tiko, child of Ana."
    lineText(dead, next, f) {
        const name = personName(next.id);
        if (next.parent) return `Your line continues — ${name}, child of ${personName(next.parent)}`;
        const of = next.gap > 0 ? relation(next.gap) : null;
        if (of) return `Your line continues — ${name}, ${of} of ${personName(dead.id)}`;
        const tribe = this.world.tribeById.get(f.pop.tribe[f.i]);
        return tribe ? `Your line continues — ${name} of the ${tribe.name}` : `Your line continues — ${name}`;
    }

    // Play: the line and the tribe are gone.
    gameOver() {
        if (this.inBody) this.exitBody();
        this.self = 0;
        this.known = null;
        this.over = true;
        this.calls.disarm();
        this.input.setMode('off');
        this.hud.banner('ended');
        this.hud.summary(this.numbers(), {
            again: () => this.closeStory(true),
            watch: () => this.closeStory(false),
        });
        this.env.changed();
    }

    closeStory(again) {
        this.over = false;
        this.game = 'god';
        this.hud.hideSummary();
        this.env.changed();
        if (again) this.env.openPicker();
    }

    // The latest about your person (kept for when it dies, and for the story).
    record(f) {
        const { pop, i } = f;
        const id = pop.id[i];
        let r = this.story.played.get(id);
        if (!r) {
            r = { id };
            this.story.played.set(id, r);
        }
        r.tribe = pop.tribe[i];
        r.generation = pop.generation[i];
        r.kills = pop.kills[i];
        r.children = pop.children[i];
        r.age = pop.age[i];
        this.known = r;
    }

    // The story of your line: people played, generations, years lived (all
    // their lives), kills and children; and their names, in order.
    numbers() {
        const rs = [...this.story.played.values()];
        const gens = rs.map((r) => r.generation);
        const sum = (k) => rs.reduce((s, r) => s + r[k], 0);
        return {
            people: rs.length,
            generations: rs.length ? Math.max(...gens) - Math.min(...gens) + 1 : 0,
            years: Math.floor(sum('age') / YEAR),
            kills: sum('kills'),
            children: sum('children'),
            line: rs.map((r) => personName(r.id)),
        };
    }

    // Keep the lock on while the target lives and is near; turn the look
    // toward it.
    keepLock(dt) {
        if (!this.lock) return;
        const w = this.world;
        const t = this.inBody ? w.find(this.lock) : null;
        const b = this.body;
        if (!t) {
            this.lock = 0;
            return;
        }
        const dx = wrapDelta(t.pop.x[t.i] - b.x, w.width);
        const dy = wrapDelta(t.pop.y[t.i] - b.y, w.height);
        const d = Math.hypot(dx, dy);
        if (d > LOCK.keep) {
            this.lock = 0;
            return;
        }
        const k = 1 - Math.exp(-dt / LOCK.ease);
        b.yaw = angleDelta(b.yaw + angleDelta(Math.atan2(dy, dx) - b.yaw) * k);
        const ground = (x, y) => (w.terrain ? w.terrain.heightAt(x, y) : 0);
        const eye = ground(b.x, b.y) + EYE + (this.view === 'shoulder' ? SHOULDER_UP : 0);
        const at = ground(t.pop.x[t.i], t.pop.y[t.i]) + CENTER[t.kind];
        const want = clamp(Math.atan2(eye - at, Math.max(d, 1)), ...PITCH[this.view]);
        b.pitch += (want - b.pitch) * k;
    }

    // ---- The HUD (after the camera has moved) ----

    drawHud(dt) {
        if (!this.inBody) return;
        const w = this.world;
        const P = w.p.human;
        const b = this.body;
        const f = this.self && !this.dying ? w.find(this.self) : null;
        const tribe = w.tribeById.get(this.tribe) ?? null;
        const p = w.player && w.player.id === this.self ? w.player : null;
        const spiritMax = w.p.play?.spiritMax ?? 100;
        const paused = this.env.getPaused();
        const s = this.hudState;
        const id = this.dying ? this.dying.dead.id : this.self;
        s.name = personName(id);
        s.age = this.known ? ageText(this.known.age) : '';
        s.life = f ? f.pop.energy[f.i] / P.maxEnergy : 0;
        s.spirit = (p ? p.spirit : spiritMax) / spiritMax;
        s.stamina = b.stamina / STAMINA.max;
        s.tribe = tribe;
        s.yaw = b.yaw;
        s.camp = tribe ? Math.atan2(wrapDelta(tribe.camp.y - b.y, w.height), wrapDelta(tribe.camp.x - b.x, w.width)) : null;
        s.carry = f ? this.carried(f) : 0;
        s.store = tribe ? tribe.store : 0;
        s.prompt = this.dying ? null : paused ? [['P', 'Resume']] : this.prompt(f);
        s.reload = f ? this.reloading() : 0;
        s.charge = this.input.charging === true ? this.input.charge : 0;
        s.crouch = b.crouch;
        // Your call, and your tribe's standing order on the compass (calls.js).
        s.call = this.calls.call;
        const order = tribe?.order ?? null;
        s.order = order ? Math.atan2(wrapDelta(order.y - b.y, w.height), wrapDelta(order.x - b.x, w.width)) : null;
        s.ring = null;
        s.target = null;
        const t = this.lock ? w.find(this.lock) : null;
        if (t) {
            const tx = t.pop.x[t.i];
            const ty = t.pop.y[t.i];
            s.target = Math.atan2(wrapDelta(ty - b.y, w.height), wrapDelta(tx - b.x, w.width));
            const rig = this.env.rig();
            const h = (w.terrain ? w.terrain.heightAt(tx, ty) : 0) + CENTER[t.kind];
            if (rig && rig.project(tx, ty, h, this.point)) s.ring = this.point;
        }
        this.hud.update(s, dt);
    }

    // ---- The hands (package 2) ----
    //
    // Left click attacks (input.js): a tap, a light attack (a jab if a
    // creature is within reach in front, else a throw); held, a heavy throw,
    // charged for up to a second (its power). Each costs stamina, and none
    // goes while the spear is still coming back (the simulation's reload, as
    // its report says) or from a child. The lock-on aims it: the simulation
    // leads the target. E does what the place offers (interaction): butcher
    // your kill (while E is held), store what you carry or take food at the
    // rack, rest in camp, gather on grass outside it (until E again or a
    // move). R eats from the pouch. The body shows each (the poses: env.pose,
    // hold, release).

    // The simulation's report on your body, if it has it by hand; or null.
    mine() {
        const p = this.world.player;
        return p !== null && p.id !== 0 && p.id === this.self && !p.auto ? p : null;
    }

    // What you carry: the simulation's latest word, else what is drawn.
    carried(f) {
        const p = this.mine();
        if (p !== null && Number.isFinite(p.carry)) return p.carry;
        return f ? f.pop.carry[f.i] : 0;
    }

    // How much of the spear's reload is still to go, 0..1: all of it from the
    // moment you attack until the simulation's report shows it (or, should
    // it not take the attack up, a moment later).
    reloading() {
        const p = this.mine();
        if (this.attacked >= 0) {
            if ((p !== null && p.reload > 0) || this.clock - this.attacked > ACK_WAIT) this.attacked = -1;
            else return 1;
        }
        return p !== null && p.reload > 0 ? Math.min(1, p.reload / this.world.p.human.reload) : 0;
    }

    // Can you attack now? (An adult, the spear back, some stamina, the world running.)
    canAttack(f) {
        return !!f && f.pop.age[f.i] >= this.world.p.human.maturity && this.reloading() === 0
            && this.body.stamina > 0 && !this.env.getPaused();
    }

    // A light attack (info.heavy false) or a heavy one of info.power.
    attack(info = {}) {
        const w = this.world;
        const f = w.find(this.self);
        if (!this.canAttack(f)) return false;
        const heavy = info.heavy === true;
        this.body.spend(heavy ? STAMINA.heavy : STAMINA.light);
        this.standUp();
        this.stopHands();
        const yaw = this.body.yaw;
        const dx = Math.cos(yaw);
        const dy = Math.sin(yaw);
        const power = heavy ? clamp(Number(info.power) || 0, 0, 1) : 0;
        // What it goes for (your followers too, orders.js): the locked
        // target, which the simulation leads the throw onto; else what is
        // within reach or under the aim, told but not led (no aiming for you).
        const jab = heavy ? 0 : this.nearestAlong(dx, dy, w.p.play?.jabRange ?? HANDS.jabRange, w.p.play?.jabArc ?? HANDS.jabArc);
        const target = this.lock || jab || this.nearestAlong(dx, dy, w.p.play?.heavyRange ?? HANDS.heavyRange, AIMED);
        w.act({ seq: this.body.nextSeq(), action: 'attack', heavy, dx, dy, power, target, lock: this.lock !== 0 });
        this.body.heading = yaw; // (turned to throw)
        this.attacked = this.clock;
        // A charged throw carries on from its wind-up (the hold).
        if (this.held === POSE.THROW) this.held = 0;
        this.env.pose?.(this.self, jab ? POSE.JAB : POSE.THROW);
        return true;
    }

    // The nearest creature (never yourself or a tribe-mate) within `range`
    // and `arc` (radians, either way) of (dx, dy), as drawn: its id, or 0.
    // Within the jab's reach and arc, it is what the simulation jabs.
    nearestAlong(dx, dy, range, arc) {
        const w = this.world;
        const cone = Math.cos(arc);
        const b = this.body;
        let best = 0;
        let bestD = range;
        for (const pop of [w.herbivores, w.carnivores, w.humans]) {
            for (let i = 0; i < pop.n; i++) {
                if (pop.id[i] === this.self || (pop === w.humans && pop.tribe[i] === this.tribe)) continue;
                const ex = wrapDelta(pop.x[i] - b.x, w.width);
                const ey = wrapDelta(pop.y[i] - b.y, w.height);
                const d = Math.hypot(ex, ey);
                if (d > bestD || (d > 1e-9 && ex * dx + ey * dy < d * cone)) continue;
                best = pop.id[i];
                bestD = d;
            }
        }
        return best;
    }

    // R: a bite from the pouch (the simulation eats up to its eatMax, never
    // past full), at most once a second.
    eat() {
        const f = this.world.find(this.self);
        if (!f || this.clock - this.ate < EAT_EVERY) return false;
        const p = this.mine();
        const energy = p !== null && Number.isFinite(p.energy) ? p.energy : f.pop.energy[f.i];
        if (!(this.carried(f) > 0) || energy >= this.world.p.human.maxEnergy) return false;
        this.ate = this.clock;
        this.world.act({ seq: this.body.nextSeq(), action: 'eat' });
        this.env.pose?.(this.self, POSE.EAT);
        return true;
    }

    // What E would do here, in this order: butcher a kill of yours within
    // reach; at the rack (by the camp's centre), store what you carry, or
    // with empty hands take food for the road; in camp, rest; outside it, on
    // grass worth it, gather. { kind, id?, amount? }, or null.
    interaction() {
        const w = this.world;
        const f = w.find(this.self);
        if (!f) return null;
        const P = w.p.human;
        const Q = w.p.play ?? HANDS;
        const b = this.body;
        let best = null;
        let bestD = Q.butcherReach ?? HANDS.butcherReach;
        for (const c of w.carcasses ?? []) {
            const d = Math.hypot(wrapDelta(c.x - b.x, w.width), wrapDelta(c.y - b.y, w.height));
            if (d <= bestD) {
                best = c;
                bestD = d;
            }
        }
        if (best) return { kind: 'butcher', id: best.id };
        const carry = this.carried(f);
        const t = w.tribeById.get(this.tribe);
        if (t) {
            const d2 = wrapDelta(t.camp.x - b.x, w.width) ** 2 + wrapDelta(t.camp.y - b.y, w.height) ** 2;
            if (d2 <= (Q.rackReach ?? HANDS.rackReach) ** 2) {
                if (carry >= 1) return { kind: 'store', amount: Math.floor(carry) };
                const amount = Math.floor(Math.min(Q.takeMax ?? HANDS.takeMax, t.store, P.carryMax - carry));
                if (amount >= 1) return { kind: 'take', amount };
            }
            if (d2 < P.campRadius * P.campRadius) return { kind: 'rest' };
        }
        const g = w.grass;
        if (g && g.g[g.index(b.x, b.y)] >= P.gatherMin && carry < P.carryMax) return { kind: 'gather' };
        return null;
    }

    // E: stand up from resting, stop gathering, or do what the place offers.
    interact() {
        if (this.resting) {
            this.standUp();
            return;
        }
        if (this.doing) {
            this.stopHands();
            return;
        }
        const what = this.interaction();
        if (!what) return;
        if (what.kind === 'butcher') this.startHands('butcher', what.id);
        else if (what.kind === 'gather') this.startHands('gather', 0);
        else if (what.kind === 'rest') this.rest();
        else this.world.act({ seq: this.body.nextSeq(), action: what.kind }); // store, take
    }

    // Butcher the carcass `id`, or gather: it goes on (the body kneeling to
    // it) until it is done, stopped, or turned down (keepHands).
    startHands(kind, id) {
        const msg = kind === 'butcher' ? { action: 'butcher', on: true, id } : { action: 'gather', on: true };
        this.world.act({ seq: this.body.nextSeq(), ...msg });
        this.doing = { kind, id, acked: false, since: this.clock };
        this.holdPose(kind === 'butcher' ? POSE.BUTCHER : POSE.GATHER);
    }

    // Stop what the hands are at (E let go, E again, a move, an attack).
    stopHands() {
        const d = this.doing;
        if (!d) return;
        this.doing = null;
        this.world.act({ seq: this.body.nextSeq(), action: d.kind, on: false });
        this.releasePose();
    }

    // Put down whatever the hands were at, on the page alone (a new body, the
    // map, death: the simulation puts its own down).
    dropHands() {
        this.doing = null;
        this.releasePose();
        this.attacked = -1;
    }

    // Each frame: what the simulation says the hands are at (it stops them
    // itself: the carcass cut up, the patch gathered thin, the pouch full),
    // and the throw drawn back while a heavy attack charges.
    keepHands() {
        if (this.attacked >= 0) this.reloading(); // (has the simulation taken the attack up?)
        const d = this.doing;
        if (d) {
            const p = this.mine();
            const at = p !== null && (d.kind === 'butcher' ? p.butchering === d.id : p.gathering === true);
            if (at) d.acked = true;
            else if (d.acked || this.clock - d.since > ACK_WAIT) {
                this.doing = null;
                this.releasePose();
            }
        }
        const charging = this.input.charging === true && !this.doing && this.canAttack(this.world.find(this.self));
        if (charging && this.held !== POSE.THROW) this.holdPose(POSE.THROW);
        else if (!charging && this.held === POSE.THROW) this.releasePose();
    }

    holdPose(code) {
        this.held = code;
        this.env.hold?.(this.self, code);
    }

    releasePose() {
        if (!this.held) return;
        this.held = 0;
        this.env.release?.(this.self);
    }

    // The HUD's prompt: what E would do (or is doing), and R while you carry
    // food. A list of [key, what], or null.
    prompt(f) {
        if (this.resting) return [['E', 'Rise']];
        const out = [];
        if (this.doing) out.push(['E', this.doing.kind === 'gather' ? 'Stop gathering' : 'Butchering']);
        else {
            const what = this.interaction();
            if (what) {
                out.push(['E', what.kind === 'butcher' ? 'Butcher'
                    : what.kind === 'store' ? `Store ${what.amount} food`
                    : what.kind === 'take' ? `Take ${what.amount} food`
                    : what.kind === 'rest' ? 'Rest at camp'
                    : 'Gather']);
            }
        }
        if (f && this.carried(f) >= 1) out.push(['R', 'Eat']);
        return out.length ? out : null;
    }
}
