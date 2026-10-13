// A bot that plays the simulation the way the page does: it takes control of
// a person through a real Sim (as the worker runs it), moves the body itself
// and sends it as `input` and `act` messages, and reads snapshot.player back.
// It walks and sprints after grazers, creeps up on them and throws (or
// jabs), butchers its kills, gathers when there is nothing to hunt, eats
// from the pouch when hungry, takes a full pouch home to the rack, rolls
// away from predators and goes home to rest when weak. Each seed is played
// once in God mode and once in Play mode. Halfway through it leaves the body
// to the AI for a while (autopilot, as on the map view) and takes it back.
// At the end it kills off the line and the tribe it leads, which must
// release it (God) or end the game (Play).
//
// With items (package 3) it also crafts at camp when the store has the
// materials (a tool when it has none, else a spare weapon, with a flint more
// when there is one), takes up what lies within reach, cycles to its spare
// weapon now and then, uses its weapon's skill when it has the Spirit and
// its tool (a knife on its kills, a torch at a predator, a basket to gather).
// Now and then it goes to its tribe's forest (or, the next time, its stones)
// and chops wood (knaps flint) until its load is full, then takes the load
// home to the rack; and its calls include Gather wood and Gather flint.
//
// It fails (exit code 1) on an exception, more than 1% of its moves turned
// down, anyone alive with no energy, a snapshot.player field missing, food
// moving as it should not (the pouch out of bounds, a store that is not all
// that was carried, eating more than there is or past full, butchering more
// than a kill held), items going astray (a material in store below zero,
// something in its hands or kit that is not borne by it, a kit over its
// size), wood and flint moving as they should not (gathered faster than an
// errand's rate, a load over its most, a store that is not all of the load),
// or, over all sessions, no kill, none butchered, nothing stored, or (with
// items) nothing crafted, taken up, cycled, no skill or tool used, no wood
// or flint gathered and stored, no Gather wood or flint order taken.
//
//   make bot                                     # seeds 1-6 × 6000 steps × life.pace
//   make bot ARGS="--seeds 1-20 --steps 20000"
//   make bot ARGS="--set terrain.enabled=false"  # a flat world
import { params as defaults } from '../src/config.js';
import { Sim, setParam } from '../src/sim.js';
import { createRng } from '../src/rng.js';
import { KIND, TASK, costOf, isWeapon, handWork } from '../src/items.js';
import { wrapDelta, wrapPos } from '../src/util.js';

// What snapshot.player must hold, and of what type (gathering: false, or
// what: GATHERING).
const FIELDS = {
    id: 'number', mode: 'string', tribe: 'number', energy: 'number', carry: 'number', spirit: 'number',
    crouch: 'boolean', resting: 'boolean', dodging: 'boolean', snap: 'boolean', heir: 'number', over: 'boolean',
    x: 'number', y: 'number', heading: 'number', seq: 'number', auto: 'boolean',
    reload: 'number', butchering: 'number',
    weapon: 'number', tool: 'number', kit: 'object', crafting: 'object', skill: 'number',
    wood: 'number', flint: 'number', loadMax: 'number',
};
const GATHERING = new Set([false, 'food', 'wood', 'flint']);
// Out of every MATERIAL_EVERY steps, from MATERIAL_AT for MATERIAL_FOR, it
// goes for wood (then, the next time, flint) at its tribe's spot.
const MATERIAL_EVERY = 3000;
const MATERIAL_AT = 500;
const MATERIAL_FOR = 1500;
const MATERIAL_NAME = { [TASK.WOOD]: 'wood', [TASK.FLINT]: 'flint' };
const CYCLE_EVERY = 700;  // with a spare weapon: into the hand this often
const SKILL_EVERY = 400;  // a weapon skill at most this often (Spirit allowing)

// Stamina lives on the page and only limits what it sends (SPEC §5).
const STAMINA = { max: 100, sprint: 1, roll: 20, light: 10, regen: 2, rest: 7 }; // rest: steps without spending before it regenerates
const NOTICE = 120;    // grazers the bot goes after are at most this far
const CREEP = 25;      // and it creeps up on them from this close
const DANGER = 6;      // a predator this close: roll away
const PROBE_AT = 200;  // the step of the deliberate teleport, which must be turned down
const AWAY = 500;      // steps on autopilot, halfway through
const CALLS = ['rally', 'hunt', 'gather', 'defend', 'move', 'wood', 'flint']; // given in turn...
const CALL_EVERY = 600;                                      // ...this often
const THROW_AT = 14;   // a grazer this close: throw (locked on to it), or jab within reach
const STORE_AT = 60;   // carrying this much: home to the rack to store it
const EAT_BELOW = 0.6; // hungry below this fraction: eat from the pouch
const GATHER_EVERY = 1500; // out of every this many steps...
const GATHER_FOR = 300;    // ...it gathers for this many, hunting or not

function parseArgs(argv) {
    // (6000 steps of life: × the pace, so that as much happens around the bot.)
    const opts = { seeds: [1, 2, 3, 4, 5, 6], steps: 6000 * defaults.life.pace, sets: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--seeds') {
            const v = next();
            const m = v.match(/^(\d+)-(\d+)$/);
            opts.seeds = m ? Array.from({ length: +m[2] - +m[1] + 1 }, (_, k) => +m[1] + k) : v.split(',').map(Number);
        } else if (a === '--steps') opts.steps = +next();
        else if (a === '--set') opts.sets.push(next());
        else throw new Error(`unknown argument: ${a}`);
    }
    return opts;
}

// The nearest living member of `pop` to (x, y), within r: its index and offset, or null.
function nearest(w, pop, x, y, r) {
    let best = null;
    let bestD2 = r * r;
    for (let k = 0; k < pop.n; k++) {
        const dx = wrapDelta(pop.x[k] - x, w.width);
        const dy = wrapDelta(pop.y[k] - y, w.height);
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
            bestD2 = d2;
            best = { k, dx, dy, d: Math.sqrt(d2) };
        }
    }
    return best;
}

// The nearest of the player's kills (snapshot.carcasses, which with items
// lists everyone's: those `by` it) within 60 of (x, y): its id and offset, or null.
function nearestCarcass(w, list, x, y, by) {
    let best = null;
    for (const c of list) {
        if (c.by !== undefined && c.by !== by) continue;
        const dx = wrapDelta(c.x - x, w.width);
        const dy = wrapDelta(c.y - y, w.height);
        const d = Math.hypot(dx, dy);
        if (d < 60 && (!best || d < best.d)) best = { id: c.id, dx, dy, d };
    }
    return best;
}

// An item lying within reach of (x, y) (items.pickReach, less a little) that the
// player p can take up without putting anything down (room in the kit for
// what it holds in that hand), not tried before: the item, or null.
function lyingNear(w, x, y, p, tried) {
    const R = w.p.items.pickReach - 0.5;
    for (const item of w.items.values()) {
        if (item.bearer !== 0 || tried.has(item.id)) continue;
        const dx = wrapDelta(item.x - x, w.width);
        const dy = wrapDelta(item.y - y, w.height);
        if (dx * dx + dy * dy > R * R) continue;
        const room = isWeapon(item.kind) ? p.kit.weapons.length < w.p.items.kit : p.kit.tools.length < w.p.items.kit;
        if (room) return item;
    }
    return null;
}

// Who the bot plays: in Play, the first tribe's most experienced adult (most
// kills; ties: the eldest), as the page picks; in God, any adult.
function choose(w, mode, rng) {
    const pop = w.humans;
    const P = w.p.human;
    let best = -1;
    if (mode === 'play') {
        const tribe = w.tribes[0].id;
        for (let k = 0; k < pop.n; k++) {
            if (pop.tribe[k] !== tribe || pop.age[k] < P.maturity) continue;
            if (best < 0 || pop.kills[k] > pop.kills[best] || (pop.kills[k] === pop.kills[best] && pop.age[k] > pop.age[best])) best = k;
        }
    } else {
        let seen = 0;
        for (let k = 0; k < pop.n; k++) if (pop.age[k] >= P.maturity && rng.next() * ++seen < 1) best = k;
    }
    return best < 0 ? 0 : pop.id[best];
}

function play(params, seed, mode, steps) {
    const stats = {
        seed, mode, controlled: 0, moves: 0, rejected: 0, bites: 0, dodges: 0, heirs: 0, deaths: 0,
        rests: 0, auto: 0, probe: '—', end: '—', problems: [],
        calls: 0, answers: { call: 0, rally: 0, refused: 0 }, // calls given, and the tribe's answers
        // The hands: spears thrown, jabs, blows that struck, kills; and food:
        // butchered, gathered, eaten from the pouch, put in the store, taken.
        throws: 0, jabs: 0, hits: 0, kills: 0, carcasses: 0, butchered: 0, gathered: 0, eaten: 0, stored: 0, taken: 0,
        // Items: made, taken up, cycled to, skills and tools used, broken.
        crafted: 0, picked: 0, cycled: 0, skills: 0, tools: 0, broke: 0,
        // Materials by hand: chopped, knapped, put in the store; Gather wood
        // and flint orders the tribe took.
        chopped: 0, knapped: 0, woodStored: 0, flintStored: 0, matOrders: 0,
    };
    const problem = (what) => {
        if (stats.problems.length < 10) stats.problems.push(what);
    };
    let snap = null;
    const sim = new Sim((msg) => {
        if (msg.type === 'snapshot') snap = msg;
    });
    const want = () => sim.handle({ type: 'want', recycle: snap ? [snap.buffer] : null });
    sim.handle({ type: 'start', gen: 1, seed, aspect: 1.6, params });
    const w = sim.world; // read-only, as the page reads its Mirror
    const P = w.p.human;
    const Q = w.p.play;
    const T = w.terrain;
    const rng = createRng(seed * 7919 + (mode === 'play' ? 1 : 2)); // the bot's own: never the world's
    const mine = new Set(); // every id the bot has played

    const control = () => {
        const id = choose(w, mode, rng);
        if (!id) return false;
        sim.handle({ type: 'control', id, mode });
        return true;
    };

    // The body, as the page has it.
    const body = { id: 0, x: 0, y: 0, heading: 0, crouch: false, stamina: STAMINA.max, idle: 0, rolling: 0, rx: 0, ry: 0, resting: false, rested: 0 };
    // The hands: when each was last asked for (a step), the carcass being
    // butchered, what the person held before this step (for the checks),
    // and each kill's meat when first seen, with what butchering it gave.
    const hands = { attackAt: -99, butcher: 0, butcherAt: -99, storeAt: -99, gatherAt: -99, eatAt: -99, pre: null, meat: new Map(), cut: new Map() };
    // Items: when each was last tried (a step), and what a cycle should bring.
    const kit = { craftAt: -999, pickAt: -99, cycleAt: 0, skillAt: -999, toolAt: -99, expect: 0, expectId: 0, tried: new Set() };
    const itemsOn = w.itemsOn;
    let seq = 0;
    let probing = false;
    let resuming = false; // just back from autopilot: the snap that follows is expected
    let ended = null; // 'released' | 'over', once seen

    const look = () => {
        const p = snap.player;
        if (p === null) return null;
        for (const [f, type] of Object.entries(FIELDS)) {
            if (typeof p[f] !== type) problem(`step ${w.time}: snapshot.player.${f} is ${p[f]}`);
        }
        if (!GATHERING.has(p.gathering)) problem(`step ${w.time}: snapshot.player.gathering is ${p.gathering}`);
        return p;
    };

    const send = (msg) => sim.handle(msg);

    // One step of play: decide, move the body, send it, step, read back.
    const turn = () => {
        const p = look();
        if (p === null || p.over) return false;
        stats.controlled++;
        if (p.snap && p.heir === 0 && !probing && !resuming) stats.rejected++;
        if (p.snap || p.id !== body.id) {
            // Turned down, back from autopilot, or a new body (an heir, or
            // taken over): jump to it.
            body.x = p.x;
            body.y = p.y;
            body.heading = p.heading;
        }
        if (p.id !== body.id) {
            body.id = p.id;
            body.rolling = 0;
            body.resting = false;
            mine.add(p.id);
        }
        probing = false;
        resuming = false;
        const me = w.humans.id.subarray(0, w.humans.n).indexOf(p.id);
        if (me < 0) {
            problem(`step ${w.time}: snapshot.player.id ${p.id} is not alive`);
            return false;
        }
        if (p.auto) {
            // On the map: the AI runs the body, and the page sends nothing.
            stats.auto++;
            sim.step();
            want();
            return true;
        }
        const top = P.speed * w.humans.speedGene[me];
        const tribe = w.tribeById.get(p.tribe);
        let ux = Math.cos(body.heading);
        let uy = Math.sin(body.heading);
        let v = 0;
        let spend = 0;
        body.crouch = false;

        const danger = nearest(w, w.carnivores, body.x, body.y, DANGER);
        // Items: what it holds, whether it is in camp.
        const tool = itemsOn && p.tool ? w.items.get(p.tool) : undefined;
        const weapon = itemsOn && p.weapon ? w.items.get(p.weapon) : undefined;
        const atCamp = Math.hypot(wrapDelta(tribe.camp.x - body.x, w.width), wrapDelta(tribe.camp.y - body.y, w.height)) < P.campRadius - 3;
        // The spare it cycled to last step is in its hand (unless that body is gone, or it broke).
        if (kit.expect && kit.expectId === p.id && !snap.events.some((e) => e.type === 'broke')) {
            if (p.weapon === kit.expect) stats.cycled++;
            else problem(`step ${w.time}: cycled to ${p.weapon}, expected ${kit.expect}`);
        }
        kit.expect = 0;
        const craftable = () => {
            // A tool if it has none; else a spare weapon, a spare tool; whatever the store affords.
            const kinds = p.tool === 0 ? [KIND.TORCH, KIND.KNIFE, KIND.BASKET]
                : p.kit.weapons.length < 2 ? [KIND.SPEAR, KIND.BOW, KIND.CLUB]
                : p.kit.tools.length < 2 ? [KIND.KNIFE, KIND.TORCH, KIND.BASKET] : [];
            for (const k of kinds) {
                const c = costOf(w.p, k);
                if (tribe.wood >= c.wood && tribe.flint >= c.flint && tribe.hide >= c.hide) return k;
            }
            return 0;
        };
        let make = 0;
        if (body.rolling > 0) {
            ux = body.rx;
            uy = body.ry;
            v = Q.rollSpeed;
            body.rolling--;
        } else if (danger && tool && tool.kind === KIND.TORCH && w.time > kit.toolAt + 20) {
            // A torch: brandish it at the predator.
            send({ type: 'act', seq: ++seq, action: 'tool', dx: danger.dx, dy: danger.dy, target: w.carnivores.id[danger.k] });
            kit.toolAt = w.time;
        } else if (danger && weapon && weapon.kind === KIND.CLUB && p.spirit >= p.skill && p.reload === 0) {
            // A club: the ground slam.
            send({ type: 'act', seq: ++seq, action: 'skill', dx: danger.dx, dy: danger.dy, target: w.carnivores.id[danger.k] });
            kit.skillAt = w.time;
        } else if (danger && body.stamina >= STAMINA.roll) {
            // Roll away from it.
            send({ type: 'act', seq: ++seq, action: 'roll' });
            body.resting = false;
            body.rolling = Q.rollSteps - 1;
            body.rx = ux = -danger.dx / (danger.d || 1);
            body.ry = uy = -danger.dy / (danger.d || 1);
            v = Q.rollSpeed;
            spend = STAMINA.roll;
        } else if (body.resting) {
            body.rested++;
            if (!p.resting && body.rested > 1) {
                body.resting = false; // turned down, or bitten: up again
            } else if ((p.energy >= 0.85 * P.maxEnergy && body.rested > 60) || body.rested > 400) {
                send({ type: 'act', seq: ++seq, action: 'rest', on: false });
                body.resting = false;
            }
        } else if (itemsOn && p.crafting) {
            v = 0; // making something: a move would stop it
        } else if (itemsOn && atCamp && w.time > kit.craftAt + 300 && (make = craftable())) {
            // In camp, with the materials in store: make something (a flint more when there is one).
            send({ type: 'act', seq: ++seq, action: 'craft', kind: make, flint: tribe.flint >= costOf(w.p, make).flint + 1 });
            kit.craftAt = w.time;
        } else if (p.energy < 0.5 * P.maxEnergy) {
            // Home to rest.
            const dx = wrapDelta(tribe.camp.x - body.x, w.width);
            const dy = wrapDelta(tribe.camp.y - body.y, w.height);
            const d = Math.hypot(dx, dy) || 1;
            if (d < P.campRadius * 0.5) {
                send({ type: 'act', seq: ++seq, action: 'rest', on: true });
                body.resting = true;
                body.rested = 0;
                stats.rests++;
            } else {
                if (T !== null) {
                    T.way(tribe.paths, body.x, body.y, dx, dy, d);
                    ux = T.ux;
                    uy = T.uy;
                } else {
                    ux = dx / d;
                    uy = dy / d;
                }
                v = Math.min(d, top * P.cruise);
            }
        } else {
            // The hands (package 2): a kill of its own to butcher first, then
            // a full pouch to take home to the rack; otherwise after the
            // nearest grazer (sprint when it is far, walk nearer, creep up on
            // it at the end, and throw, or jab); with none in sight, gather.
            const prey = nearest(w, w.herbivores, body.x, body.y, NOTICE);
            const kill = nearestCarcass(w, snap.carcasses, body.x, body.y, p.id);
            const gathering = w.time % GATHER_EVERY < GATHER_FOR; // (a spell of gathering now and then)
            const cdx = wrapDelta(tribe.camp.x - body.x, w.width);
            const cdy = wrapDelta(tribe.camp.y - body.y, w.height);
            const campD = Math.hypot(cdx, cdy) || 1;
            const lying = itemsOn && w.time > kit.pickAt + 20 ? lyingNear(w, body.x, body.y, p, kit.tried) : null;
            // Materials (items): in a spell for wood (or flint), to the
            // tribe's spot for it, if the ground there gives it by hand; a
            // full load, or one left when the spell is over, home to the rack.
            const phase = w.time % MATERIAL_EVERY;
            const mat = Math.floor(w.time / MATERIAL_EVERY) % 2 ? TASK.FLINT : TASK.WOOD;
            const spell = itemsOn && phase >= MATERIAL_AT && phase < MATERIAL_AT + MATERIAL_FOR;
            const spot = spell ? (mat === TASK.WOOD ? tribe.woodSpot : tribe.flintSpot) : null;
            const workable = spot && handWork(w, spot.x, spot.y, tribe) === mat ? spot : null;
            const loaded = itemsOn ? p.wood + p.flint : 0;
            const unload = loaded > 0 && (loaded >= p.loadMax - 1e-9 || !workable);
            if (p.butchering) {
                v = 0; // (at it: a move would stop it)
            } else if (lying) {
                // Something lying within reach, with room in the kit for what is in hand: take it up.
                send({ type: 'act', seq: ++seq, action: 'pickup', item: lying.id });
                kit.pickAt = w.time;
                kit.tried.add(lying.id);
            } else if (kill) {
                ux = kill.dx / (kill.d || 1);
                uy = kill.dy / (kill.d || 1);
                if (kill.d < 2.5) {
                    if (hands.butcher !== kill.id || w.time > hands.butcherAt + 5) {
                        // (With a knife: its right click, which cuts twice as fast.)
                        if (tool && tool.kind === KIND.KNIFE) send({ type: 'act', seq: ++seq, action: 'tool', dx: kill.dx, dy: kill.dy, target: 0 });
                        else send({ type: 'act', seq: ++seq, action: 'butcher', on: true, id: kill.id });
                        hands.butcher = kill.id;
                        hands.butcherAt = w.time;
                    }
                } else v = Math.min(kill.d - 1.5, top * P.cruise);
            } else if (p.carry >= STORE_AT || unload) {
                if (campD < Q.rackReach - 2) {
                    if (w.time > hands.storeAt + 5) {
                        send({ type: 'act', seq: ++seq, action: 'store' });
                        hands.storeAt = w.time;
                    }
                } else {
                    if (T !== null) {
                        T.way(tribe.paths, body.x, body.y, cdx, cdy, campD);
                        ux = T.ux;
                        uy = T.uy;
                    } else {
                        ux = cdx / campD;
                        uy = cdy / campD;
                    }
                    v = Math.min(campD, top * P.cruise);
                }
            } else if (workable) {
                // At the spot, E held (chop or knap) until the load is full;
                // else on the way there, by land.
                const sdx = wrapDelta(workable.x - body.x, w.width);
                const sdy = wrapDelta(workable.y - body.y, w.height);
                const sd = Math.hypot(sdx, sdy) || 1;
                if (p.gathering === MATERIAL_NAME[mat]) v = 0;
                else if (sd < 1.5) {
                    if (w.time > hands.gatherAt + 5) {
                        send({ type: 'act', seq: ++seq, action: 'gather', on: true });
                        hands.gatherAt = w.time;
                    }
                } else {
                    if (T !== null && workable.paths) {
                        T.way(workable.paths, body.x, body.y, sdx, sdy, sd);
                        ux = T.ux;
                        uy = T.uy;
                    } else {
                        ux = sdx / sd;
                        uy = sdy / sd;
                    }
                    v = Math.min(sd, top * P.cruise);
                }
            } else if (prey && !gathering) {
                ux = prey.dx / (prey.d || 1);
                uy = prey.dy / (prey.d || 1);
                // Every third hunt, an ambush: creep to just beyond its
                // notice, then roll in and jab in the same step.
                const ambush = stats.kills % 3 === 2;
                if (prey.d < 3) v = 0;
                else if (prey.d < CREEP) {
                    body.crouch = true;
                    v = top * Q.crouchSpeed;
                } else if (prey.d > 60 && body.stamina > STAMINA.sprint) {
                    v = top;
                    spend = STAMINA.sprint;
                } else v = top * P.cruise;
                const ready = p.reload === 0 && body.stamina > 0 && w.time > hands.attackAt + 2;
                if (ambush && ready && prey.d < Q.jabRange + Q.rollSpeed - 0.1 && prey.d > Q.jabRange && body.stamina >= STAMINA.roll) {
                    send({ type: 'act', seq: ++seq, action: 'roll' });
                    body.rolling = Q.rollSteps - 1;
                    body.rx = ux;
                    body.ry = uy;
                    v = Q.rollSpeed; // (still crouched this step: it has not seen us yet)
                    spend += STAMINA.roll;
                }
                if (ready && (ambush ? prey.d - v < Q.jabRange - 0.1 : prey.d < THROW_AT)) {
                    // Now and then, with the Spirit for it, the weapon's skill (a club's is for predators).
                    const skill = !ambush && weapon && weapon.kind !== KIND.CLUB && p.skill > 0 && p.spirit >= p.skill && w.time > kit.skillAt + SKILL_EVERY;
                    send({ type: 'act', seq: ++seq, action: skill ? 'skill' : 'attack', heavy: false, dx: ux, dy: uy, power: 0, target: w.herbivores.id[prey.k], lock: true });
                    if (skill) kit.skillAt = w.time;
                    hands.attackAt = w.time;
                    spend += STAMINA.light;
                    if (!ambush) v = 0;
                }
            } else if (p.gathering) {
                v = 0;
            } else if (campD > P.campRadius && w.grass.g[w.grass.index(body.x, body.y)] >= P.gatherMin && p.carry < P.carryMax && w.time > hands.gatherAt + 5) {
                // (With a basket: its right click.)
                if (tool && tool.kind === KIND.BASKET) send({ type: 'act', seq: ++seq, action: 'tool', dx: ux, dy: uy, target: 0 });
                else send({ type: 'act', seq: ++seq, action: 'gather', on: true });
                hands.gatherAt = w.time;
            } else {
                const h = body.heading + (rng.next() - 0.5) * 0.6;
                ux = Math.cos(h);
                uy = Math.sin(h);
                v = top * P.cruise;
            }
        }
        // Hungry, with food in hand: R (once a second).
        if (p.energy < EAT_BELOW * P.maxEnergy && p.carry >= 1 && w.time >= hands.eatAt + 15 && !p.butchering) {
            send({ type: 'act', seq: ++seq, action: 'eat' });
            hands.eatAt = w.time;
        }
        hands.pre = { id: p.id, carry: p.carry, energy: p.energy, butchering: p.butchering, gathering: p.gathering, wood: p.wood, flint: p.flint };

        // Move, around water and cliffs, as the page does with its own terrain.
        if (v > 0) {
            let nx = wrapPos(body.x + ux * v, w.width);
            let ny = wrapPos(body.y + uy * v, w.height);
            if (T !== null && T.blocked(nx, ny)) {
                const side = rng.next() < 0.5 ? 1 : -1;
                if (T.move(body.x, body.y, ux, uy, v, side)) {
                    nx = T.x;
                    ny = T.y;
                    ux = T.ux;
                    uy = T.uy;
                } else {
                    nx = body.x;
                    ny = body.y;
                    v = 0;
                }
                if (body.rolling > 0) {
                    body.rx = ux;
                    body.ry = uy;
                }
            }
            body.x = nx;
            body.y = ny;
            body.heading = Math.atan2(uy, ux);
        }
        if (spend > 0) {
            body.stamina = Math.max(0, body.stamina - spend);
            body.idle = 0;
        } else if (++body.idle > STAMINA.rest) {
            body.stamina = Math.min(STAMINA.max, body.stamina + STAMINA.regen);
        }

        // Now and then, the spare weapon into the hand (it must be there next step).
        if (itemsOn && p.kit.weapons.length && w.time >= kit.cycleAt + CYCLE_EVERY && !p.crafting) {
            send({ type: 'act', seq: ++seq, action: 'cycle', slot: 'weapon' });
            kit.cycleAt = w.time;
            kit.expect = p.kit.weapons[0];
            kit.expectId = p.id;
        }

        // Now and then a call to the tribe (orders.js): each kind in turn, 30
        // ahead (a rally is around the body).
        if (w.time % CALL_EVERY === CALL_EVERY / 2) {
            const kind = CALLS[stats.calls++ % CALLS.length];
            send({ type: 'act', seq: ++seq, action: 'call', kind, x: body.x + 30 * Math.cos(body.heading), y: body.y + 30 * Math.sin(body.heading) });
        }

        // The deliberate teleport: far beyond any allowance, never applied.
        let { x, y } = body;
        if (w.time === PROBE_AT) {
            x = wrapPos(body.x + 40, w.width);
            probing = true;
        }
        send({ type: 'input', seq: ++seq, x, y, heading: body.heading, speed: v, crouch: body.crouch });
        stats.moves++;
        sim.step();
        want();
        if (probing) {
            const q = snap.player;
            if (q === null || q.over || q.heir !== 0) stats.probe = 'skipped'; // died on that very step
            else if (q.snap && Math.abs(wrapDelta(q.x - x, w.width)) > 30) stats.probe = 'rejected';
            else {
                stats.probe = 'ACCEPTED';
                problem('a 40-unit teleport was accepted');
            }
        }
        return true;
    };

    // What happened, from the snapshot's events.
    const tally = () => {
        for (const e of snap.events) {
            if (e.type === 'bite' && mine.has(e.id)) stats.bites++;
            else if (e.type === 'dodge' && mine.has(e.id)) stats.dodges++;
            else if (e.type === 'heir') stats.heirs++;
            else if (e.type === 'death' && e.kind === 'human' && mine.has(e.id)) stats.deaths++;
            else if (e.type === 'released' || e.type === 'over') ended = e.type;
            else if (e.type in stats.answers && e.tribe === snap.player?.tribe) {
                stats.answers[e.type]++;
                if (e.type === 'call' && (e.kind === 'wood' || e.kind === 'flint')) stats.matOrders++;
            }
        }
        const pop = w.humans;
        for (let k = 0; k < pop.n; k++) {
            if (!(pop.energy[k] > 0)) problem(`step ${w.time}: person ${pop.id[k]} alive with energy ${pop.energy[k]}`);
        }
        hand();
    };

    // The hands' bookkeeping, after each step the bot played: what its
    // blows did, and that food only moves as it should. `pre`: the person
    // as the step began.
    const hand = () => {
        const pre = hands.pre;
        hands.pre = null;
        const p = snap.player;
        const struck = new Set();
        let moved = false; // food in or out of the pouch by an act this step
        for (const e of snap.events) {
            const by = e.by ?? e.id;
            if (e.type === 'throw' && e.hit === undefined && mine.has(e.id)) stats.throws++;
            else if (e.type === 'jab' && mine.has(e.id)) stats.jabs++;
            else if (e.type === 'hit' && mine.has(by)) {
                stats.hits++;
                struck.add(e.id);
            } else if (e.type === 'death' && struck.has(e.id) && mine.has(e.by)) stats.kills++;
            else if (e.type === 'butchered' && mine.has(e.id)) {
                stats.carcasses++;
                const gave = hands.cut.get(e.carcass) ?? 0;
                const had = hands.meat.get(e.carcass);
                if (had !== undefined && gave > had + 1e-6) problem(`step ${w.time}: butchering gave ${gave.toFixed(2)} from a kill of ${had.toFixed(2)}`);
            } else if (e.type === 'store' && mine.has(e.id)) {
                moved = true;
                stats.stored += e.amount;
                stats.woodStored += e.wood ?? 0;
                stats.flintStored += e.flint ?? 0;
                if (pre && pre.id === e.id && Math.abs(e.amount - pre.carry) > 1e-9) problem(`step ${w.time}: stored ${e.amount}, carrying ${pre.carry}`);
                if (pre && pre.id === e.id && (Math.abs((e.wood ?? 0) - pre.wood) > 1e-9 || Math.abs((e.flint ?? 0) - pre.flint) > 1e-9)) {
                    problem(`step ${w.time}: stored ${e.wood ?? 0} wood and ${e.flint ?? 0} flint, carrying ${pre.wood} and ${pre.flint}`);
                }
            } else if (e.type === 'take' && mine.has(e.id)) {
                moved = true;
                stats.taken += e.amount;
            } else if (e.type === 'eat' && mine.has(e.id)) {
                moved = true;
                stats.eaten += e.amount;
                if (pre && pre.id === e.id) {
                    const most = Math.min(Q.eatMax, pre.carry, P.maxEnergy - pre.energy);
                    if (e.amount > most + 1e-9 || !(e.amount > 0)) problem(`step ${w.time}: ate ${e.amount}, at most ${most}`);
                    const bitten = snap.events.some((b) => b.type === 'bite' && b.id === e.id);
                    if (!bitten && p && p.id === e.id && p.energy < pre.energy + e.amount - 1) problem(`step ${w.time}: ate ${e.amount}, energy ${pre.energy} → ${p.energy}`);
                }
            }
        }
        for (const c of snap.carcasses) if (!hands.meat.has(c.id)) hands.meat.set(c.id, c.meat);
        if (itemsOn) items(p);
        if (!p || !pre || p.id !== pre.id || p.auto) return;
        if (!(p.carry >= 0 && p.carry <= P.carryMax + 1e-9)) problem(`step ${w.time}: carrying ${p.carry}`);
        if (itemsOn) materials(p, pre);
        // What butchering or gathering put in the pouch (when nothing else
        // moved food, nor starving ate some).
        const gain = p.carry - pre.carry;
        if (moved || pre.energy < P.starving * P.maxEnergy || gain <= 0) return;
        const cutting = pre.butchering || p.butchering;
        if (cutting) {
            stats.butchered += gain;
            hands.cut.set(cutting, (hands.cut.get(cutting) ?? 0) + gain);
        } else if (pre.gathering || p.gathering) stats.gathered += gain;
    };

    // The wood and flint it carries, after a step it played (pre: as the step
    // began): never over the load's most; stored, all of it (checked with
    // the store event); otherwise only ever more, and no faster than an
    // errand's worker on rich ground (a knife: materials.knifeKnap for flint).
    const materials = (p, pre) => {
        const I = w.p.items;
        if (p.wood + p.flint > p.loadMax + 1e-9) problem(`step ${w.time}: a load of ${p.wood} wood and ${p.flint} flint, at most ${p.loadMax}`);
        if (snap.events.some((e) => e.type === 'store' && e.id === p.id)) {
            if (p.wood !== 0 || p.flint !== 0) problem(`step ${w.time}: stored, still carrying ${p.wood} wood and ${p.flint} flint`);
            return;
        }
        const dw = p.wood - pre.wood;
        const df = p.flint - pre.flint;
        if (dw < -1e-9 || df < -1e-9) problem(`step ${w.time}: wood ${pre.wood} → ${p.wood}, flint ${pre.flint} → ${p.flint} without storing`);
        if (dw > I.wood + 1e-9 || df > I.flint * w.p.materials.knifeKnap + 1e-9) problem(`step ${w.time}: gathered ${dw} wood, ${df} flint in a step`);
        if (dw > 0 && df > 0) problem(`step ${w.time}: wood and flint in one step`);
        if (dw > 0) stats.chopped += dw;
        if (df > 0) stats.knapped += df;
    };

    // The items' bookkeeping, after each step: what it made, took up, used,
    // and broke; and that what it holds and keeps is its own, the kit no
    // bigger than it may be, no material in store below nothing.
    const items = (p) => {
        for (const e of snap.events) {
            if (e.type === 'crafted' && mine.has(e.by)) stats.crafted++;
            else if (e.type === 'picked' && mine.has(e.by) && kit.tried.has(e.item)) stats.picked++;
            else if (e.type === 'skill' && mine.has(e.id)) stats.skills++;
            else if (e.type === 'tool' && mine.has(e.id)) stats.tools++;
            else if (e.type === 'broke' && mine.has(e.bearer)) stats.broke++;
        }
        for (const t of w.tribes) {
            if (t.wood < -1e-9 || t.flint < -1e-9 || t.hide < -1e-9) problem(`step ${w.time}: tribe ${t.id} has ${t.wood} wood, ${t.flint} flint, ${t.hide} hides`);
        }
        if (!p || p.over || !p.id) return;
        const K = w.p.items.kit;
        if (p.kit.weapons.length > K || p.kit.tools.length > K) problem(`step ${w.time}: a kit of ${p.kit.weapons.length} weapons, ${p.kit.tools.length} tools`);
        for (const id of [p.weapon, p.tool, ...p.kit.weapons, ...p.kit.tools]) {
            if (!id) continue;
            const item = w.items.get(id);
            if (!item || item.bearer !== p.id) problem(`step ${w.time}: item ${id} in hand or kit is ${item ? `borne by ${item.bearer}` : 'gone'}`);
        }
    };

    // Leave the body to the AI (on) or take it back (off); back by hand, the
    // page must be told to jump to where the AI left it.
    const autopilot = (on) => {
        const p = snap.player;
        if (p === null || p.over || p.auto === on) return;
        send({ type: 'act', seq: ++seq, action: 'auto', on });
        want();
        if (snap.player.auto !== on) problem(`autopilot ${on ? 'on' : 'off'} did not take`);
        if (!on) {
            resuming = true;
            body.rolling = 0;
            body.resting = false;
            if (!snap.player.snap) problem('back from autopilot without a snap');
        }
    };

    try {
        control();
        want();
        const away = Math.floor(steps / 2);
        for (let t = 0; t < steps; t++) {
            if (t === away) autopilot(true);
            else if (t === away + AWAY) autopilot(false);
            if (!turn()) {
                // God mode, released (nobody to carry on): take over someone else.
                // Play: the game is over; the world goes on without us.
                if (mode === 'god' && snap.player === null && control()) {
                    want();
                    continue;
                }
                sim.step();
                want();
            }
            tally();
        }

        // The end: the line and the tribe die out, as many times as it takes.
        for (let round = 0; round < 50 && snap.player !== null && !snap.player.over; round++) {
            const p = snap.player;
            const pop = w.humans;
            for (let k = 0; k < pop.n; k++) {
                if (pop.id[k] === p.id || pop.tribe[k] === p.tribe || pop.lineage[k] === p.id) w.die(pop, k, 'killed');
            }
            sim.step();
            want();
            tally();
        }
        const p = snap.player;
        stats.end = p === null ? 'released' : p.over ? 'over' : 'still playing';
        const expected = mode === 'god' ? 'released' : 'over';
        if (stats.end !== expected || ended !== expected) problem(`ended ${stats.end} (event: ${ended}), expected ${expected}`);
    } catch (err) {
        problem(`exception at step ${w.time}: ${err.stack}`);
    }
    if (stats.rejected > stats.moves * 0.01) problem(`${stats.rejected} of ${stats.moves} moves turned down`);
    const a = stats.answers;
    if (stats.calls > 2 && a.call + a.rally + a.refused === 0) problem(`${stats.calls} calls given, and not one answered`);
    return stats;
}

const opts = parseArgs(process.argv.slice(2));
const params = structuredClone(defaults);
for (const s of opts.sets) {
    const [path, raw] = s.split('=');
    setParam(params, path, raw === 'true' ? true : raw === 'false' ? false : Number(raw));
}

console.log(`\n${opts.seeds.length} seeds × ${opts.steps} steps, God and Play${opts.sets.length ? '  ' + opts.sets.join(' ') : ''}\n`);
console.log('seed  mode  controlled  moves  rejected  bites  dodges  heirs  deaths  rests  auto  teleport  end');
const all = [];
for (const seed of opts.seeds) {
    for (const mode of ['god', 'play']) {
        const t0 = performance.now();
        const s = play(structuredClone(params), seed, mode, opts.steps);
        s.ms = performance.now() - t0;
        all.push(s);
        console.log(
            `${String(s.seed).padStart(4)}  ${s.mode.padEnd(4)}  ${String(s.controlled).padStart(10)}  ${String(s.moves).padStart(5)}  ` +
            `${String(s.rejected).padStart(8)}  ${String(s.bites).padStart(5)}  ${String(s.dodges).padStart(6)}  ${String(s.heirs).padStart(5)}  ` +
            `${String(s.deaths).padStart(6)}  ${String(s.rests).padStart(5)}  ${String(s.auto).padStart(4)}  ${s.probe.padEnd(8)}  ${s.end}`,
        );
        const a = s.answers;
        console.log(`        calls: ${s.calls} given; orders taken ${a.call}, rallies ${a.rally}, refused ${a.refused}`);
        console.log(
            `        hands: ${s.throws} throws, ${s.jabs} jabs, ${s.hits} struck, ${s.kills} kills, ${s.carcasses} butchered; food: `
            + `${s.butchered.toFixed(0)} cut, ${s.gathered.toFixed(0)} gathered, ${s.eaten.toFixed(0)} eaten, ${s.stored.toFixed(0)} stored`,
        );
        if (params.items.enabled) {
            console.log(`        items: ${s.crafted} crafted, ${s.picked} taken up, ${s.cycled} cycled, ${s.skills} skills, ${s.tools} tool uses, ${s.broke} broke`);
            console.log(`        materials: ${s.chopped.toFixed(1)} wood chopped, ${s.knapped.toFixed(1)} flint knapped; stored ${s.woodStored.toFixed(1)} wood, `
                + `${s.flintStored.toFixed(1)} flint; ${s.matOrders} Gather wood/flint orders taken`);
        }
        for (const msg of s.problems) console.log(`        ✗ ${msg}`);
    }
}
const bad = all.filter((s) => s.problems.length);
// Over all the sessions, the hands must have done their work: kills, cut
// up, and the meat home in the store; and with items, something made, taken
// up, cycled to, a skill and a tool used; wood and flint gathered by hand
// and stored, and the tribe sent for them.
const sum = (k) => all.reduce((t, s) => t + s[k], 0);
const ITEM_WORK = ['crafted', 'picked', 'cycled', 'skills', 'tools', 'chopped', 'knapped', 'woodStored', 'flintStored', 'matOrders'];
const idle = ['kills', 'carcasses', 'stored', ...(params.items.enabled ? ITEM_WORK : [])].filter((k) => !(sum(k) > 0));
if (idle.length) console.log(`        ✗ no ${idle.join(', no ')} in any session`);
console.log(`\n${all.length - bad.length}/${all.length} sessions clean · ${sum('kills')} kills, ${sum('carcasses')} butchered, `
    + `${sum('stored').toFixed(0)} food stored${params.items.enabled ? ` · items: ${ITEM_WORK.map((k) => `${+sum(k).toFixed(1)} ${k}`).join(', ')}` : ''} · `
    + `${(all.reduce((a, s) => a + s.ms, 0) / 1000).toFixed(1)} s\n`);
process.exit(bad.length || idle.length ? 1 : 0);
