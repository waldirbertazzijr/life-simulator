// World.events and their way to the page in snapshots (sim.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params as defaults } from '../src/config.js';
import { World } from '../src/world.js';
import { Sim } from '../src/sim.js';

const world = (seed = 1) => new World(structuredClone(defaults), { seed, aspect: 1.6 });

function stepUntilDeath(w, limit = 3000) {
    for (let k = 0; k < limit; k++) {
        w.step();
        const death = w.events.find((e) => e.type === 'death');
        if (death) return death;
    }
    return null;
}

test('a death is reported as an event of the step it happened in', () => {
    const w = world();
    const death = stepUntilDeath(w);
    assert.ok(death, 'someone dies within 3000 steps');
    for (const f of ['kind', 'id', 'x', 'y', 'heading', 'cause', 'by', 'time']) assert.ok(f in death, `has ${f}`);
    assert.equal(death.time, w.time - 1);
    assert.ok(['herbivore', 'carnivore', 'human'].includes(death.kind));
});

test('events are cleared as each step begins', () => {
    const w = world();
    stepUntilDeath(w);
    const before = w.time - 1;
    w.step();
    assert.ok(w.events.every((e) => e.time === before + 1));
});

test('a snapshot carries every event since the last one, then starts afresh', () => {
    const posted = [];
    const sim = new Sim((msg) => posted.push(msg));
    sim.handle({ type: 'start', gen: 1, seed: 1, aspect: 1.6, params: structuredClone(defaults) });
    let deaths = 0;
    for (let k = 0; k < 500; k++) {
        sim.step();
        deaths += sim.world.events.filter((e) => e.type === 'death').length;
    }
    assert.ok(deaths > 0, 'someone dies within 500 steps');
    sim.handle({ type: 'want' });
    const first = posted.filter((m) => m.type === 'snapshot').at(-1);
    assert.equal(first.events.filter((e) => e.type === 'death').length, deaths);
    sim.step();
    const one = sim.world.events.length;
    sim.handle({ type: 'want' });
    const second = posted.filter((m) => m.type === 'snapshot').at(-1);
    assert.notEqual(second, first);
    assert.equal(second.events.length, one);
});
