// How people look (src/view3d/looks.js) and the character editor
// (src/play/editor.js): looks made from the id, a child's hair after its
// parent's, grey with age, the tribe's muted cloth, and the player's choices
// kept per world and person and drawn at once. No three.js, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    Looks, natural, BODIES, HAIR_STYLES, HAIR_COLOURS, SKIN_TONES, STORE_KEY, greyAt, clothOf, linear,
} from '../src/view3d/looks.js';
import { yearOf } from '../src/play/names.js';

// People's maturity (steps), and so their years (human-style: names.js).
const M = 1800;
const YEAR = yearOf(M);
import { Editor } from '../src/play/editor.js';
import { act } from '../src/play/actions.js';

// A browser's storage, in memory.
function memory(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => {
            data[k] = String(v);
        },
    };
}

// A world as the Mirror shows it: people with ids, parents and ages.
function worldOf(people, seed = 7) {
    const humans = { n: people.length, id: [], parent: [], age: [], tribe: [] };
    for (const p of people) {
        humans.id.push(p.id);
        humans.parent.push(p.parent ?? 0);
        humans.age.push(p.age ?? 1000);
        humans.tribe.push(p.tribe ?? 1);
    }
    const tribes = new Map([[1, { id: 1, name: 'Yonunu', color: '#f2c14e' }]]);
    return {
        seed, humans, tribeById: tribes, p: { human: { maturity: M } },
        find(id) {
            const i = humans.id.indexOf(id);
            return i >= 0 ? { kind: 'human', pop: humans, i } : null;
        },
    };
}

test('a look is made from the id alone: the same every time, varied across people', () => {
    for (const id of [1, 2, 77, 1234, 99999]) assert.deepEqual(natural(id), natural(id));
    const seen = { body: new Set(), style: new Set(), hair: new Set(), skin: new Set() };
    for (let id = 1; id <= 400; id++) {
        const l = natural(id);
        for (const k of Object.keys(seen)) seen[k].add(l[k]);
        assert.ok(l.body >= 0 && l.body < BODIES.length && l.style >= 0 && l.style < HAIR_STYLES.length);
        assert.ok(HAIR_COLOURS.includes(l.hair) && SKIN_TONES.includes(l.skin));
    }
    assert.equal(seen.body.size, BODIES.length, 'every body');
    assert.equal(seen.style.size, HAIR_STYLES.length, 'every hair style');
    assert.ok(seen.hair.size >= HAIR_COLOURS.length - 1 && seen.skin.size === SKIN_TONES.length, 'the palettes in use');
    // Looks (drawn) give the made look for anyone without a choice, on any visit.
    const a = new Looks(memory());
    const b = new Looks(memory());
    a.attach(worldOf([]));
    b.attach(worldOf([]));
    for (const id of [5, 6, 7]) {
        const { body, style, skin } = a.of(id);
        assert.deepEqual({ body, style, skin }, { body: b.of(id).body, style: b.of(id).style, skin: b.of(id).skin });
    }
});

test("a child's hair takes after its parent's, as the parent looks", () => {
    // Find a parent and a child born with different hair.
    let parent = 1;
    let child = 2;
    while (natural(child).hair === natural(parent).hair) child++;
    const looks = new Looks(memory());
    looks.attach(worldOf([{ id: parent }, { id: child, parent }]));
    assert.equal(looks.of(child).hair, looks.of(parent).hair, 'looked up through the Mirror\'s parent column');
    assert.equal(looks.of(child).body, natural(child).body, 'only the hair: the rest is its own');
    // Grandchildren too, down the living line, whoever is seen first.
    const fresh = new Looks(memory());
    fresh.attach(worldOf([{ id: 30 }, { id: 31, parent: 30 }, { id: 32, parent: 31 }]));
    assert.equal(fresh.of(32).hair, natural(30).hair);
    // A parent whose hair the player chose passes the choice on to children born after.
    const chosen = new Looks(memory());
    chosen.attach(worldOf([{ id: parent }, { id: child, parent }]));
    chosen.of(parent);
    chosen.choose(parent, { hair: '#8b3f23' });
    assert.equal(chosen.of(child, parent).hair, '#8b3f23');
    // A parent long dead (not in the world): its hair as made.
    const orphan = new Looks(memory());
    orphan.attach(worldOf([{ id: child, parent: 9999 }]));
    assert.equal(orphan.of(child).hair, natural(9999).hair);
});

test('grey creeps in with age: none young, most of it for elders', () => {
    assert.equal(greyAt(10 * YEAR, M), 0);
    assert.ok(greyAt(50 * YEAR, M) > 0.1 && greyAt(50 * YEAR, M) < 0.8);
    assert.ok(greyAt(70 * YEAR, M) > 0.8);
    const looks = new Looks(memory());
    looks.attach(worldOf([{ id: 3 }]));
    const look = looks.of(3);
    const young = looks.hairAt(look, 10 * YEAR, M, [0, 0, 0]);
    const old = looks.hairAt(look, 70 * YEAR, M, [0, 0, 0]);
    assert.deepEqual(young, look.hairRgb.map((c) => c));
    const grey = linear('#bdb8b0');
    assert.ok(old.every((c, k) => Math.abs(c - grey[k]) < Math.abs(look.hairRgb[k] - grey[k]) + 1e-9), 'nearer grey');
});

test("clothes are dyed in the tribe's colour, muted", () => {
    const hsv = (rgb) => {
        const max = Math.max(...rgb);
        const min = Math.min(...rgb);
        return { sat: max ? (max - min) / max : 0, max };
    };
    for (const hex of ['#4a90e2', '#f2c14e', '#e86fb0', '#2ec4b6']) {
        const tribe = linear(hex);
        const cloth = clothOf(hex);
        assert.ok(hsv(cloth).sat < hsv(tribe).sat, `${hex}: less saturated`);
        assert.ok(hsv(cloth).max < hsv(tribe).max, `${hex}: darker`);
        // The same hue: the strongest channel stays the strongest.
        assert.equal(cloth.indexOf(Math.max(...cloth)), tribe.indexOf(Math.max(...tribe)), `${hex}: its hue kept`);
    }
});

test("the player's choices are kept per world and person, and drawn at once", () => {
    const storage = memory();
    const looks = new Looks(storage);
    looks.attach(worldOf([{ id: 5 }], 7));
    const before = looks.of(5);
    const style = (before.style + 1) % HAIR_STYLES.length;
    looks.choose(5, { style, hair: '#45301f', skin: '#714b34', body: 2 });
    // Drawn at once: the same look object the renderer holds.
    assert.equal(before.style, style);
    assert.equal(before.body, 2);
    assert.deepEqual(before.skinRgb, linear('#714b34'));
    // Kept: another visit reads it back, for this world only.
    assert.ok(storage.data[STORE_KEY].includes('#714b34'));
    const again = new Looks(storage);
    again.attach(worldOf([{ id: 5 }], 7));
    assert.deepEqual(again.chosen(5), { style, hair: '#45301f', skin: '#714b34', body: 2 });
    assert.equal(again.of(5).body, 2);
    const other = new Looks(storage);
    other.attach(worldOf([{ id: 5 }], 8));
    assert.equal(other.chosen(5), null, 'another world: its own people');
    // A choice of one thing keeps the others; nonsense is refused.
    again.choose(5, { hair: '#1c1714', body: 9, style: 'x', skin: 'red' });
    assert.deepEqual(again.chosen(5), { style, hair: '#1c1714', skin: '#714b34', body: 2 });
    // Back to the look made for them.
    again.choose(5, null);
    assert.equal(again.chosen(5), null);
    assert.equal(again.of(5).body, natural(5).body);
    // Unreadable or refused storage: a fresh start, no throw.
    const broken = new Looks({ getItem: () => '{nope', setItem: () => { throw new Error('full'); } });
    broken.attach(worldOf([{ id: 5 }]));
    broken.choose(5, { body: 1 });
    assert.equal(broken.of(5).body, 1, 'the choice holds for this visit');
});

test('the editor: opens for a person, blocks the keys, keeps each pick, closes', () => {
    const storage = memory();
    const looks = new Looks(storage);
    const world = worldOf([{ id: 11, age: 3000 }]);
    looks.attach(world);
    const input = { blocked: false, cleared: 0, clear() { this.cleared++; }, unlock() {} };
    const editor = new Editor({ looks, world, input });
    assert.equal(editor.open(0), false, 'nobody: nothing to edit');
    assert.ok(editor.open(11));
    assert.ok(editor.isOpen && input.blocked, 'while open, keys are not the body\'s');
    editor.pick('body', 1);
    editor.pick('style', HAIR_STYLES.indexOf('braids'));
    editor.pick('hair', HAIR_COLOURS[4]);
    editor.pick('skin', SKIN_TONES[1]);
    assert.deepEqual(looks.chosen(11), { body: 1, style: HAIR_STYLES.indexOf('braids'), hair: HAIR_COLOURS[4], skin: SKIN_TONES[1] });
    assert.equal(looks.of(11).style, HAIR_STYLES.indexOf('braids'), 'drawn at once');
    const shown = editor.person();
    assert.deepEqual(shown.cloth, clothOf('#f2c14e'), 'the preview wears the tribe\'s colours');
    assert.equal(shown.tribeName, 'Yonunu');
    editor.reset();
    assert.equal(looks.chosen(11), null, 'as born');
    editor.close();
    assert.ok(!editor.isOpen && !input.blocked);
    editor.pick('body', 2);
    assert.equal(looks.chosen(11), null, 'closed: no picks');
});

test('L opens the editor for your person, in a body or on the map; never while dying', () => {
    const opened = [];
    const m = { self: 4, dying: null, inBody: false, env: { editLook: (id) => opened.push(id) } };
    act(m, 'look');
    m.inBody = true;
    act(m, 'look');
    m.dying = { t: 1 };
    act(m, 'look');
    m.dying = null;
    m.self = 0;
    act(m, 'look');
    assert.deepEqual(opened, [4, 4]);
});
