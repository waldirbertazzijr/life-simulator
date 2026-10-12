// The simulation's own thread. sim.js does the work; this file only decides
// when to tick. Between ticks the worker is free to answer messages, so a
// tick never runs longer than TICK_MS: at 64× the steps run back to back in
// slices of that size, and a request for a snapshot waits at most one slice.
import { Sim } from './sim.js';

const TICK_MS = 8;     // most stepping in one go before checking messages
const IDLE_MS = 1000;  // no snapshot asked for this long: the page is hidden, so rest (as before, when the
                       // simulation ran in requestAnimationFrame, which hidden pages do not get)

const sim = new Sim((msg, transfer) => postMessage(msg, transfer));
let lastWant = performance.now();
let timer = 0;
let soon = false;

// setTimeout(0) waits at least 4 ms once nested; a message to ourselves runs
// right after whatever is queued, which is what "keep stepping" needs.
const wake = new MessageChannel();
wake.port1.onmessage = () => {
    soon = false;
    tick();
};

function tick() {
    timer = 0;
    sim.tick(performance.now(), TICK_MS);
    schedule();
}

function schedule() {
    clearTimeout(timer);
    timer = 0;
    if (soon) return;
    const now = performance.now();
    if (now - lastWant > IDLE_MS) return; // resting until the page asks again
    const wait = sim.wait(now);
    if (wait === Infinity) return; // paused, or no world yet: a message will wake us
    if (wait <= 1) {
        soon = true;
        wake.port2.postMessage(0);
    } else {
        timer = setTimeout(tick, wait);
    }
}

self.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'want') {
        const now = performance.now();
        if (now - lastWant > IDLE_MS) sim.last = now; // back from rest: no catching up
        lastWant = now;
    }
    sim.handle(msg);
    schedule();
};
