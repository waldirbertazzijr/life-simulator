// Who you are, and where: the two ways to play (spec §4), stepping into a
// body and out to the map, resting at camp, deaths and heirs, the end of a
// line; and, each frame, the body, the look and what happened to you. The
// rest of play hangs off this (its parts are given this Modes as `m`):
//
//   actions.js    what the keys do (input.js names them)
//   hands.js      attacks, eating, and E (context.js: what E does here)
//   kit.js        items in hand: cycling, the tool, the skill, crafting
//   lead.js       leading your tribe: calls, and the tribe's answers
//   pouch.js      the pouch's slot: which of what you carry it shows (↓)
//   aim.js        the look's limits, lock-on, what is within reach
//   hud-state.js  what the HUD shows (hud.js draws it)
//
//   God  (the default) — a sandbox: become anyone, any time; when you die
//        you carry on as your heir, and with nobody left you are back on
//        the map.
//   Play — you lead one tribe: you begin as its most experienced adult, you
//        can only become its people, and when your line and your tribe are
//        gone the game is over and its story is told.
//
// In a body the world runs at 1× (16× while you rest at camp; at night,
// asleep there, 64× until dawn: sleep.js), the panel hides and the HUD
// shows. M rises to the map: your person stays yours but
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
// `env` is how this reaches the rest of the page (play/env.js wires it from
// main.js): the world (the Mirror), the input, the HUD, the camera rig,
// follow, the view, the speed, pause, the panel (inBody, openPicker,
// changed), the bodies' poses (pose, hold, release: the 3D view's), and
// what is under the crosshair (crosshair, aimed).
import { Body } from './body.js';
import { personName, relation, yearOf, years, deathPhrase, deathText } from './names.js';
import { LOOK_RATE, PITCH, START_PITCH, keepLock } from './aim.js';
import { act } from './actions.js';
import { Hands } from './hands.js';
import { Kit } from './kit.js';
import { Lead } from './lead.js';
import { Pouch } from './pouch.js';
import { fillHud } from './hud-state.js';
import { nightNow, restSpeed, SLEEP_SPEED } from './sleep.js';
import { clamp, wrapDelta, angleDelta } from '../view3d/util.js';

export { LOCK, lockTarget } from './aim.js';

export const DEATH_SECONDS = 3.5;
const MAP_CLOSE = 260;     // rising to the map: at most this far above your person
// A tribe-mate dying this close to you is told (mourn).
const MOURN = 80;

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
        this.asleep = false;     // resting at night: sleeping until dawn (sleep.js)
        this.restAcked = false;  // the simulation has said we sit (so its "not resting" counts)
        this.acked = false;      // the simulation has said it controls `self`
        this.seenId = 0;         // the person the latest `player` was about
        this.dying = null;       // { t, dead, outcome } while YOU DIED shows
        this.over = false;       // a Play game has ended; the story is shown
        this.lock = 0;           // the creature locked on to (aim.js)
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
        this.clock = 0;          // seconds in a body, for the hands' and the kit's waits
        // The parts (each keeps its own state, and reaches the rest through this).
        this.hands = new Hands(this); // attacks, eating, E (hands.js)
        this.kit = new Kit(this);     // items in hand, the craft menu (kit.js)
        this.lead = new Lead(this);   // leading your tribe (lead.js)
        this.pouch = new Pouch();     // what the pouch's slot shows (pouch.js)
        this.input.onAction = (name, info) => this.action(name, info);
    }

    // What the hands are at, the craft menu, and the calls (for main.js, the
    // tests and the console: the parts keep them).
    get doing() {
        return this.hands.doing;
    }

    get menu() {
        return this.kit.menu;
    }

    get calls() {
        return this.lead.calls;
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
        this.hands.reset();
        this.kit.reset();
        this.pouch.reset();
        this.input.capture = null;
        this.self = 0;
        this.known = null;
        this.tribe = 0;
        this.game = 'god';
        this.resting = false;
        this.asleep = false;
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

    // The simulation's report on your body, if it has it by hand; or null.
    mine() {
        const p = this.world.player;
        return p !== null && p.id !== 0 && p.id === this.self && !p.auto ? p : null;
    }

    // Put down whatever the hands were at, on the page alone (a new body, the
    // map, death: the simulation puts its own down), and shut the craft menu.
    dropHands() {
        this.hands.drop();
        this.kit.drop();
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

    // Sit down to rest, or at night lie down to sleep until dawn (sleep.js).
    rest() {
        this.resting = true;
        this.restAcked = false;
        this.asleep = nightNow(this.world);
        this.world.act({ seq: this.body.nextSeq(), action: 'rest', on: true });
        this.env.setSpeed(restSpeed(this.asleep));
    }

    // Each frame while resting: night falls on a rester (asleep now), or the
    // dawn comes to a sleeper (up, and back to 1×).
    keepResting() {
        if (!this.resting) return;
        const night = nightNow(this.world);
        if (this.asleep && !night) this.standUp();
        else if (night && !this.asleep) {
            this.asleep = true;
            this.env.setSpeed(SLEEP_SPEED);
        }
    }

    standUp() {
        if (!this.resting) return;
        this.resting = false;
        this.asleep = false;
        this.world.act({ seq: this.body.nextSeq(), action: 'rest', on: false });
        if (this.inBody) this.env.setSpeed(1);
    }

    // ---- The keys, the hands, leading (the parts do it) ----

    // An action input.js names (actions.js says what it does).
    action(name, info) {
        act(this, name, info);
    }

    // What E would do here (context.js), or null.
    interaction() {
        return this.hands.interaction();
    }

    // A left click: a light attack, or a heavy one of info.power (hands.js).
    attack(info) {
        return this.hands.attack(info);
    }

    // On the map: ready a call, or give the armed one at (x, y) (lead.js).
    armCall(kind) {
        this.lead.armCall(kind);
    }

    callAt(x, y) {
        return this.lead.callAt(x, y);
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
            this.keepResting();
            this.hands.keep();
            if (this.mine()) this.pouch.keep(this.self, this.hands.contents()); // (what was just picked up shows)
        }
        const f = this.self && !this.dying ? w.find(this.self) : null;
        if (f) {
            this.tribe = f.pop.tribe[f.i];
            this.record(f);
        }
        // Lock-on: kept while the target lives and is near, the look turned to it.
        if (this.lock) this.lock = this.inBody ? keepLock(w, this.body, this.lock, this.view, dt) : 0;
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

    // One of this frame's events (the Mirror's), to whichever part it is about.
    event(e) {
        switch (e.type) {
            case 'bite':
                if (e.id !== this.self || !this.self) break;
                this.hud.flash();
                this.standUp();
                break;
            case 'death':
                if (e.kind !== 'human' || !this.self) break;
                if (e.id === this.self) {
                    if (!this.dying) this.died(e);
                } else if (e.tribe === this.tribe && !this.dying) this.mourn(e);
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
                this.lead.answered(e);
                break;
            case 'legend':
            case 'broke':
            case 'crafted':
                this.kit.itemEvent(e);
                break;
        }
    }

    // ---- The HUD (after the camera has moved) ----

    drawHud(dt) {
        if (!this.inBody) return;
        this.hud.update(fillHud(this, this.hudState), dt);
    }

    // ---- Death, heirs, and the story of your line ----

    // Your person has died (the death event e): YOU DIED, how, and then
    // (carryOn) whoever is next.
    died(e) {
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
        const age = this.known ? `, aged ${years(this.known.age, this.world.p.human.maturity)}` : '';
        this.hud.banner('died', e?.cause ? `${deathText(e.cause, e.by, this.world)}${age}` : '');
    }

    // Someone of your tribe has died near you (within MOURN): say who, and how.
    mourn(e) {
        const w = this.world;
        const dx = wrapDelta(e.x - this.body.x, w.width);
        const dy = wrapDelta(e.y - this.body.y, w.height);
        if (dx * dx + dy * dy > MOURN * MOURN) return;
        const who = e.child ? `${personName(e.id)}, a child,` : personName(e.id);
        this.hud.notice?.(`${who} ${deathPhrase(e.cause, e.by, w)}`, true);
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
        // (With a quiet offer to shape your heir's looks: play/editor.js.)
        this.hud.banner('line', this.lineText(dead, next, f), { text: 'shape your heir · L', act: () => this.env.editLook?.(next.id, true) });
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
            years: Math.floor(sum('age') / yearOf(this.world.p.human.maturity)),
            kills: sum('kills'),
            children: sum('children'),
            line: rs.map((r) => personName(r.id)),
        };
    }
}
