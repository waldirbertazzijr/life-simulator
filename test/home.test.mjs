// The home screen and onboarding (spec §14), the pure parts: the world in
// words (culture, land, traits) and the cards made from a world, the home
// menu, the first-steps hints and what the browser keeps of them, the held
// dawn and the home screen's camera work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params as defaults } from '../src/config.js';
import { World } from '../src/world.js';
import { BIOME } from '../src/terrain.js';
import { cultureWords, landText, landOf, landWords, traitWords, tribeCards, adultCards, deedsText, LAND } from '../src/home/words.js';
import { HINTS, HINT, HINTS_KEY, HintStore, Hints, partsOf } from '../src/home/hints.js';
import { homeMenu, continueText, PROMISE } from '../src/home/home.js';
import { heldDawn, DAWN } from '../src/view3d/almanac.js';
import { when } from '../src/calendar.js';
import { Cinema, ease, valleyOf, SHOTS } from '../src/view3d/cinema.js';
import { mostExperienced } from '../src/play/modes.js';

const world = new World(defaults, { seed: 7, aspect: 1.6 });

// ---- Words ----

test('culture in words: how readily they fight, and how close they keep', () => {
    assert.equal(cultureWords(0.9, 0.9), 'fierce, close-knit');
    assert.equal(cultureWords(0.1, 0.1), 'peaceful, independent');
    assert.equal(cultureWords(0.5, 0.5), 'bold, neighbourly');
    assert.equal(cultureWords(0, 1), 'peaceful, close-knit');
});

test('the land in words: the water, then the place, first that fits', () => {
    const flat = { water: Infinity, wet: 0, own: BIOME.MEADOW, rise: 0, below: 0, forest: 0, marsh: 0, steppe: 0, peak: 0.3 };
    assert.equal(landText(flat), 'in the meadows');
    assert.equal(landText({ ...flat, water: 60, wet: 0.12 }), 'by a lake, in the meadows');
    assert.equal(landText({ ...flat, water: 30, wet: 0.12 }), 'on a lakeshore, in the meadows');
    assert.equal(landText({ ...flat, water: 60, wet: 0.3 }), 'by a wide lake, in the meadows');
    assert.equal(landText({ ...flat, water: 60, wet: 0.02 }), 'by a small lake, in the meadows');
    assert.equal(landText({ ...flat, own: BIOME.FOREST, rise: 0.2 }), 'on a forested hillside');
    assert.equal(landText({ ...flat, below: 0.2, forest: 0.5 }), 'in a green valley', 'a valley before the forest\'s edge');
    assert.equal(landText({ ...flat, forest: LAND.edge }), "at the forest's edge");
    assert.equal(landText({ ...flat, own: BIOME.FOREST, forest: 0.6 }), 'in the forest', 'no edge to a forest from inside it');
    assert.equal(landText({ ...flat, marsh: 0.5 }), 'near the marshes');
    assert.equal(landText({ ...flat, steppe: 0.3 }), 'where the steppe begins');
    assert.equal(landText({ ...flat, peak: 0.9 }), 'under the mountains');
    assert.equal(landText(null), '');
});

test('a real camp reads the same every time, and the flat world reads nothing', () => {
    const t = world.tribes[0];
    const a = landWords(world.terrain, t.camp.x, t.camp.y);
    assert.ok(a.length > 5, a);
    assert.equal(landWords(world.terrain, t.camp.x, t.camp.y), a);
    assert.equal(landWords(null, 0, 0), '');
    const land = landOf(world.terrain, t.camp.x, t.camp.y);
    for (const k of ['wet', 'rise', 'forest', 'marsh', 'steppe']) assert.ok(land[k] >= 0 && land[k] <= 1, `${k} ${land[k]}`);
});

test('traits in words from the genes', () => {
    assert.deepEqual(traitWords(1.1, 1.1), ['swift', 'keen-eyed']);
    assert.deepEqual(traitWords(0.9, 1.0), ['slow-footed']);
    assert.deepEqual(traitWords(1.0, 0.9), ['short-sighted']);
    assert.deepEqual(traitWords(1.02, 0.98), ['steady']);
    assert.equal(deedsText(0, 0), 'no kills · no children');
    assert.equal(deedsText(1, 1), '1 kill · 1 child');
    assert.equal(deedsText(3, 2), '3 kills · 2 children');
});

test('tribe cards: up to four living tribes with adults, biggest first, unlike each other', () => {
    const cards = tribeCards(world);
    assert.equal(cards.length, 4);
    assert.equal(new Set(cards.map((c) => c.id)).size, 4);
    for (let k = 1; k < cards.length; k++) assert.ok(cards[k - 1].members >= cards[k].members);
    for (const c of cards) {
        const t = world.tribeById.get(c.id);
        assert.equal(c.name, t.name);
        assert.equal(c.culture, cultureWords(t.aggression, t.sociality));
        assert.ok(c.adults > 0 && c.members >= c.adults);
        assert.ok(c.land.length > 0);
        assert.deepEqual(c.camp, { x: t.camp.x, y: t.camp.y });
    }
    // The four most unlike of the biggest: not all the same culture.
    assert.ok(new Set(cards.map((c) => c.culture)).size >= 3);
    assert.equal(tribeCards(world, 3).length, 3);
});

test('adult cards: every adult of the tribe, the most experienced first and suggested', () => {
    const t = world.tribes[1];
    const cards = adultCards(world, t.id);
    const pop = world.humans;
    let adults = 0;
    for (let i = 0; i < pop.n; i++) if (pop.tribe[i] === t.id && pop.age[i] >= world.p.human.maturity) adults++;
    assert.equal(cards.length, adults);
    assert.equal(cards[0].id, mostExperienced(world, t.id));
    assert.equal(cards[0].suggested, true);
    assert.equal(cards.filter((c) => c.suggested).length, 1);
    for (const c of cards) {
        assert.ok(c.years >= 16, `${c.name} is ${c.years}`);
        assert.ok(c.traits.length >= 1);
        assert.equal(typeof c.name, 'string');
    }
});

// ---- The home menu ----

test('the menu: Continue only with an autosave; Begin a life only where it can be lived', () => {
    const ids = (items) => items.map((it) => it.id);
    assert.deepEqual(ids(homeMenu()), ['begin', 'oversee', 'load', 'settings', 'credits']);
    const auto = { meta: { date: 'Spring · day 3 · year 1', player: { id: 5, name: 'Tiko', tribeName: 'Neto', mode: 'play' } } };
    const items = homeMenu({ autosave: auto });
    assert.deepEqual(ids(items), ['continue', 'begin', 'oversee', 'load', 'settings', 'credits']);
    assert.equal(items[0].sub, 'Tiko of the Neto · Spring · day 3 · year 1');
    const touch = homeMenu({ canPlay: false, why: 'it needs a keyboard and a mouse' });
    assert.equal(touch[0].disabled, true);
    assert.equal(touch[0].sub, 'it needs a keyboard and a mouse');
    assert.equal(continueText({ date: 'Summer · day 1 · year 2', player: null }), 'watching the world · Summer · day 1 · year 2');
    assert.equal(PROMISE.at(-1), 'You will die. Your line goes on.');
});

// ---- Hints ----

// localStorage, in memory (or refusing everything).
function memory(refuse = false) {
    const kept = new Map();
    return {
        kept,
        getItem(k) {
            if (refuse) throw new Error('refused');
            return kept.get(k) ?? null;
        },
        setItem(k, v) {
            if (refuse) throw new Error('refused');
            kept.set(k, String(v));
        },
    };
}

// A frame's facts, in a body doing nothing.
const idle = (more = {}) => ({
    inBody: true, moving: false, running: false, yaw: 0, can: null, doing: null, carry: 0, life: 1, armed: true, prey: false,
    evening: false, asleep: false, resting: false, atCamp: false, camp: 300, items: true, crafting: false, ...more,
});

// Run `seconds` of frames of `dt`, the facts from `facts(t)`.
function frames(h, seconds, facts, dt = 0.1) {
    for (let t = 0; t < seconds; t += dt) h.update(facts(t), dt);
}

test('a hint is text with keys in braces', () => {
    assert.deepEqual(partsOf('Hold {Shift} or {Space} to run'), ['Hold ', { key: 'Shift' }, ' or ', { key: 'Space' }, ' to run']);
    assert.deepEqual(partsOf('{W}{A}'), [{ key: 'W' }, { key: 'A' }]);
    for (const h of HINTS) assert.ok(partsOf(h.text).some((p) => p.key), h.id);
    const ids = HINTS.map((h) => h.id);
    for (const id of ['walk', 'run', 'gather', 'throw', 'eat', 'store', 'sleep', 'craft', 'call']) assert.ok(ids.includes(id), id);
});

test('first steps: walking first, once the camera settles; it fades once done; a breath, then the next that matters', () => {
    const store = new HintStore(memory());
    const h = new Hints(store);
    frames(h, HINT.first - 0.3, () => idle());
    assert.equal(h.current, null, 'not before the camera settles');
    frames(h, 0.5, () => idle());
    assert.equal(h.shown?.id, 'walk');
    assert.ok(store.seen.has('walk'));
    // Walking and looking around: done.
    let yaw = 0;
    frames(h, 3, () => idle({ moving: true, yaw: (yaw += 0.05) }));
    assert.equal(h.current, null);
    // Still walking: the run hint, after a breath.
    frames(h, HINT.gap + 0.3, () => idle({ moving: true, yaw }));
    assert.equal(h.shown?.id, 'run');
    frames(h, 1.5, () => idle({ moving: true, running: true, yaw }));
    assert.equal(h.current, null, 'run done');
    // Night falls: sleep, before anything else.
    frames(h, HINT.gap + 0.3, () => idle({ evening: true, can: 'gather', yaw }));
    assert.equal(h.shown?.id, 'sleep');
    frames(h, 0.3, () => idle({ evening: true, asleep: true, yaw }));
    assert.equal(h.current, null, 'asleep: done');
    // On good grass: gather.
    frames(h, HINT.gap + 0.3, () => idle({ can: 'gather', yaw }));
    assert.equal(h.shown?.id, 'gather');
});

test('acts end their hints (throw, eat, store, call), a hint done before it was needed is never shown, and none stays past its time', () => {
    const store = new HintStore(memory());
    store.seen = new Set(['walk', 'run', 'sleep', 'gather']);
    const h = new Hints(store);
    frames(h, 2, () => idle({ prey: true }));
    assert.equal(h.shown?.id, 'throw');
    h.event({ type: 'throw', id: 9 }, 9, 1);
    frames(h, 0.2, () => idle({ prey: true }));
    assert.equal(h.current, null);
    // Eaten before the hint came: not needed.
    h.event({ type: 'eat', id: 9 }, 9, 1);
    frames(h, HINT.gap + 0.5, () => idle({ carry: 4, life: 0.5 }));
    assert.ok(store.seen.has('eat'));
    assert.notEqual(h.current?.id, 'eat');
    // Carrying food near camp: store, until the hint's time is up.
    const fresh = new Hints(Object.assign(new HintStore(memory()), { seen: new Set(['walk', 'run', 'sleep', 'gather', 'throw', 'eat']) }));
    frames(fresh, 2, () => idle({ carry: 8, camp: 50 }));
    assert.equal(fresh.shown?.id, 'store');
    frames(fresh, HINT.most + 0.5, () => idle({ carry: 8, camp: 50 }));
    assert.notEqual(fresh.current?.id, 'store');
    // Someone else's acts end nothing; a call to your tribe ends the call hint.
    const h2 = new Hints(new HintStore(memory()));
    h2.event({ type: 'store', id: 4 }, 9, 1);
    h2.event({ type: 'call', tribe: 2 }, 9, 1);
    assert.equal(h2.did.size, 0);
    h2.event({ type: 'call', tribe: 1 }, 9, 1);
    assert.ok(h2.did.has('call'));
});

test('hints off show nothing; out of a body, none shows; what was seen is kept, and can be seen again', () => {
    const storage = memory();
    const store = new HintStore(storage);
    store.setOn(false);
    const h = new Hints(store);
    frames(h, 5, () => idle());
    assert.equal(h.current, null);
    assert.equal(store.seen.size, 0);
    store.setOn(true);
    frames(h, 5, () => idle());
    assert.equal(h.shown?.id, 'walk');
    frames(h, 0.1, () => ({ inBody: false }));
    assert.equal(h.current, null, 'leaving the body puts it away');
    // Remembered by the browser.
    const again = new HintStore(storage);
    assert.equal(again.on, true);
    assert.ok(again.seen.has('walk'));
    assert.deepEqual(JSON.parse(storage.kept.get(HINTS_KEY)), { on: true, seen: ['walk'] });
    again.again();
    assert.equal(new HintStore(storage).seen.size, 0);
    // Storage refused, or holding nonsense: on, nothing seen, nothing thrown.
    const refused = new HintStore(memory(true));
    assert.equal(refused.on, true);
    refused.see('walk');
    refused.setOn(false);
    assert.equal(refused.on, false);
    const junk = memory();
    junk.kept.set(HINTS_KEY, '{oops');
    assert.equal(new HintStore(junk).on, true);
    assert.equal(new HintStore(null).on, true);
});

// ---- The dawn, and the camera ----

test('the home screen holds a slow dawn, whatever the hour', () => {
    const c = defaults.calendar;
    const opened = 3 * c.day + 2000; // (an afternoon)
    const start = heldDawn(c, opened, opened);
    assert.equal(when(c, start).part, 'dawn');
    assert.equal(when(c, start).day, 3);
    const later = heldDawn(c, opened, opened + 300);
    assert.ok(later > start && later - start < 300 * DAWN.pace + 1e-9, 'slower than the world');
    const held = heldDawn(c, opened, opened + 1e6);
    assert.equal(held, 3 * c.day + c.dawn * DAWN.to);
    assert.equal(when(c, held).part, 'dawn');
    assert.ok(when(c, held).sun.alt > 0, 'the sun is up by then');
});

function fakeRig() {
    return { W: 2000, H: 1200, map: { fx: 1000, fz: 600, yaw: -Math.PI / 2, pitch: 0.9, dist: 1500, fit: 1500, track: true }, pointers: new Map(), keys: { any: false } };
}

test('a flight eases from where the camera is to the shot, rising when far; the overview lets go once there', () => {
    assert.equal(ease(0), 0);
    assert.equal(ease(1), 1);
    assert.equal(ease(0.5), 0.5);
    const rig = fakeRig();
    const c = new Cinema(rig);
    c.fly(c.camp(100, 100, 0), 2);
    c.update(1);
    assert.ok(rig.map.dist > SHOTS.camp.dist * 2, 'risen mid-flight');
    assert.equal(rig.map.track, false);
    c.update(1.01);
    const S = SHOTS.camp;
    assert.ok(Math.abs(rig.map.dist - S.dist) < 1e-6);
    assert.ok(Math.abs(rig.map.pitch - S.pitch) < 1e-9);
    // Arrived: the camp is ahead of the point looked at (above the cards), circling slowly.
    assert.ok(rig.map.fx < 100);
    c.update(10);
    assert.ok(Math.abs(rig.map.yaw - S.turn * 12.01) < 1e-6);
    // The overview: the whole world, and then the map is the user's.
    c.fly(c.overview(), 1, true);
    c.update(1.2);
    assert.equal(rig.map.dist, rig.map.fit);
    assert.equal(c.active, false);
    // A hand on the map ends a last flight at once.
    c.fly(c.overview(), 3, true);
    rig.keys.any = true;
    c.update(0.1);
    assert.equal(c.active, false);
});

test('the dawn is filmed over the camp lying deepest in its valley', () => {
    const camps = [
        { camp: { x: 1, y: 1 }, land: { below: 0.05, wet: 0.1, forest: 0 } },
        { camp: { x: 2, y: 2 }, land: { below: 0.2, wet: 0.1, forest: 0 } },
        { camp: { x: 3, y: 3 }, land: null },
    ];
    assert.equal(valleyOf(camps).camp.x, 2);
    assert.equal(valleyOf([]), null);
    const rig = fakeRig();
    const c = new Cinema(rig);
    c.cut(c.dawn(500, 400, -0.3));
    c.update(0.016);
    assert.ok(Math.abs(rig.map.fx - 500) < SHOTS.dawn.wander + 1);
    assert.ok(Math.abs(rig.map.yaw + 0.3) <= SHOTS.dawn.sway + 1e-9);
});
