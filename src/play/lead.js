// Leading your tribe (package 4), as the keys and the map give it: G in a
// body gives the call in the slot; on the map a call is readied (G, or the
// panel's buttons) and given where you click next; the tribe's answers come
// back as notices. calls.js keeps the calls, their names and the notices'
// words; the simulation's side is orders.js.
//
// `m` is modes.js's Modes: who you are, your body, the world, the page.
import { Calls, noticeFor, placed } from './calls.js';

export class Lead {
    constructor(m) {
        this.m = m;
        this.calls = new Calls(); // the call in the slot, and the one armed on the map
    }

    // G in a body: the call in the slot, at the ground under the crosshair
    // (where you stand, looking at the sky); a rally, around you.
    callHere() {
        const m = this.m;
        const kind = this.calls.call.kind;
        const at = kind === 'rally' ? null : m.env.crosshair?.() ?? null;
        m.world.act({ seq: m.body.nextSeq(), action: 'call', kind, x: at ? at.x : m.body.x, y: at ? at.y : m.body.y });
    }

    // On the map: ready a call (by default the slot's) to be given where you
    // click next; asked for again, let it go. One about the camp (Gather
    // food, Defend camp) is given at once.
    armCall(kind) {
        const m = this.m;
        if (m.inBody || !m.self || m.dying || m.over) return;
        if (this.calls.armed && (kind === undefined || kind === this.calls.armed)) this.calls.disarm();
        else {
            this.calls.arm(kind);
            const camp = m.world.tribeById.get(m.tribe)?.camp;
            if (!placed(this.calls.armed) && camp) this.callAt(camp.x, camp.y);
        }
        m.env.changed();
    }

    // A click on the map at (x, y), with a call armed: it is given there,
    // once. False if no call was armed (the click is the map's).
    callAt(x, y) {
        const m = this.m;
        const kind = this.calls.armed;
        if (!kind || m.inBody || !m.self) return false;
        this.calls.disarm();
        m.world.act({ seq: m.body.nextSeq(), action: 'call', kind, x, y });
        m.env.changed();
        return true;
    }

    // The tribe's answer to a call ('call', 'refused', 'rally' events), if
    // it is yours: a notice.
    answered(e) {
        const m = this.m;
        if (m.self && e.tribe === m.tribe) m.hud.notice?.(noticeFor(e), e.type === 'refused');
    }
}
