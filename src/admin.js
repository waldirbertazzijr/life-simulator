// The admin console's commands, run in the simulation (the page's side, the
// console itself, is play/console.js). They are for trying things out
// without waiting: better items, more materials, rarities, legends, a world
// run forward.
//
// The page sends `admin {id, cmd, args, target}` (args: the words after the
// command; target: what you are locked on to, or aim at, 0 if nothing). The
// Sim queues it and runs it at the start of the next step, as the player's
// acts are (or at once while paused: no step is coming). The answer goes
// back as an event, {type: 'admin', id, cmd, ok, text, changed, time}:
// `text` says what happened, or what was wrong and the usage line; `changed`
// is true when the command changed the world (Play mode marks the run).
//
// "You" are the person you control (world.player); in God view with nobody
// controlled, the creature you follow (world.watch).
//
// Nothing here runs unless a command comes, and it draws no random numbers
// until then. The two hooks in world.js (an immortal player: spared,
// keepLife) run only while world.immortal is set, which only `immortal on`
// does.
import { setParam } from './sim.js';
import { applyAct } from './player.js';
import { spawnPerson } from './tribes.js';
import { personName, yearOf } from './play/names.js'; // (a year as the page counts ages)
import { ITEM_KINDS, KIND, isWeapon, isWorn, traitsOf, wearMax, newItem, hold, heldLike, putDown, forge, fraction, carryOf } from './items.js';
import { TAU, wrapDelta, wrapMod, livingIndexOf } from './util.js';

const MAX_SKIP = 50000;  // steps a skip may run at once
const MAX_SPAWN = 100;   // creatures a spawn may make at once
const MAX_EVENTS = 2000; // as sim.js: events kept for the next snapshot at most

const RARITIES = ['normal', 'rare', 'legendary'];
const WEAPON_TRAITS = ['range', 'accuracy', 'reload', 'durability'];
const TOOL_TRAITS = ['effect', 'durability'];
const TRAITS = ['range', 'accuracy', 'reload', 'effect', 'durability', 'warmth'];
const SLOTS = ['weapon', 'tool'];
const MATERIALS = ['food', 'wood', 'flint', 'hide'];
const SPECIES = ['herbivore', 'carnivore', 'person'];

// Every command: how it is typed, what it does, whether it changes the world
// (`changes`: Play mode marks the run), and what Tab offers for each word
// after it (a list, or 'param': the parameters' paths). `page`: the page
// runs it itself (a new world must be built there too; the log is the page's).
export const COMMANDS = {
    help: { usage: 'help [command]', about: 'the commands, or how to use one', complete: ['commands'] },
    give: {
        usage: 'give <kind> [normal|rare|legendary] [trait]', changes: true, complete: [ITEM_KINDS.slice(1), RARITIES, TRAITS],
        about: 'an item: into your hand if it is empty, else your kit, else at your feet',
        more: [
            `kinds: ${ITEM_KINDS.slice(1).join(' ')}`,
            `traits: weapons ${WEAPON_TRAITS.join(' ')}; tools ${TOOL_TRAITS.join(' ')}; a cloak warmth (rare rolls one if none is given)`,
            'a legendary item gets its name and history as legends do (deed: admin)',
        ],
    },
    legend: { usage: 'legend [weapon|tool]', about: 'make the item in your hand legendary', changes: true, complete: [SLOTS] },
    rare: {
        usage: 'rare [weapon|tool] [trait]', about: 'make the item in your hand rare, with that trait', changes: true,
        complete: [[...SLOTS, ...TRAITS], TRAITS],
    },
    repair: { usage: 'repair', about: 'restore the wear of what you hold, and your spares', changes: true },
    store: {
        usage: 'store <food|wood|flint|hide> <n>', about: "add n to your tribe's store (negative: take)", changes: true,
        complete: [MATERIALS],
    },
    carry: {
        usage: 'carry <food|wood|flint> <n>', about: 'add n to what you carry: food in the pouch, wood or flint in your load', changes: true,
        complete: [['food', 'wood', 'flint']],
    },
    heal: { usage: 'heal', about: 'full energy', changes: true },
    spirit: { usage: 'spirit', about: 'full Spirit', changes: true },
    immortal: {
        usage: 'immortal [on|off]', about: 'nothing hurts you and you do not die (no argument: switch)', changes: true,
        complete: [['on', 'off']],
    },
    spawn: {
        usage: 'spawn <herbivore|carnivore|person> [n]', about: 'n (1) new adults near you; people join your tribe, or the nearest',
        changes: true, complete: [SPECIES],
    },
    kill: { usage: 'kill [id|me]', about: 'your lock-on target, or what is under the crosshair, or the creature you follow', changes: true, complete: [['me']] },
    tp: { usage: 'tp <x> <y> | tp camp', about: 'move your body there (world units), or to your camp', changes: true, complete: [['camp']] },
    skip: { usage: 'skip <steps>', about: `run the world forward fast (at most ${MAX_SKIP}); your person lives on under the AI meanwhile`, changes: true },
    set: { usage: 'set <param.path> <value>', about: 'change a live parameter', changes: true, complete: ['param'] },
    get: { usage: 'get [param.path]', about: 'read a parameter (none: the groups)', complete: ['param'] },
    seed: { usage: 'seed <n>', about: 'a new world, from seed n (with the numbers as set)', changes: true, page: true },
    save: { usage: 'save [1|2|3]', about: 'save this game to a slot (1 if none is given): the save menu\'s slots', page: true, complete: [['1', '2', '3']] },
    load: {
        usage: 'load [1|2|3|auto]', about: 'carry on from a slot (1 if none is given), or the autosave', page: true,
        complete: [['1', '2', '3', 'auto']],
    },
    stats: { usage: 'stats', about: 'populations, tribes, items by kind and rarity, legends' },
    clear: { usage: 'clear', about: 'clear this log', page: true },
};
export const COMMAND_NAMES = Object.keys(COMMANDS);

// A typed line → {cmd, args}: the words, the command in lower case (null
// for an empty line).
export function parse(line) {
    const words = String(line).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    return { cmd: words[0].toLowerCase(), args: words.slice(1) };
}

// The help: every command (no name), or one command's usage and notes.
export function helpText(name) {
    if (name) {
        const c = COMMANDS[String(name).toLowerCase()];
        if (!c) return null;
        return [c.usage, `  ${c.about}`, ...(c.more ?? []).map((m) => `  ${m}`)].join('\n');
    }
    const width = Math.max(...COMMAND_NAMES.map((n) => COMMANDS[n].usage.length));
    return [
        ...COMMAND_NAMES.map((n) => `${COMMANDS[n].usage.padEnd(width)}  ${COMMANDS[n].about}`),
        'you: the person you control; in God view with nobody controlled, the creature you follow',
    ].join('\n');
}

// A command that cannot be done: its message, and the usage line goes with it.
class Refusal extends Error {}
const refuse = (text) => {
    throw new Refusal(text);
};

// Run one command on the world; `sim` (the Sim, or null in a test) is for
// skip. → {cmd, ok, text, changed} (and `param`: {path, value}, after a set,
// so the page's own parameters can follow).
export function execute(world, msg, sim = null) {
    const cmd = String(msg.cmd ?? '').toLowerCase();
    const args = Array.isArray(msg.args) ? msg.args.map(String) : [];
    const c = COMMANDS[cmd];
    if (!c) return { cmd, ok: false, text: `unknown command "${cmd}": type help`, changed: false };
    try {
        const r = RUN[cmd](world, args, msg, sim);
        const out = typeof r === 'string' ? { text: r } : r;
        return { cmd, ok: true, text: out.text, changed: out.changed ?? !!c.changes, ...(out.param ? { param: out.param } : {}) };
    } catch (err) {
        if (!(err instanceof Refusal)) throw err;
        return { cmd, ok: false, text: `${err.message}\nusage: ${c.usage}`, changed: false };
    }
}

// The Sim's queue of commands (sim.admin), run at the start of a step (or at
// once, paused): each answered with an `admin` event, and what it set off
// (deaths, legends, items dropped) sent along with the step's events.
export function runAdmin(sim) {
    const queue = sim.admin;
    sim.admin = [];
    for (const msg of queue) {
        const w = sim.world;
        if (!w) continue;
        const k = w.events.length;
        const t = w.time;
        const r = execute(w, msg, sim);
        // (A skip has stepped, and sent its events already.)
        if (sim.world === w && w.time === t) {
            for (let j = k; j < w.events.length; j++) sim.events.push(w.events[j]);
            w.events.length = k;
        }
        const e = { type: 'admin', id: Number(msg.id) || 0, cmd: r.cmd, ok: r.ok, text: r.text, changed: r.changed, time: sim.world.time };
        if (r.param) e.param = r.param;
        sim.events.push(e);
    }
    if (sim.events.length > MAX_EVENTS) sim.events.splice(0, sim.events.length - MAX_EVENTS);
    sim.dirty = true;
}

// ---- Who ----------------------------------------------------------------------------------

// You: {kind, pop, i, player} (player: the person you control), or a refusal.
function you(world) {
    const pl = world.player;
    if (pl !== null) {
        if (!pl.id) refuse('your line has ended: there is nobody to do it to');
        const i = livingIndexOf(world.humans, pl.id);
        if (i < 0) refuse('your person is gone');
        return { kind: 'human', pop: world.humans, i, player: true };
    }
    const f = world.watch ? world.find(world.watch) : null;
    if (f && f.pop.energy[f.i] > 0) return { ...f, player: false };
    refuse('nobody: take control of someone, or follow a creature');
}

const SPECIES_NAME = { herbivore: 'a grazer', carnivore: 'a predator' };

// You, a person.
function person(world) {
    const f = you(world);
    if (f.kind !== 'human') refuse(`you follow ${SPECIES_NAME[f.kind]}: that is for people`);
    return f;
}

// You, the person you control.
function controlled(world) {
    const f = you(world);
    if (!f.player) refuse('that is for the person you control');
    return f;
}

function needItems(world) {
    if (!world.itemsOn) refuse('items are off in this world (items.enabled)');
}

// Someone, for the answers: "Tiko of the Neto", "carnivore #812".
function who(world, f) {
    const id = f.pop.id[f.i];
    if (f.kind !== 'human') return `${f.kind} #${id}`;
    const t = world.tribeById.get(f.pop.tribe[f.i]);
    return t ? `${personName(id)} of the ${t.name}` : personName(id);
}

// ---- Words --------------------------------------------------------------------------------

function kindArg(word) {
    const k = ITEM_KINDS.indexOf(String(word ?? '').toLowerCase());
    if (k <= 0) refuse(word ? `no such kind: ${word} (${ITEM_KINDS.slice(1).join(', ')})` : 'which kind?');
    return k;
}

function traitArg(kind, word) {
    const t = String(word).toLowerCase();
    const allowed = traitsOf(kind);
    if (!allowed.includes(t)) refuse(`a ${ITEM_KINDS[kind]}'s traits are ${allowed.join(', ')}`);
    return t;
}

function numberArg(word, what) {
    const n = Number(word);
    if (word === undefined || word === '' || !Number.isFinite(n)) refuse(word === undefined ? `how many ${what}?` : `not a number: ${word}`);
    return n;
}

const fmt = (v) => (Math.abs(v) >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1));
const kindName = (item) => ITEM_KINDS[item.kind];
const itemTitle = (item) => (item.legend ? `${item.legend.name} (a legendary ${kindName(item)})`
    : item.rarity === 1 ? `a rare ${kindName(item)} (${item.trait} ×${item.mult})` : `a ${kindName(item)}`);

// The item in your hand: in `slot`, or (none said) the weapon, else the tool.
function inHand(world, f, slot) {
    const { pop, i } = f;
    const id = slot === 'tool' ? pop.tool[i] : slot === 'weapon' ? pop.weapon[i] : pop.weapon[i] || pop.tool[i];
    const item = id ? world.items.get(id) : undefined;
    if (!item) refuse(slot ? `nothing in your ${slot} hand` : 'nothing in your hands');
    return item;
}

// ---- The commands -------------------------------------------------------------------------

// The deed of a legend made here, counted with the others (items.js forge).
function forgeHere(world, item, by) {
    const tally = world.itemStats.legends;
    if (!('admin' in tally)) tally.admin = 0;
    forge(world, item, 'admin', 'Made a legend by the gods', by);
}

// A new item to person f: into the empty hand, else (the player) the kit,
// else down at its feet (in camp, among the camp's goods). Where it went.
function place(world, f, item) {
    const { pop, i } = f;
    const pl = world.player;
    const held = heldLike(world, i, item.kind);
    if (held === null) {
        hold(world, i, item);
        return isWorn(item.kind) ? 'on your back' : 'in your hand';
    }
    if (isWorn(item.kind)) {
        // (A cloak: on, the old one off at your feet.)
        putDown(world, i, held);
        hold(world, i, item);
        return 'on your back';
    }
    const spares = f.player && pl.kit ? (isWeapon(item.kind) ? pl.kit.weapons : pl.kit.tools) : null;
    if (spares !== null && spares.length < world.p.items.kit) {
        // (As a crafted one goes into the kit: acts/gear.js finishCrafting.)
        spares.push(item.id);
        item.bearer = pop.id[i];
        item.last = pop.id[i];
        item.gens = 1;
        item.line = pop.id[i];
        return `in your kit (${isWeapon(item.kind) ? '→' : '←'} takes it up)`;
    }
    putDown(world, i, item);
    return 'at your feet';
}

// A trait for a rare `kind`, rolled.
function rollTrait(world, kind) {
    const list = traitsOf(kind);
    return list[Math.floor(world.rng.next() * list.length)];
}

// Make `item` rare with `trait`, keeping the share of its use left.
function makeRare(world, item, trait) {
    const I = world.p.items;
    const left = fraction(world, item);
    const max = wearMax(world.p, item.kind, 1, trait);
    item.rarity = 1;
    item.trait = trait;
    item.mult = I.rare;
    item.max = max;
    item.wear = Math.max(1, left * max);
    if (item.kind === KIND.TORCH) item.expires = world.time + item.wear;
    item.rev++; // (the page is told again)
}

// Full use again (legends never wear).
function mend(world, item) {
    if (item.rarity === 2) return false;
    item.wear = item.max;
    if (item.kind === KIND.TORCH) item.expires = world.time + item.max;
    return true;
}

// Somewhere open near (x, y), for a newcomer.
function near(world, x, y) {
    const { rng, terrain } = world;
    for (let k = 0; k < 30; k++) {
        const a = rng.next() * TAU;
        const r = 4 + rng.next() * 10;
        const nx = wrapMod(x + Math.cos(a) * r, world.width);
        const ny = wrapMod(y + Math.sin(a) * r, world.height);
        if (terrain === null || !terrain.blocked(nx, ny)) return { x: nx, y: ny };
    }
    return { x, y };
}

// The tribe whose camp is nearest (x, y), or null.
function nearestTribe(world, x, y) {
    let best = null;
    let bestD = Infinity;
    for (const t of world.tribes) {
        const dx = wrapDelta(t.camp.x - x, world.width);
        const dy = wrapDelta(t.camp.y - y, world.height);
        const d = dx * dx + dy * dy;
        if (d < bestD) {
            bestD = d;
            best = t;
        }
    }
    return best;
}

// A value typed for a parameter, as the kind of value it holds now.
function valueFor(raw, now) {
    const s = raw.trim();
    if (!s) refuse('which value?');
    if (typeof now === 'boolean') {
        if (['true', 'on', 'yes', '1'].includes(s.toLowerCase())) return true;
        if (['false', 'off', 'no', '0'].includes(s.toLowerCase())) return false;
        refuse(`not on or off: ${s}`);
    }
    if (typeof now === 'number') {
        const n = Number(s);
        if (!Number.isFinite(n)) refuse(`not a number: ${s}`);
        return n;
    }
    if (typeof now === 'string') return s;
    try {
        return JSON.parse(s);
    } catch {
        refuse(`not JSON: ${s}`);
    }
}

// A parameter (or a group of them) by its path, or a refusal.
function paramAt(params, path) {
    let o = params;
    for (const k of path.split('.')) {
        if (o === null || typeof o !== 'object' || !(k in o)) refuse(`unknown parameter: ${path}`);
        o = o[k];
    }
    return o;
}

const show = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

const RUN = {
    help(world, args) {
        if (!args.length) return { text: helpText(), changed: false };
        const text = helpText(args[0]);
        if (text === null) refuse(`no such command: ${args[0]}`);
        return { text, changed: false };
    },

    give(world, args) {
        needItems(world);
        const f = person(world);
        const kind = kindArg(args[0]);
        const r = args[1] === undefined ? 0 : RARITIES.indexOf(args[1].toLowerCase());
        if (r < 0) refuse(`not a rarity: ${args[1]} (${RARITIES.join(', ')})`);
        let trait = args[2] === undefined ? '' : traitArg(kind, args[2]);
        if (r === 0 && trait) refuse('a normal item has no trait: give it rare or legendary');
        if (r === 2 && trait === 'durability') refuse('a legend never wears: durability is not a legend\'s trait');
        const { pop, i } = f;
        if (r === 1 && !trait) trait = rollTrait(world, kind);
        const item = newItem(world, kind, r === 1 ? 1 : 0, r === 1 ? trait : '', pop.id[i], pop.tribe[i]);
        if (r === 2 && trait) item.trait = trait;
        const where = place(world, f, item);
        if (r === 2) forgeHere(world, item, pop.id[i]);
        return `${itemTitle(item)}, ${where}`;
    },

    legend(world, args) {
        needItems(world);
        const f = person(world);
        const slot = args[0] === undefined ? '' : args[0].toLowerCase();
        if (slot && !SLOTS.includes(slot)) refuse(`not weapon or tool: ${args[0]}`);
        const item = inHand(world, f, slot);
        if (item.rarity === 2) return { text: `${item.legend.name} is a legend already`, changed: false };
        forgeHere(world, item, f.pop.id[f.i]);
        return `your ${kindName(item)} is ${item.legend.name} now: ${item.trait} ×${item.mult}, never wears`;
    },

    rare(world, args) {
        needItems(world);
        const f = person(world);
        let slot = '';
        let word = '';
        for (const a of args) {
            const s = a.toLowerCase();
            if (SLOTS.includes(s)) slot = s;
            else if (TRAITS.includes(s)) word = s;
            else refuse(`not weapon, tool or a trait: ${a}`);
        }
        // (A trait only one slot has says which hand.)
        if (!slot && word && word !== 'durability') slot = word === 'effect' ? 'tool' : 'weapon';
        const item = inHand(world, f, slot);
        if (item.rarity === 2) refuse(`${item.legend.name} is a legend: better than rare`);
        const trait = word ? traitArg(item.kind, word) : rollTrait(world, item.kind);
        makeRare(world, item, trait);
        return `your ${kindName(item)} is rare now: ${trait} ×${item.mult}`;
    },

    repair(world) {
        needItems(world);
        const f = person(world);
        const { pop, i } = f;
        const ids = [pop.weapon[i], pop.tool[i]];
        if (f.player && world.player.kit) ids.push(...world.player.kit.weapons, ...world.player.kit.tools);
        const mended = [];
        for (const id of ids) {
            const item = id ? world.items.get(id) : undefined;
            if (item && mend(world, item)) mended.push(kindName(item));
        }
        if (!mended.length) return { text: 'nothing to repair', changed: false };
        return `repaired: ${mended.join(', ')}`;
    },

    store(world, args) {
        const mat = String(args[0] ?? '').toLowerCase();
        if (!MATERIALS.includes(mat)) refuse(args[0] ? `not food, wood, flint or hide: ${args[0]}` : 'which?');
        if (mat !== 'food') needItems(world);
        const n = numberArg(args[1], mat);
        const f = person(world);
        const tribe = world.tribeById.get(f.pop.tribe[f.i]);
        const key = mat === 'food' ? 'store' : mat;
        const before = tribe[key];
        tribe[key] = Math.max(0, before + n);
        return `the ${tribe.name}'s ${mat}: ${fmt(before)} → ${fmt(tribe[key])}`;
    },

    carry(world, args) {
        const mat = String(args[0] ?? '').toLowerCase();
        if (!['food', 'wood', 'flint'].includes(mat)) refuse(args[0] ? `not food, wood or flint: ${args[0]}` : 'which?');
        const n = numberArg(args[1], mat);
        const P = world.p.human;
        if (mat === 'food') {
            const f = person(world);
            const { pop, i } = f;
            const most = P.carryMax * (world.itemsOn ? carryOf(world, pop, i) : 1);
            const before = pop.carry[i];
            pop.carry[i] = Math.min(most, Math.max(0, before + n));
            return `food carried: ${fmt(before)} → ${fmt(pop.carry[i])}${before + n > most ? ` (at most ${fmt(most)})` : ''}`;
        }
        // Wood and flint by hand: the player's load (player.wood, player.flint,
        // together at most items.load, more with a basket).
        needItems(world);
        const f = controlled(world);
        const pl = world.player;
        const most = world.p.items.load * carryOf(world, f.pop, f.i);
        const other = mat === 'wood' ? pl.flint || 0 : pl.wood || 0;
        const before = pl[mat] || 0;
        pl[mat] = Math.min(most - other, Math.max(0, before + n));
        if (pl[mat] < 0) pl[mat] = 0;
        return `${mat} carried: ${fmt(before)} → ${fmt(pl[mat])}${before + n + other > most ? ` (a load is at most ${fmt(most)})` : ''}`;
    },

    heal(world) {
        const f = you(world);
        const max = world.p[f.kind].maxEnergy;
        const before = f.pop.energy[f.i];
        f.pop.energy[f.i] = max;
        return `energy ${fmt(before)} → ${fmt(max)}`;
    },

    spirit(world) {
        controlled(world);
        const pl = world.player;
        const before = pl.spirit;
        pl.spirit = world.p.play.spiritMax;
        return `Spirit ${fmt(before)} → ${fmt(pl.spirit)}`;
    },

    immortal(world, args) {
        const f = controlled(world);
        const word = args[0] === undefined ? '' : args[0].toLowerCase();
        if (word && word !== 'on' && word !== 'off') refuse(`not on or off: ${args[0]}`);
        const on = word ? word === 'on' : !world.immortal;
        world.immortal = on ? { id: world.player.id, life: f.pop.energy[f.i] } : null;
        return on ? 'immortal: on. Nothing hurts you, hunger neither, and you do not die' : 'immortal: off';
    },

    spawn(world, args) {
        const what = String(args[0] ?? '').toLowerCase();
        const species = what === 'people' || what === 'human' ? 'person' : what.replace(/s$/, '');
        if (!SPECIES.includes(species)) refuse(args[0] ? `not herbivore, carnivore or person: ${args[0]}` : 'what?');
        const n = args[1] === undefined ? 1 : numberArg(args[1], species);
        if (!Number.isInteger(n) || n < 1 || n > MAX_SPAWN) refuse(`from 1 to ${MAX_SPAWN} at once`);
        const f = you(world);
        const x = f.pop.x[f.i];
        const y = f.pop.y[f.i];
        const ids = [];
        if (species === 'person') {
            if (!world.p.human.enabled) refuse('there are no people in this world (human.enabled)');
            const tribe = f.kind === 'human' ? world.tribeById.get(f.pop.tribe[f.i]) : nearestTribe(world, x, y);
            if (!tribe) refuse('there are no tribes left to join');
            const P = world.p.human;
            for (let k = 0; k < n; k++) {
                const at = near(world, x, y);
                const i = spawnPerson(world, tribe, at.x, at.y, P.maxEnergy * 0.7, P.maturity + 2 * yearOf(P.maturity));
                // (Adults start with a plain spear, as the first ones did.)
                if (world.itemsOn) hold(world, i, newItem(world, KIND.SPEAR, 0, '', 0, tribe.id));
                ids.push(world.humans.id[i]);
            }
            const names = ids.slice(0, 5).map(personName).join(', ');
            return `${names}${ids.length > 5 ? ` and ${ids.length - 5} more` : ''} joined the ${tribe.name}`;
        }
        const pop = species === 'herbivore' ? world.herbivores : world.carnivores;
        const sp = world.p[species];
        const genes = pop.n ? world.meanGenes(pop) : sp.genes;
        for (let k = 0; k < n; k++) {
            const at = near(world, x, y);
            const i = world.spawn(pop, sp, at.x, at.y, sp.maxEnergy * 0.7, genes.speed, genes.sense, sp.maturity);
            ids.push(pop.id[i]);
        }
        return `${n} ${species}${n === 1 ? '' : 's'} near you (#${ids[0]}${n > 1 ? `–#${ids.at(-1)}` : ''})`;
    },

    kill(world, args, msg) {
        let id = 0;
        const word = args[0] === undefined ? '' : args[0].toLowerCase();
        if (word === 'me') {
            const f = you(world);
            id = f.pop.id[f.i];
        } else if (word) {
            id = Number(word);
            if (!Number.isInteger(id) || id <= 0) refuse(`not an id: ${args[0]}`);
        } else if (Number(msg.target) > 0) {
            id = Number(msg.target);
        } else if (world.watch && !(world.player !== null && world.player.id === world.watch)) {
            id = world.watch;
        }
        if (!id) refuse('no target: lock on to one (Q), aim at it, follow it, or give its id');
        const f = world.find(id);
        if (!f || f.pop.energy[f.i] <= 0) refuse(`nobody alive has the id ${id}`);
        if (world.immortal && world.player !== null && world.player.id === id) refuse('you are immortal: immortal off first');
        const name = who(world, f);
        world.die(f.pop, f.i, 'admin');
        // (Gone at once: the next step must not step it again.)
        f.pop.compact();
        return `${name} is dead`;
    },

    tp(world, args) {
        const f = you(world);
        const { pop, i } = f;
        let x;
        let y;
        if (args[0] !== undefined && args[0].toLowerCase() === 'camp') {
            if (f.kind !== 'human') refuse(`you follow ${SPECIES_NAME[f.kind]}: it has no camp`);
            const camp = world.tribeById.get(pop.tribe[i]).camp;
            x = camp.x;
            y = camp.y;
        } else {
            if (args.length < 2) refuse(`you are at ${fmt(pop.x[i])} ${fmt(pop.y[i])}, in a world ${world.width} × ${world.height}`);
            x = numberArg(args[0], 'x');
            y = numberArg(args[1], 'y');
        }
        x = wrapMod(x, world.width);
        y = wrapMod(y, world.height);
        if (world.terrain !== null && world.terrain.blocked(x, y)) refuse(`${fmt(x)} ${fmt(y)} is water or a cliff`);
        pop.x[i] = x;
        pop.y[i] = y;
        if (f.player) {
            // The page jumps its body here (player.snap), as when a move is
            // turned down; inputs from before are turned down too.
            const pl = world.player;
            pl.snap = true;
            pl.input = null;
            pl.lastStep = world.time;
            pl.x = x;
            pl.y = y;
        }
        return `you are at ${fmt(x)} ${fmt(y)}`;
    },

    skip(world, args, msg, sim) {
        const n = numberArg(args[0], 'steps');
        if (!Number.isInteger(n) || n < 1 || n > MAX_SKIP) refuse(`from 1 to ${MAX_SKIP} steps`);
        // Your person lives on under the AI meanwhile (autopilot), as on the map.
        const pl = world.player;
        const byHand = pl !== null && pl.id !== 0 && !pl.auto;
        if (byHand) applyAct(world, { action: 'auto', on: true });
        const t0 = world.time;
        const began = performance.now();
        for (let k = 0; k < n; k++) {
            if (sim) sim.step();
            else world.step();
        }
        if (byHand && world.player === pl && pl.id !== 0 && pl.auto) applyAct(world, { action: 'auto', on: false });
        if (sim) {
            // As after Sim.run: the clock starts afresh, and the next snapshot
            // draws nobody gliding from where they were before the jump.
            sim.acc = 0;
            sim.last = performance.now();
            sim.due = Math.max(sim.due, sim.last);
            for (const m of sim.packer.maps) {
                m.last.clear();
                m.before.clear();
            }
        }
        const secs = (performance.now() - began) / 1000;
        return `skipped ${world.time - t0} steps in ${secs.toFixed(1)} s: now step ${world.time}`;
    },

    set(world, args) {
        const path = args[0];
        if (!path) refuse('which parameter?');
        const before = paramAt(world.p, path);
        const value = valueFor(args.slice(1).join(' '), before);
        setParam(world.p, path, value);
        return { text: `${path}: ${show(before)} → ${show(value)}`, param: { path, value } };
    },

    get(world, args) {
        if (!args[0]) return { text: `groups: ${Object.keys(world.p).join(' ')}`, changed: false };
        const v = paramAt(world.p, args[0]);
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            return { text: Object.entries(v).map(([k, x]) => `${args[0]}.${k}: ${show(x)}`).join('\n'), changed: false };
        }
        return { text: `${args[0]}: ${show(v)}`, changed: false };
    },

    seed() {
        refuse('a new world is the page\'s to build: type it in the console');
    },

    save() {
        refuse('saves are kept by the page: type it in the console');
    },

    load() {
        refuse('saves are kept by the page: type it in the console');
    },

    clear() {
        return { text: '', changed: false };
    },

    stats(world) {
        const lines = [];
        const people = world.humans.n;
        lines.push(`step ${world.time} · seed ${world.seed} · world ${world.width} × ${world.height}`);
        lines.push(`herbivores ${world.herbivores.n} · carnivores ${world.carnivores.n} · people ${people} in ${world.tribes.length} tribe${world.tribes.length === 1 ? '' : 's'}`);
        for (const t of [...world.tribes].sort((a, b) => b.members - a.members)) {
            const mats = world.itemsOn ? `, wood ${fmt(t.wood)}, flint ${fmt(t.flint)}, hide ${fmt(t.hide)}` : '';
            lines.push(`  ${t.name}: ${t.members} (${t.adults} adults) · food ${fmt(t.store)}${mats}`);
        }
        if (!world.itemsOn) {
            lines.push('items: off');
            return { text: lines.join('\n'), changed: false };
        }
        const by = ITEM_KINDS.map(() => [0, 0, 0]);
        let lying = 0;
        const legends = [];
        for (const item of world.items.values()) {
            by[item.kind][item.rarity]++;
            if (item.bearer === 0) lying++;
            if (item.rarity === 2) legends.push(item);
        }
        const parts = [];
        for (let k = 1; k < ITEM_KINDS.length; k++) {
            const [n, r, l] = by[k];
            if (!n && !r && !l) continue;
            const extra = [r ? `${r} rare` : '', l ? `${l} legendary` : ''].filter(Boolean).join(', ');
            parts.push(`${ITEM_KINDS[k]} ${n + r + l}${extra ? ` (${extra})` : ''}`);
        }
        lines.push(`items ${world.items.size}${lying ? ` (${lying} lying about)` : ''}: ${parts.join(' · ') || 'none'}`);
        lines.push(`legends ${legends.length}${legends.length ? ':' : ''}`);
        for (const item of legends.sort((a, b) => b.legend.time - a.legend.time).slice(0, 12)) {
            const k = item.bearer ? livingIndexOf(world.humans, item.bearer) : -1;
            const bearer = k >= 0 ? who(world, { kind: 'human', pop: world.humans, i: k }) : 'lying about';
            lines.push(`  ${item.legend.name}, a ${kindName(item)} (${item.legend.deed}) · ${bearer} · ${item.kills} kills`);
        }
        if (legends.length > 12) lines.push(`  and ${legends.length - 12} more`);
        return { text: lines.join('\n'), changed: false };
    },
};

// ---- Immortal (world.js's hooks; only while world.immortal is set) -------------------------

// Would individual i of `pop` die of `cause`? Not if it is the immortal
// player: its life stays where it was (old age: another year). True if
// spared.
export function spared(world, pop, i, cause) {
    const pl = world.player;
    if (pop !== world.humans || !pl.id || pop.id[i] !== pl.id) return false;
    if (cause === 'old age') {
        pop.lifespan[i] = pop.age[i] + yearOf(world.p.human.maturity);
        return true;
    }
    const im = world.immortal;
    const life = im.id === pl.id && im.life > 0 ? im.life : world.p.human.maxEnergy;
    if (!(pop.energy[i] >= life)) pop.energy[i] = life;
    return true;
}

// At the end of each step: the immortal player's life does not fall (bites,
// blows, spears, hunger); it rises as it eats. (A new body starts from its own.)
export function keepLife(world) {
    const im = world.immortal;
    const id = world.player.id;
    if (!id) return;
    const pop = world.humans;
    const i = livingIndexOf(pop, id);
    if (i < 0) return;
    if (im.id === id && pop.energy[i] < im.life) pop.energy[i] = im.life;
    im.id = id;
    im.life = pop.energy[i];
}
