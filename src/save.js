// Saving a whole world, and building it again from the save (the worker's
// side of the save system; the page keeps the saves: save-store.js, and
// shows them: panel/saves.js).
//
// A save is a plain object, cheap to post between threads and to keep in
// IndexedDB:
//
//   format, version   SAVE_FORMAT and SAVE_VERSION (see below)
//   meta              what a slot shows without loading it: the date by
//                     the calendar, the seed, the step, the person played
//                     and its tribe, the counts (saveMeta)
//   json              everything that changes over time but the big
//                     arrays, as a JSON string (see "The state" below)
//   bins              the big arrays as they are, binary: each species'
//                     columns (one Float64Array of every float column,
//                     n values each, and one Int32Array of the int ones),
//                     and the grass
//
// What is not saved is built again: new World(params, {seed, aspect}) makes
// the same land, biomes and grass grid from the seed (the world's own
// parameters as it was made: `world.origin`, which sim.js records), and
// loadWorld then puts back everything that has changed since, and rebuilds
// what follows from it: the spatial hashes, tribeById, and the path fields
// (a camp's, a spot's, a Hunt here order's way by land: Terrain.pathField of
// where it is, the same numbers for the same place).
//
// The state. Every field of the World is saved, but those built again (the
// land, the hashes, ...: APART) and those saved apart (the populations, the
// spears, the grass, the random stream, the parameters). The rest goes
// through enc(), which keeps plain objects, arrays, Maps and Sets (in their
// order: the order things are stepped in is behaviour), typed arrays, and
// numbers JSON cannot say (Infinity: a legend's wear; NaN; −0), so a new
// field of plain data is saved without a line here; a field of some other
// class is refused, loudly (the tests save every kind of world), until it
// is given its place below.
//
// The test that matters (test/save.test.mjs): a world run N steps, saved,
// loaded and run M more is the very world run N + M steps, to the bit, for
// several seeds, with items on and off, with a person played mid-hunt, a
// rally under way and an item being made.
//
// SAVE_VERSION. A save from another version is refused with a clear message
// (SaveError), never half loaded: everything is checked before anything is
// built, and loadWorld returns a new World or throws. Bump it whenever what
// a World holds, or what its fields mean, changes (and the populations'
// columns, which are checked by name besides).
import { World, worldSize } from './world.js';
import { params as DEFAULTS } from './config.js';
import { Population } from './population.js';
import { Spears } from './spears.js';
import { dateLabel } from './calendar.js';
import { personName } from './play/names.js';
import { livingIndexOf } from './util.js';

export const SAVE_FORMAT = 'life-simulator-save';
export const SAVE_VERSION = 2;

const KINDS = ['herbivore', 'carnivore', 'human'];
const POP = { herbivore: 'herbivores', carnivore: 'carnivores', human: 'humans' };

// World fields saved apart, or built again rather than saved.
const APART = new Set([
    'p', 'origin', 'seed', 'width', 'height', 'rng', 'events',
    'herbivores', 'carnivores', 'humans', 'spears', 'grass',
    'terrain', 'lowland', 'hidden', 'herbivoreHash', 'carnivoreHash', 'humanHash', 'tribeById',
    // (A cache, World.stepHerbivores: headings with their cos and sin. A new
    // world's is empty, which changes nothing but how soon they are known.)
    'facing', 'facingCos', 'facingSin',
    // (The snow underfoot, cold.js: worked out again from the time at the next step.)
    'snowPace', 'snowAt', 'snowLine',
]);

// A save that cannot be loaded: the message says why, for the player.
export class SaveError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SaveError';
    }
}

// ---- Saving ----------------------------------------------------------------------------

// The whole world, as a save (see above). It leaves the world as it was:
// nothing is drawn from the random stream, nothing moves.
export function saveWorld(world) {
    const origin = world.origin ?? { params: world.p, aspect: aspectOf(world, world.p) };
    const bins = {};
    const pops = {};
    for (const kind of KINDS) {
        const pop = world[POP[kind]];
        const { floats, ints } = columnsOf(pop);
        const n = pop.n;
        const f = new Float64Array(n * floats.length);
        floats.forEach((c, k) => f.set(pop[c].subarray(0, n), k * n));
        const i = new Int32Array(n * ints.length);
        ints.forEach((c, k) => i.set(pop[c].subarray(0, n), k * n));
        bins[kind] = f;
        bins[`${kind}Ints`] = i;
        pops[kind] = { n, capacity: pop.capacity, floats, ints };
    }
    bins.grass = world.grass.g.slice();
    const rest = {};
    for (const k of Object.keys(world)) if (!APART.has(k)) rest[k] = enc(world[k], k);
    const state = {
        seed: world.seed,
        aspect: origin.aspect,
        width: world.width,
        height: world.height,
        origin: enc(origin.params, 'origin'),
        params: enc(world.p, 'p'),
        rng: enc(world.rng.state(), 'rng'),
        grass: { level: enc(world.grass.level, 'grass.level') },
        pops,
        spears: spearsOut(world.spears),
        world: rest,
    };
    return { format: SAVE_FORMAT, version: SAVE_VERSION, meta: saveMeta(world), json: JSON.stringify(state), bins };
}

// What a slot shows of a save, without loading it.
export function saveMeta(world) {
    const pl = world.player;
    const pop = world.humans;
    let player = null;
    if (pl !== null) {
        const i = pl.id ? livingIndexOf(pop, pl.id) : -1;
        const tribe = world.tribeById.get(i >= 0 ? pop.tribe[i] : pl.tribe) ?? null;
        player = {
            id: pl.id, name: pl.id ? personName(pl.id) : '', mode: pl.mode, auto: pl.auto, over: pl.over,
            tribe: tribe ? tribe.id : 0, tribeName: tribe ? tribe.name : '',
        };
    }
    return {
        time: world.time,
        seed: world.seed,
        date: dateLabel(world.p.calendar, world.time),
        player,
        counts: { herbivores: world.herbivores.n, carnivores: world.carnivores.n, humans: world.humans.n, tribes: world.tribes.length },
    };
}

// How many bytes a save takes (its arrays and its JSON, as UTF-16 counts it: near enough).
export function saveSize(data) {
    let bytes = data.json.length;
    for (const a of Object.values(data.bins)) bytes += a.byteLength;
    return bytes;
}

// The buffers a save's arrays live in, to transfer rather than copy them.
export const transferOf = (data) => Object.values(data.bins).map((a) => a.buffer);

// A population's columns by name, in their order: the float ones and the int ones.
function columnsOf(pop) {
    const floats = [];
    const ints = [];
    for (const k of Object.keys(pop)) {
        const a = pop[k];
        if (!pop.columns.includes(a)) continue;
        if (a instanceof Float64Array) floats.push(k);
        else if (a instanceof Int32Array) ints.push(k);
        else throw new Error(`cannot save the column ${k}: a ${a.constructor.name}`);
    }
    if (floats.length + ints.length !== pop.columns.length) throw new Error('cannot save a population: unnamed columns');
    return { floats, ints };
}

// The spears in flight: each field's first n values.
function spearsOut(S) {
    const fields = {};
    for (const k of Object.keys(S)) if (S[k] instanceof Float64Array) fields[k] = Array.from(S[k].subarray(0, S.n), encNumber);
    return { n: S.n, capacity: S.capacity, fields };
}

// The aspect a world was made with, when it was not recorded (a world made
// directly, as the tests do): any aspect that sizes the world the same
// makes the same world, and the middle of those that do is found from the
// size (worldSize rounds both sides).
function aspectOf(world, params) {
    const A = params.world.area;
    const W = world.width;
    const H = world.height;
    const lo = Math.max((W - 0.5) ** 2 / A, A / (H + 0.5) ** 2);
    const hi = Math.min((W + 0.5) ** 2 / A, A / (H - 0.5) ** 2);
    for (const a of [(lo + hi) / 2, W / H]) {
        const s = worldSize(A, a);
        if (s.width === W && s.height === H) return a;
    }
    throw new Error(`cannot save: no aspect makes a world of ${W} × ${H}`);
}

// ---- The state, as JSON ------------------------------------------------------------------

const encNumber = (v) => (Number.isFinite(v) && !Object.is(v, -0) ? v : { $n: Object.is(v, -0) ? '-0' : String(v) });
const TYPED = { Float64Array, Float32Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array, Uint8Array, Uint8ClampedArray };

// A value of the world as JSON-safe data (see the top of the file). `at`
// says where it is, for the message if it cannot be saved.
function enc(v, at) {
    switch (typeof v) {
        case 'number':
            return encNumber(v);
        case 'string':
        case 'boolean':
            return v;
        case 'undefined':
            return { $u: 1 };
        case 'object':
            break;
        default:
            throw new Error(`cannot save ${at}: a ${typeof v}`);
    }
    if (v === null) return null;
    if (Array.isArray(v)) {
        const out = new Array(v.length);
        for (let k = 0; k < v.length; k++) out[k] = enc(v[k], `${at}[${k}]`);
        return out;
    }
    if (ArrayBuffer.isView(v)) {
        const type = v.constructor.name;
        if (!TYPED[type]) throw new Error(`cannot save ${at}: a ${type}`);
        return { $ta: type, v: Array.from(v, encNumber) };
    }
    if (v instanceof Map) return { $map: [...v].map(([k, x]) => [enc(k, `${at} key`), enc(x, `${at}.${k}`)]) };
    if (v instanceof Set) return { $set: [...v].map((x) => enc(x, `${at} member`)) };
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error(`cannot save ${at}: a ${v.constructor?.name ?? 'class instance'} (give it its place in save.js)`);
    const out = {};
    for (const k of Object.keys(v)) {
        if (k[0] === '$') throw new Error(`cannot save ${at}.${k}: a key starting with $`);
        // A path field (Terrain.pathField of where it leads): built again on loading.
        if (k === 'paths' && ArrayBuffer.isView(v[k])) out[k] = { $paths: 1 };
        else out[k] = enc(v[k], `${at}.${k}`);
    }
    return out;
}

// The other way. `paths(x, y)` builds a path field again (null: none), for
// an object that had one: toward its camp if it has one (a tribe), else
// toward where it is (a spot, an order).
function dec(v, paths) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
        const out = new Array(v.length);
        for (let k = 0; k < v.length; k++) out[k] = dec(v[k], paths);
        return out;
    }
    if ('$n' in v) return Number(v.$n);
    if ('$u' in v) return undefined;
    if ('$ta' in v) return TYPED[v.$ta].from(v.v, (x) => dec(x, paths));
    if ('$map' in v) return new Map(v.$map.map(([k, x]) => [dec(k, paths), dec(x, paths)]));
    if ('$set' in v) return new Set(v.$set.map((x) => dec(x, paths)));
    const out = {};
    let path = false;
    for (const k of Object.keys(v)) {
        const x = v[k];
        if (k === 'paths' && x !== null && typeof x === 'object' && '$paths' in x) {
            out[k] = null;
            path = true;
        } else out[k] = dec(x, paths);
    }
    if (path && paths) out.paths = out.camp ? paths(out.camp.x, out.camp.y) : paths(out.x, out.y);
    return out;
}

// Set every parameter in `to` to its value in `from`, in place: the land
// and the rest keep their references into world.p (the console's `set`
// changes it live, and they see that).
// A save's params over today's defaults: a save made before a param was
// added gets the default rather than nothing (NaN). A save from today has
// every param, so nothing changes for it.
function withDefaults(p) {
    const out = structuredClone(DEFAULTS);
    assignDeep(out, p);
    return out;
}

function assignDeep(to, from) {
    for (const k of Object.keys(from)) {
        const v = from[k];
        if (v !== null && typeof v === 'object' && !Array.isArray(v) && to[k] !== null && typeof to[k] === 'object' && !Array.isArray(to[k])) assignDeep(to[k], v);
        else to[k] = v;
    }
}

// ---- Loading ----------------------------------------------------------------------------

// A save's state, checked: its format, its version, its JSON and its arrays.
// Throws a SaveError that says what is wrong.
export function readSave(data) {
    if (!data || typeof data !== 'object' || data.format !== SAVE_FORMAT) throw new SaveError('This is not a Life Simulator save.');
    if (data.version !== SAVE_VERSION) {
        throw new SaveError(`This save comes from another version of Life Simulator (save version ${data.version}; this one reads version ${SAVE_VERSION}), so it cannot be loaded.`);
    }
    let s;
    try {
        s = JSON.parse(data.json);
    } catch {
        throw new SaveError('This save is damaged: its state cannot be read.');
    }
    const bins = data.bins ?? {};
    const fresh = columnsOf(new Population(1));
    for (const kind of KINDS) {
        const d = s?.pops?.[kind];
        if (!d || !Number.isInteger(d.n) || d.n < 0) throw new SaveError(`This save is damaged: no ${kind}s.`);
        if (String(d.floats) !== String(fresh.floats) || String(d.ints) !== String(fresh.ints)) {
            throw new SaveError(`This save keeps ${kind}s another way than this version of Life Simulator, so it cannot be loaded.`);
        }
        if (!(bins[kind] instanceof Float64Array) || bins[kind].length !== d.n * d.floats.length
            || !(bins[`${kind}Ints`] instanceof Int32Array) || bins[`${kind}Ints`].length !== d.n * d.ints.length) {
            throw new SaveError(`This save is damaged: the ${kind}s do not add up.`);
        }
    }
    if (!(bins.grass instanceof Float64Array)) throw new SaveError('This save is damaged: no grass.');
    if (!s.world || !s.origin || !s.params || !s.rng || !s.spears) throw new SaveError('This save is damaged: parts are missing.');
    return s;
}

// The world of a save (see the top of the file): a new World, or a SaveError.
// `paths: false` leaves the path fields out (the page's copy, mirror.js,
// which never walks anyone anywhere).
export function loadWorld(data, { paths = true } = {}) {
    const s = readSave(data);
    const origin = withDefaults(dec(s.origin));
    const world = new World(origin, { seed: s.seed, aspect: s.aspect });
    if (world.width !== s.width || world.height !== s.height || world.grass.g.length !== data.bins.grass.length) {
        throw new SaveError('This save does not fit the world its seed makes here, so it cannot be loaded.');
    }
    world.origin = { params: withDefaults(dec(s.origin)), aspect: s.aspect };
    assignDeep(world.p, withDefaults(dec(s.params)));
    world.rng.restore(dec(s.rng));

    // The populations, each in arrays as roomy as the saved ones.
    for (const kind of KINDS) {
        const d = s.pops[kind];
        const pop = new Population(Math.max(1, d.capacity));
        const f = data.bins[kind];
        const i = data.bins[`${kind}Ints`];
        const n = d.n;
        d.floats.forEach((c, k) => pop[c].set(f.subarray(k * n, (k + 1) * n)));
        d.ints.forEach((c, k) => pop[c].set(i.subarray(k * n, (k + 1) * n)));
        pop.n = n;
        world[POP[kind]] = pop;
    }
    world.grass.g.set(data.bins.grass);
    world.grass.level = dec(s.grass.level);

    const S = new Spears(Math.max(1, s.spears.capacity));
    for (const [k, values] of Object.entries(s.spears.fields)) {
        if (!(S[k] instanceof Float64Array)) throw new SaveError('This save is damaged: its spears do not add up.');
        values.forEach((v, j) => {
            S[k][j] = dec(v);
        });
    }
    S.n = s.spears.n;
    world.spears = S;

    // Everything else, and the path fields built again (one per way cell).
    const T = world.terrain;
    let field = null;
    if (paths && T !== null) {
        const made = new Map();
        field = (x, y) => {
            const k = T.wayIndex(x, y);
            let f = made.get(k);
            if (!f) made.set(k, (f = T.pathField(x, y)));
            return f;
        };
    }
    for (const [k, v] of Object.entries(s.world)) world[k] = dec(v, field);

    // What follows from it.
    world.tribeById.clear();
    for (const t of world.tribes) world.tribeById.set(t.id, t);
    world.events.length = 0;
    world.snowAt = -1; // (the snow underfoot: built again at the next step, cold.js)
    world.snowLine = NaN;
    world.herbivoreHash.build(world.herbivores);
    world.carnivoreHash.build(world.carnivores);
    world.humanHash.build(world.humans);
    return world;
}

// ---- A save as a file (.lifesave) ------------------------------------------------------
//
// "LIFESAVE", then the header's length (4 bytes, little-endian) and the
// header (JSON: format, version, savedAt, meta, page: the page's own state,
// and the sections, each {name, type, offset, length}), then, from the next
// multiple of 8, the sections: the state's JSON (UTF-8) and each array's
// bytes (little-endian, as every machine that runs this keeps them), each
// at a multiple of 8.

const MAGIC = 'LIFESAVE';
const align = (o) => Math.ceil(o / 8) * 8;
const littleEndian = () => new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// A kept save ({data, page, meta, savedAt}) as the bytes of a file.
export function packFile(record) {
    const { data } = record;
    const text = new TextEncoder();
    const json = text.encode(data.json);
    const sections = [{ name: '$json', type: 'utf8', offset: 0, length: json.byteLength }];
    let size = align(json.byteLength);
    for (const [name, a] of Object.entries(data.bins)) {
        sections.push({ name, type: a.constructor.name, offset: size, length: a.length });
        size = align(size + a.byteLength);
    }
    const header = text.encode(JSON.stringify({
        format: data.format, version: data.version, savedAt: record.savedAt ?? Date.now(),
        meta: data.meta, page: record.page ?? null, littleEndian: littleEndian(), sections,
    }));
    const start = align(MAGIC.length + 4 + header.byteLength);
    const out = new Uint8Array(start + size);
    out.set(text.encode(MAGIC), 0);
    new DataView(out.buffer).setUint32(MAGIC.length, header.byteLength, true);
    out.set(header, MAGIC.length + 4);
    out.set(json, start);
    for (const s of sections.slice(1)) {
        const a = data.bins[s.name];
        out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), start + s.offset);
    }
    return out;
}

// The bytes of a file (an ArrayBuffer or a Uint8Array) as a kept save
// {data, page, meta, savedAt}; a SaveError if it is not one this version reads.
export function unpackFile(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const text = new TextDecoder();
    if (u8.length < MAGIC.length + 4 || text.decode(u8.subarray(0, MAGIC.length)) !== MAGIC) {
        throw new SaveError('This file is not a Life Simulator save.');
    }
    const length = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(MAGIC.length, true);
    let header;
    try {
        header = JSON.parse(text.decode(u8.subarray(MAGIC.length + 4, MAGIC.length + 4 + length)));
    } catch {
        throw new SaveError('This save file is damaged: its header cannot be read.');
    }
    if (header.format !== SAVE_FORMAT) throw new SaveError('This file is not a Life Simulator save.');
    if (header.version !== SAVE_VERSION) {
        throw new SaveError(`This save comes from another version of Life Simulator (save version ${header.version}; this one reads version ${SAVE_VERSION}), so it cannot be loaded.`);
    }
    if (header.littleEndian !== littleEndian()) throw new SaveError('This save file was made on a machine that keeps numbers the other way round.');
    const start = align(MAGIC.length + 4 + length);
    const bins = {};
    let json = null;
    for (const s of header.sections ?? []) {
        const at = u8.byteOffset + start + s.offset;
        if (s.type === 'utf8') {
            json = text.decode(u8.subarray(start + s.offset, start + s.offset + s.length));
            continue;
        }
        const Type = TYPED[s.type];
        if (!Type || at + s.length * Type.BYTES_PER_ELEMENT > u8.byteOffset + u8.byteLength) throw new SaveError('This save file is damaged: it is cut short.');
        bins[s.name] = new Type(u8.buffer.slice(at, at + s.length * Type.BYTES_PER_ELEMENT));
    }
    if (json === null) throw new SaveError('This save file is damaged: its state is missing.');
    const data = { format: header.format, version: header.version, meta: header.meta, json, bins };
    return { data, page: header.page ?? null, meta: header.meta, savedAt: header.savedAt };
}
