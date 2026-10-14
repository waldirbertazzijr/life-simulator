// The graphics setting and the light's numbers (src/view3d/graphics.js):
// the setting's defaults and how it is kept, how dark the shadows are by the
// sun's height (and the moon's), and how strong the light rays are by where
// the light stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    QUALITIES, PRESETS, GRAPHICS_KEY, defaultQuality, phoneLike, loadQuality, saveQuality,
    initQuality, getQuality, setQuality, onQuality, shadowStrength, rayStrength, SUN_LIGHT_MIN,
} from '../src/view3d/graphics.js';
import { daylight } from '../src/view3d/daylight.js';

const DEG = Math.PI / 180;

// A browser's storage, as localStorage behaves (or refuses).
function memory(initial = {}) {
    const kept = { ...initial };
    return { kept, getItem: (k) => (k in kept ? kept[k] : null), setItem: (k, v) => { kept[k] = String(v); } };
}
const refusing = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
};

test('three settings: high has everything, medium shadows only, low nothing', () => {
    assert.deepEqual(QUALITIES, ['high', 'medium', 'low']);
    assert.ok(PRESETS.high.shadowMap > PRESETS.medium.shadowMap && PRESETS.medium.shadowMap > 0);
    assert.equal(PRESETS.low.shadowMap, 0);
    assert.equal(PRESETS.high.diffusion, true);
    assert.equal(PRESETS.medium.diffusion, false);
    assert.equal(PRESETS.low.diffusion, false);
});

test('High on a desktop, Low on a phone', () => {
    assert.equal(defaultQuality(false), 'high');
    assert.equal(defaultQuality(true), 'low');
    const media = (coarse, fine) => (q) => (q === '(pointer: coarse)' ? coarse : q === '(any-pointer: fine)' ? fine : false);
    assert.equal(phoneLike(media(true, false)), true, 'a touch screen and no mouse: a phone');
    assert.equal(phoneLike(media(true, true)), false, 'a touch laptop has a mouse too');
    assert.equal(phoneLike(media(false, true)), false, 'a desktop');
    assert.equal(loadQuality(memory(), phoneLike(media(true, false))), 'low');
    assert.equal(loadQuality(memory(), phoneLike(media(false, true))), 'high');
});

test('the choice is kept by the browser, and read back', () => {
    const s = memory();
    assert.equal(saveQuality(s, 'medium'), true);
    assert.equal(s.kept[GRAPHICS_KEY], 'medium');
    assert.equal(loadQuality(s, false), 'medium');
    assert.equal(loadQuality(s, true), 'medium', 'a phone keeps what was chosen on it');
    assert.equal(loadQuality(memory({ [GRAPHICS_KEY]: 'ultra' }), false), 'high', 'nonsense kept: the default');
});

test('no storage, or one that refuses: the default, and no error', () => {
    assert.equal(loadQuality(refusing, false), 'high');
    assert.equal(loadQuality(refusing, true), 'low');
    assert.equal(loadQuality(null, true), 'low');
    assert.equal(saveQuality(refusing, 'low'), false);
    assert.equal(saveQuality(null, 'low'), false);
});

test('the page\'s setting: started from storage, changed, kept, and told', () => {
    const s = memory({ [GRAPHICS_KEY]: 'medium' });
    assert.equal(initQuality(s, false), 'medium');
    assert.equal(getQuality(), 'medium');
    const heard = [];
    const stop = onQuality((q) => heard.push(q));
    assert.equal(setQuality('low'), true);
    assert.equal(getQuality(), 'low');
    assert.equal(s.kept[GRAPHICS_KEY], 'low', 'kept by the browser');
    assert.equal(setQuality('ultra'), false, 'no such setting');
    assert.equal(getQuality(), 'low');
    stop();
    setQuality('high');
    assert.deepEqual(heard, ['low'], 'told once, until it stopped listening');
    assert.equal(initQuality(refusing, true), 'low', 'no storage: a phone starts on Low');
    assert.equal(setQuality('high'), true, 'and can still change it, for the visit');
    assert.equal(getQuality(), 'high');
});

test('shadows by the sun\'s height: full while it is up, long and dark at dawn and dusk, gone as it sets', () => {
    const at = (deg, overcast = 0) => shadowStrength(daylight(deg * DEG, -1, 0, overcast), deg * DEG, overcast);
    for (const deg of [60, 30, 10, 5, 3]) {
        const s = at(deg);
        assert.equal(s.by, 'sun');
        assert.ok(s.strength > 0.95, `full at ${deg}°: ${s.strength}`);
    }
    assert.ok(at(1).strength > 0.5 && at(1).strength < 1, 'fading as it touches the horizon');
    assert.ok(at(0).strength < at(1).strength);
    assert.equal(at(-1.5).strength, 0, 'gone at dusk');
    let last = -1;
    for (let deg = -3; deg <= 5; deg += 0.25) {
        const s = at(deg).strength;
        assert.ok(s >= last - 1e-12, `never darker as the sun sinks (${deg}°)`);
        last = s;
    }
    assert.ok(at(30, 1).strength < 0.2, 'clouds veil them');
    assert.ok(at(30, 0.5).strength < at(30).strength);
});

test('at night the moon\'s shadows: faint, and by its phase and height', () => {
    const night = -30 * DEG;
    const moon = (alt, lit, overcast = 0) => shadowStrength(daylight(night, alt * DEG, lit, overcast), night, overcast);
    const full = moon(50, 1);
    assert.equal(full.by, 'moon');
    assert.ok(full.strength > 0.3 && full.strength < 0.7, `faint: ${full.strength}`);
    assert.ok(moon(50, 0.5).strength < full.strength, 'a half moon, fainter');
    assert.equal(moon(50, 0).strength, 0, 'a new moon casts none');
    assert.equal(moon(-10, 1).strength, 0, 'nor a moon that has set');
    assert.ok(moon(50, 1, 1).strength < full.strength * 0.5, 'clouds veil it');
    // The light changes hands (sky.js) only once the sun's shadows are gone.
    for (let deg = -1.2; deg > -6; deg -= 0.1) {
        const d = daylight(deg * DEG, 50 * DEG, 1);
        const s = shadowStrength(d, deg * DEG);
        if (d.sun.intensity > SUN_LIGHT_MIN) assert.equal(s.strength, 0, `${deg}°`);
    }
});

test('light rays: on screen, strongest at dawn and dusk, faint by moonlight', () => {
    const sun = (deg, x = 0, y = 0, front = true, overcast = 0) => rayStrength({ by: 'sun', alt: deg * DEG, x, y, front, overcast });
    assert.ok(sun(4) > 0.9, `a low sun in the middle of the screen: ${sun(4)}`);
    assert.ok(sun(45) < 0.5 * sun(4) && sun(45) > 0, 'the sun high: weaker');
    assert.equal(sun(-5), 0, 'set: none');
    assert.equal(sun(4, 0, 0, false), 0, 'behind the camera: none');
    assert.ok(sun(4, 1.2, 0) > 0 && sun(4, 1.2, 0) < sun(4), 'just past the edge: fading');
    assert.equal(sun(4, 2, 0), 0, 'well off the screen: none');
    assert.equal(sun(4, 0, -1.8), 0);
    assert.ok(sun(4, 0, 0, true, 0.5) < sun(4) && sun(4, 0, 0, true, 1) === 0, 'clouds');
    const moon = (lit, deg = 30) => rayStrength({ by: 'moon', alt: deg * DEG, x: 0, y: 0, front: true, lit });
    assert.ok(moon(1) > 0 && moon(1) < 0.5 * sun(4), `the moon's: faint (${moon(1)})`);
    assert.ok(moon(0.4) < moon(1), 'and by its phase');
    assert.equal(moon(0), 0);
    assert.equal(moon(1, -5), 0, 'set: none');
});
