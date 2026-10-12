// Leading your tribe, on the page (spec §9). The call you have ready sits
// in the top slot of the equipment cross; ↑ cycles it, G gives it: at the
// ground under the crosshair (where you stand, if you look at the sky), or,
// for a rally, around you. On the map, Hunt here and Move camp, armed in the
// panel (or with G), are given where you next click; Gather food and Defend
// camp at once.
//
// The simulation hears it (orders.js) and the tribe answers in events, which
// read here as the notices the HUD shows.
//
// (Gathering wood and flint come with items, as more calls.)

export const CALLS = [
    { kind: 'rally', name: 'Rally' },
    { kind: 'hunt', name: 'Hunt here' },
    { kind: 'gather', name: 'Gather food' },
    { kind: 'defend', name: 'Defend camp' },
    { kind: 'move', name: 'Move camp' },
];

// The calls the map can give: a rally needs you there. Of those, the ones
// that need a place wait for your click; the others are about the camp.
export const MAP_CALLS = CALLS.filter((c) => c.kind !== 'rally');
export const placed = (kind) => kind === 'hunt' || kind === 'move';

export const callName = (kind) => CALLS.find((c) => c.kind === kind)?.name ?? kind;

// What the tribe says when it takes an order, and why it may not.
const TAKEN = {
    hunt: 'Hunt here — the hunters make for the marker',
    gather: 'Gather food — no hunting, only gathering',
    defend: 'Defend camp — everyone to the camp',
    move: 'Move camp — the camp moves here',
};
const REFUSED = {
    child: 'A child cannot lead',
    spirit: 'Not enough Spirit to rally',
    nobody: 'Nobody near enough to rally',
    away: 'A rally needs you there',
    site: 'No camp can stand there',
    cooldown: 'The camp has only just moved',
    unreachable: 'Nobody can get there',
    unknown: 'Not a call they know',
};

// The notice for one of the tribe's answers ('call', 'refused' or 'rally'
// events), or null for anything else. A hungry tribe takes an order but
// feeds itself first (orders.js).
export function noticeFor(e) {
    switch (e.type) {
        case 'call':
            if (e.hungry && e.kind !== 'move') return `${callName(e.kind)} — once the camp is fed`;
            return TAKEN[e.kind] ?? callName(e.kind);
        case 'rally':
            return e.count === 1 ? 'Rally — one follows you' : `Rally — ${e.count} follow you`;
        case 'refused':
            return REFUSED[e.reason] ?? `${callName(e.kind)} — refused`;
        default:
            return null;
    }
}

// The call in the slot (`index`, `call`), and the one armed on the map
// (`armed`: a kind, or null).
export class Calls {
    constructor() {
        this.reset();
    }

    reset() {
        this.index = 0;
        this.armed = null;
    }

    get call() {
        return CALLS[this.index];
    }

    cycle() {
        this.index = (this.index + 1) % CALLS.length;
        return this.call;
    }

    select(kind) {
        const k = CALLS.findIndex((c) => c.kind === kind);
        if (k >= 0) this.index = k;
    }

    // Ready `kind` (by default the slot's) to be given where you click on
    // the map; a rally cannot be, so the first order is readied instead.
    // The slot shows it too.
    arm(kind = this.call.kind) {
        if (!MAP_CALLS.some((c) => c.kind === kind)) kind = MAP_CALLS[0].kind;
        this.select(kind);
        this.armed = kind;
    }

    disarm() {
        this.armed = null;
    }
}
