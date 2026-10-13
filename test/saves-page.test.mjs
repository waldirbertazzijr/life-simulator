// The page's side of saving (panel/saves.js, save-store.js, the console's
// save and load): the autosave's rules, the slots, "continue", the looks
// kept with a save, and the storage that is not there. No DOM: fakes for
// the world (the Mirror's save()), the store and localStorage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params as defaults } from '../src/config.js';
import { Saves, whoOf, looksOf, putLooks, LOOKS_KEY } from '../src/panel/saves.js';
import { SaveStore, StorageError, UNAVAILABLE } from '../src/save-store.js';
import { Console } from '../src/play/console.js';
import { SAVE_VERSION } from '../src/save.js';

// The store, in memory (as save-store.js keeps it: a summary, and the data).
class FakeStore {
    constructor() {
        this.kept = new Map();
        this.writes = 0;
    }

    async list() {
        return new Map([...this.kept].map(([slot, { data, ...summary }]) => [slot, summary]));
    }

    async get(slot) {
        return this.kept.get(slot) ?? null;
    }

    async put(record) {
        this.writes++;
        this.kept.set(record.slot, record);
    }

    async remove(slot) {
        this.kept.delete(slot);
    }

    async move(from, to) {
        const r = this.kept.get(from);
        if (!r) return;
        this.kept.set(to, { ...r, slot: to });
        this.kept.delete(from);
    }
}

// A world that saves: its time, its calendar, and save() as the Mirror's.
function fakeWorld() {
    const w = {
        p: structuredClone(defaults), time: 0, seed: 7, saves: 0,
        async save(slot) {
            w.saves++;
            return { slot, ms: 1, bytes: 1000, data: { version: SAVE_VERSION, meta: { time: w.time, seed: w.seed, date: 'Spring · day 1 · year 1', player: null } } };
        },
    };
    return w;
}

function saves(more = {}) {
    const world = fakeWorld();
    const store = new FakeStore();
    const env = {
        world, store, run: 'a', playingNow: false, resumed: [], paused: false,
        record: () => ({ run: env.run, speed: 1 }),
        resume: (kept) => env.resumed.push(kept),
        playing: () => env.playingNow,
        getPaused: () => env.paused,
        setPaused: (p) => {
            env.paused = p;
        },
        ...more,
    };
    return { s: new Saves(env), env, world, store };
}

const DAY = defaults.calendar.day;

test('the autosave comes at dawn, once a day, and not twice for one moment', async () => {
    const { s, world, store } = saves();
    world.time = 10;
    s.tick(0);
    assert.equal(world.saves, 0, 'not on the first look');
    world.time = DAY - 1;
    s.tick(1000);
    assert.equal(world.saves, 0);
    world.time = DAY + 2; // dawn
    s.tick(20000);
    await new Promise((r) => setImmediate(r));
    assert.equal(world.saves, 1);
    assert.equal(store.kept.get('auto').meta.time, DAY + 2);
    world.time = DAY + 50;
    s.tick(25000);
    assert.equal(world.saves, 1, 'the same day');
    // The next dawn, too soon after (at 256× a day is a second): skipped.
    world.time = 2 * DAY + 1;
    s.tick(30000);
    assert.equal(world.saves, 1);
    // Hidden at the same moment as the last autosave: nothing new to keep.
    world.time = DAY + 2;
    assert.equal(await s.autosave('hidden'), false);
    world.time = DAY + 3;
    assert.equal(await s.autosave('hidden'), true);
    assert.equal(s.last.reason, 'hidden');
});

test('"continue": offered when an autosave waits, and no autosave until you play, load or save', async () => {
    const { s, env, world, store } = saves();
    await store.put({ slot: 'auto', savedAt: 1, run: 'old', version: SAVE_VERSION, meta: { time: 500, seed: 3, date: 'Summer · day 2 · year 1', player: null }, page: {}, data: {} });
    await s.start();
    assert.equal(s.offered, true);
    world.time = 99;
    assert.equal(await s.autosave('hidden'), false, 'a world only watched does not replace the game left');
    assert.equal(store.kept.get('auto').run, 'old');
    env.playingNow = true;
    s.tick(0);
    assert.equal(s.offered, false, 'playing takes the offer away');
    assert.equal(await s.autosave('heir'), true);
    // The other game's autosave is kept, one game back.
    assert.equal(store.kept.get('auto').run, 'a');
    assert.equal(store.kept.get('previous').run, 'old');
    // And the same game's next autosave simply takes its place.
    world.time = 120;
    assert.equal(await s.autosave('dawn'), true);
    assert.equal(store.kept.get('previous').run, 'old');
    assert.deepEqual(s.rows().map((r) => r.slot), ['auto', 'previous', '1', '2', '3']);
});

test('no autosave offered: none kept, nothing offered; "continue" loads it', async () => {
    const { s, env, store } = saves();
    await s.start();
    assert.equal(s.offered, false);
    await store.put({ slot: 'auto', savedAt: 1, run: 'b', version: SAVE_VERSION, meta: { time: 5, seed: 3, date: 'x', player: null }, page: { run: 'b' }, data: {} });
    const text = await s.load('auto');
    assert.match(text, /loaded autosave/);
    assert.equal(env.resumed.length, 1);
    assert.equal(env.resumed[0].page.run, 'b');
    await assert.rejects(s.load('2'), /slot 2 is empty/);
});

test('saving by hand: slots 1 to 3, the summary listed, the offer gone', async () => {
    const { s, store, world } = saves();
    s.offered = true;
    world.time = 42;
    const text = await s.save(2);
    assert.match(text, /saved to slot 2/);
    assert.equal(store.kept.get('2').meta.time, 42);
    assert.equal(store.kept.get('2').version, SAVE_VERSION);
    assert.equal(s.slots.get('2').data, undefined, 'the list keeps the summary only');
    assert.equal(s.offered, false);
    await assert.rejects(s.save('auto'), /no such slot/);
    await assert.rejects(s.save(4), /no such slot/);
});

test('overwriting and deleting ask once more', async () => {
    const { s, store } = saves();
    await s.save(1);
    await s.act('1', 'delete');
    assert.ok(store.kept.has('1'), 'asked first');
    assert.equal(s.confirming.act, 'delete');
    await s.act('1', 'delete');
    assert.ok(!store.kept.has('1'));
    await s.act('1', 'save');
    assert.ok(store.kept.has('1'), 'an empty slot saves at once');
    const writes = store.writes;
    await s.act('1', 'save');
    assert.equal(store.writes, writes, 'over a kept one: asked first');
    await s.act('1', 'save');
    assert.equal(store.writes, writes + 1);
});

test('P in a body pauses with the menu open, and closing carries on; the panel\'s does not pause', () => {
    const { s, env } = saves();
    const input = { blocked: false, clear() {}, unlock() {} };
    env.input = input;
    s.toggle(true);
    assert.equal(s.isOpen, true);
    assert.equal(env.paused, true);
    assert.equal(input.blocked, true);
    s.toggle(true);
    assert.equal(env.paused, false);
    assert.equal(input.blocked, false);
    s.open(false);
    assert.equal(env.paused, false);
    s.close();
    // Already paused: closing leaves it paused.
    env.paused = true;
    s.open(true);
    s.close();
    assert.equal(env.paused, true);
});

test('who a slot shows', () => {
    assert.equal(whoOf({ player: null }), 'God · watching');
    assert.equal(whoOf({ player: { id: 5, name: 'Tiko', tribeName: 'Neto', mode: 'play', auto: false, over: false } }), 'Tiko of the Neto · Play');
    assert.equal(whoOf({ player: { id: 5, name: 'Tiko', tribeName: 'Neto', mode: 'god', auto: true, over: false } }), 'Tiko of the Neto · God (on the map)');
    assert.equal(whoOf({ player: { id: 0, name: '', mode: 'play', over: true } }), 'Play · the line has ended');
});

test('the looks chosen go with a save, and come back over those made since', () => {
    const kept = new Map();
    const storage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) };
    storage.setItem(LOOKS_KEY, JSON.stringify([[7, [[11, { body: 1 }], [12, { hair: '#aabbcc' }]]], [9, [[1, { body: 0 }]]]]));
    const saved = looksOf(storage, 7);
    assert.deepEqual(saved, [[11, { body: 1 }], [12, { hair: '#aabbcc' }]]);
    assert.deepEqual(looksOf(storage, 8), []);
    storage.setItem(LOOKS_KEY, JSON.stringify([[7, [[11, { body: 2 }], [13, { skin: '#112233' }]]], [9, [[1, { body: 0 }]]]]));
    putLooks(storage, 7, saved);
    const all = JSON.parse(storage.getItem(LOOKS_KEY));
    assert.deepEqual(all.at(-1)[0], 7, 'the latest last');
    assert.deepEqual(new Map(all.at(-1)[1]), new Map([[11, { body: 1 }], [13, { skin: '#112233' }], [12, { hair: '#aabbcc' }]]));
    assert.deepEqual(all[0], [9, [[1, { body: 0 }]]]);
    assert.equal(looksOf(null, 7).length, 0, 'no storage: none');
});

test('no IndexedDB: every call says so plainly, and the menu shows it', async () => {
    const store = new SaveStore(null);
    await assert.rejects(store.list(), (err) => err instanceof StorageError && err.message === UNAVAILABLE);
    await assert.rejects(store.put({ slot: '1', data: {} }), StorageError);
    const { s } = saves({ store });
    await s.refresh();
    assert.equal(s.problem, UNAVAILABLE);
    await s.act('1', 'save');
    assert.match(s.status, /cannot be kept in this browser/);
    assert.equal(await s.autosave('hidden'), false);
});

test('the console: save and load are the page\'s, with their slots', async () => {
    const calls = [];
    const c = new Console({
        send: () => assert.fail('not sent to the simulation'), storage: null,
        save: async (slot) => {
            calls.push(['save', slot]);
            return `saved to slot ${slot}`;
        },
        load: async (slot) => {
            calls.push(['load', slot]);
            if (slot === '3') throw new Error('slot 3 is empty');
            return `loaded slot ${slot}`;
        },
    });
    await c.slot('save', '1', 'save [1|2|3]');
    c.submit('save 2');
    c.submit('load auto');
    c.submit('load');
    c.submit('load 3');
    c.submit('save auto');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [['save', '1'], ['save', '2'], ['load', 'auto'], ['load', '1'], ['load', '3']]);
    const text = c.lines.map((l) => `${l.kind}: ${l.text}`);
    assert.ok(text.includes('ok: loaded slot auto'));
    assert.ok(text.includes('error: slot 3 is empty'));
    assert.ok(text.includes('error: no such slot: auto (1, 2, 3)'));
});

test('the home screen: nothing is autosaved behind the title; the menu loads only; a game saved lately is not "unsaved"', async () => {
    let home = true;
    const { s, world, store } = saves({ quiet: () => home });
    assert.equal(await s.autosave('dawn'), false, 'not behind the title');
    assert.equal(store.writes, 0);
    home = false;
    world.time = 1000;
    assert.equal(s.unsaved(), true, 'never saved');
    assert.equal(await s.autosave('home'), true);
    assert.equal(s.unsaved(), false, 'just saved');
    world.time = 1000 + 151;
    assert.equal(s.unsaved(), true, 'the world has moved on');
    s.newWorld();
    assert.equal(s.unsaved(), true);
    s.open(false, 'load');
    assert.ok(s.rows().every((r) => !r.acts.includes('save')), 'loading only');
    s.close();
    s.open(false);
    assert.ok(s.rows().some((r) => r.acts.includes('save')));
    s.close();
});
