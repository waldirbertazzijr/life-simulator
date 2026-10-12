// A bot that plays the simulation the way the page does: it takes control of
// a person through a real Sim (as the worker runs it), moves the body itself
// and sends it as `input` and `act` messages, and reads snapshot.player back.
// It walks and sprints after grazers, creeps up on them, rolls away from
// predators and goes home to rest when hungry. Each seed is played once in
// God mode and once in Play mode. Halfway through it leaves the body to the
// AI for a while (autopilot, as on the map view) and takes it back. At the
// end it kills off the line and the tribe it leads, which must release it
// (God) or end the game (Play).
//
// It fails (exit code 1) on an exception, more than 1% of its moves turned
// down, anyone alive with no energy, or a snapshot.player field missing.
//
//   make bot                                     # seeds 1-6 × 6000 steps
//   make bot ARGS="--seeds 1-20 --steps 20000"
//   make bot ARGS="--set terrain.enabled=false"  # a flat world
import { params as defaults } from '../src/config.js';
import { Sim, setParam } from '../src/sim.js';
import { createRng } from '../src/rng.js';

// What snapshot.player must hold, and of what type.
const FIELDS = {
    id: 'number', mode: 'string', tribe: 'number', energy: 'number', carry: 'number', spirit: 'number',
    crouch: 'boolean', resting: 'boolean', dodging: 'boolean', snap: 'boolean', heir: 'number', over: 'boolean',
    x: 'number', y: 'number', heading: 'number', seq: 'number', auto: 'boolean',
};

// Stamina lives on the page and only limits what it sends (SPEC §5).
const STAMINA = { max: 100, sprint: 1, roll: 20, regen: 2, rest: 7 }; // rest: steps without spending before it regenerates
const NOTICE = 120;    // grazers the bot goes after are at most this far
const CREEP = 25;      // and it creeps up on them from this close
const DANGER = 6;      // a predator this close: roll away
const PROBE_AT = 200;  // the step of the deliberate teleport, which must be turned down
const AWAY = 500;      // steps on autopilot, halfway through

const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
const wrapPos = (v, size) => (v >= 0 && v < size ? v : ((v % size) + size) % size);

function parseArgs(argv) {
    const opts = { seeds: [1, 2, 3, 4, 5, 6], steps: 6000, sets: [] };
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
        if (body.rolling > 0) {
            ux = body.rx;
            uy = body.ry;
            v = Q.rollSpeed;
            body.rolling--;
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
            // After the nearest grazer: sprint when it is far, walk nearer,
            // creep up on it at the end.
            const prey = nearest(w, w.herbivores, body.x, body.y, NOTICE);
            if (prey) {
                ux = prey.dx / (prey.d || 1);
                uy = prey.dy / (prey.d || 1);
                if (prey.d < 3) v = 0;
                else if (prey.d < CREEP) {
                    body.crouch = true;
                    v = top * Q.crouchSpeed;
                } else if (prey.d > 60 && body.stamina > STAMINA.sprint) {
                    v = top;
                    spend = STAMINA.sprint;
                } else v = top * P.cruise;
            } else {
                const h = body.heading + (rng.next() - 0.5) * 0.6;
                ux = Math.cos(h);
                uy = Math.sin(h);
                v = top * P.cruise;
            }
        }

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
        }
        const pop = w.humans;
        for (let k = 0; k < pop.n; k++) {
            if (!(pop.energy[k] > 0)) problem(`step ${w.time}: person ${pop.id[k]} alive with energy ${pop.energy[k]}`);
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
        for (const msg of s.problems) console.log(`        ✗ ${msg}`);
    }
}
const bad = all.filter((s) => s.problems.length);
console.log(`\n${all.length - bad.length}/${all.length} sessions clean · ${(all.reduce((a, s) => a + s.ms, 0) / 1000).toFixed(1)} s\n`);
process.exit(bad.length ? 1 : 0);
