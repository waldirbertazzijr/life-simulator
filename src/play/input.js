// The player's hands: the keyboard and the mouse while you are in a body.
// It knows nothing of bodies or cameras; it keeps what is held (the WASD
// axes, Space), adds up how far the mouse has moved (the look), and names
// each one-off action for actions.js (what each one does):
//
//   move                    a movement key went down (it stands you up from resting)
//   roll                    Space tapped: released within TAP_MS
//   crouch lock interact eat craft call view map pause look
//   interact-end            E let go (butchering is done holding E)
//   cycle-weapon cycle-tool cycle-pouch cycle-call      (the arrow keys)
//   attack {heavy, power}   left click; held past TAP_MS, heavy: power is how
//                           long it was held, up to CHARGE_MS (0..1)
//   tool, skill             right click, Shift + right click (with the
//                           pointer locked or not)
//
// A menu open on top (the craft menu) sets `capture(code, repeat)`: keys it
// takes (returning true) go to it alone, and clicks on the view do nothing.
//
// Held past TAP_MS, Space sprints (`sprinting`; so does Shift held), and the left button
// charges (`charging`, `charge`). Keys go by physical key (event.code), so
// WASD sits under the same fingers on any layout.
//
// The mouse: click the view to lock the pointer, and the mouse looks around;
// Esc frees it (the browser's rule). Where the pointer cannot be locked (or
// until it is), dragging on the view looks around instead.
//
// Modes: 'off' hears nothing (the page's own shortcuts work, ui.js), 'map'
// hears only M (back into your body), G (a call, given where you click:
// calls.js) and L (how your person looks: editor.js), 'body' hears
// everything. Keys typed into a text field, or pressed with Ctrl/Cmd/Alt,
// are left alone. A key released while the window was not looking would
// stay held, so losing focus or hiding the tab lets go of everything.

export const TAP_MS = 250;
export const CHARGE_MS = 1000; // a heavy attack charges this long, at most

// A key that means one thing when tapped and another when held.
export class TapHold {
    constructor(threshold = TAP_MS) {
        this.threshold = threshold;
        this.since = -1; // when it went down, or -1
    }

    down(t) {
        if (this.since < 0) this.since = t;
    }

    // Released at t: 'tap' if it was short, 'hold' if not, null if it was not down.
    up(t) {
        if (this.since < 0) return null;
        const d = t - this.since;
        this.since = -1;
        return d < this.threshold ? 'tap' : 'hold';
    }

    held(t) {
        return this.since >= 0 && t - this.since >= this.threshold;
    }

    clear() {
        this.since = -1;
    }
}

const MOVE = { KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right' };
// One-off actions. Only some do anything yet (actions.js); the rest are named
// here so that later packages only have to listen for them.
const ACTIONS = {
    KeyX: 'crouch', KeyQ: 'lock', KeyE: 'interact', KeyR: 'eat', KeyC: 'craft', KeyG: 'call',
    KeyV: 'view', KeyM: 'map', KeyP: 'pause', KeyL: 'look',
    ArrowRight: 'cycle-weapon', ArrowLeft: 'cycle-tool', ArrowDown: 'cycle-pouch', ArrowUp: 'cycle-call',
};
// On the map (where the arrows and WASD are the camera's).
const MAP_ACTIONS = { KeyM: 'map', KeyG: 'call', KeyL: 'look' };

const typing = (e) => {
    const el = e.target;
    return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

export class Input {
    // target: where keys are heard (the window); canvas: the view (clicks,
    // drags, pointer lock); doc: the document (pointer-lock state, the mouse
    // while locked, the tab hidden); now(): the time in ms.
    constructor({ target, canvas, doc, now = () => performance.now() }) {
        this.target = target;
        this.canvas = canvas;
        this.doc = doc;
        this.now = now;
        this.mode = 'off';
        this.held = new Set();
        this.space = new TapHold();
        this.click = new TapHold();
        this.locked = false;
        this.drag = null;      // { id, x, y } while dragging to look
        this.lookX = 0;        // mouse movement (px) not yet taken
        this.lookY = 0;
        this.onAction = () => {};
        this.capture = null;   // (code, repeat) => taken?, while a menu is open
        this.blocked = false;  // the admin console is open (console.js): no key or click is the body's

        target.addEventListener('keydown', (e) => this.keydown(e));
        target.addEventListener('keyup', (e) => this.keyup(e));
        target.addEventListener('blur', () => this.clear());
        doc.addEventListener('visibilitychange', () => {
            if (doc.hidden) this.clear();
        });
        doc.addEventListener('pointerlockchange', () => {
            this.locked = doc.pointerLockElement === canvas;
            if (this.locked) this.drag = null;
        });
        doc.addEventListener('pointerlockerror', () => {
            this.locked = false;
        });
        doc.addEventListener('mousemove', (e) => {
            if (this.mode !== 'body' || !this.locked) return;
            this.lookX += e.movementX || 0;
            this.lookY += e.movementY || 0;
        });
        canvas.addEventListener('pointerdown', (e) => this.pointerdown(e));
        canvas.addEventListener('pointermove', (e) => {
            const d = this.drag;
            if (!d || e.pointerId !== d.id || this.locked) return;
            this.lookX += e.clientX - d.x;
            this.lookY += e.clientY - d.y;
            d.x = e.clientX;
            d.y = e.clientY;
        });
        doc.addEventListener('pointerup', (e) => this.pointerup(e));
        doc.addEventListener('pointercancel', () => {
            this.drag = null;
        });
    }

    // 'off', 'map' or 'body'. Leaving the body lets go of the keys and the pointer.
    setMode(mode) {
        if (mode === this.mode) return;
        this.mode = mode;
        if (mode !== 'body') {
            this.clear();
            this.unlock();
        }
    }

    keydown(e) {
        if (this.mode === 'off' || this.blocked || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
        if (this.mode === 'map') {
            const action = MAP_ACTIONS[e.code];
            if (action) {
                e.preventDefault();
                if (!e.repeat) this.onAction(action);
            }
            return;
        }
        if (this.capture && this.capture(e.code, e.repeat)) {
            e.preventDefault();
            return;
        }
        if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
            this.held.add('run'); // (Shift held runs too, as Space held does)
            return;
        }
        const move = MOVE[e.code];
        if (move) {
            e.preventDefault();
            this.held.add(move);
            if (!e.repeat) this.onAction('move');
            return;
        }
        if (e.code === 'Space') {
            e.preventDefault(); // (it would also press a focused button)
            this.space.down(this.now());
            return;
        }
        const action = ACTIONS[e.code];
        if (!action) return;
        e.preventDefault();
        if (!e.repeat) this.onAction(action);
    }

    keyup(e) {
        const move = MOVE[e.code];
        if (move) this.held.delete(move);
        if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.held.delete('run');
        if (this.mode !== 'body' || typing(e)) return;
        if (e.code === 'Space') {
            e.preventDefault();
            if (this.space.up(this.now()) === 'tap') this.onAction('roll');
        } else if (e.code === 'KeyE') {
            this.onAction('interact-end');
        }
    }

    pointerdown(e) {
        if (this.mode !== 'body' || this.capture || this.blocked) return;
        if (e.button === 2) {
            this.onAction(e.shiftKey ? 'skill' : 'tool');
            return;
        }
        if (this.locked) {
            if (e.button === 0) this.click.down(this.now());
            return;
        }
        if (e.button !== 0) return;
        // Not locked: this click asks for the lock, and until it comes (or
        // where it never does) a drag looks around.
        this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        this.lock();
    }

    pointerup(e) {
        if (this.drag && e.pointerId === this.drag.id) this.drag = null;
        if (this.mode === 'body' && this.locked && e.button === 0) {
            const power = this.charge;
            const how = this.click.up(this.now());
            if (how) this.onAction('attack', { heavy: how === 'hold', power: how === 'hold' ? power : 0 });
        }
    }

    // The left button held past a tap: a heavy attack being charged...
    get charging() {
        return this.click.held(this.now());
    }

    // ...and how far, 0..1 (full after CHARGE_MS); 0 while it is a tap.
    get charge() {
        if (!this.charging) return 0;
        const t = (this.now() - this.click.since) / CHARGE_MS;
        return t < 1 ? t : 1;
    }

    // Ask for the pointer. Browsers may refuse (a headless one always does),
    // by throwing, by rejecting, or by an event: then dragging still looks.
    lock() {
        if (this.locked || !this.canvas.requestPointerLock) return;
        try {
            const asked = this.canvas.requestPointerLock();
            if (asked && typeof asked.catch === 'function') asked.catch(() => {});
        } catch {
            // (no pointer lock here)
        }
    }

    unlock() {
        if (this.doc.pointerLockElement === this.canvas) this.doc.exitPointerLock?.();
        this.locked = false;
    }

    clear() {
        this.held.clear();
        this.space.clear();
        this.click.clear();
        this.drag = null;
    }

    // The mouse's movement since the last call, in pixels.
    takeLook() {
        const look = { dx: this.lookX, dy: this.lookY };
        this.lookX = 0;
        this.lookY = 0;
        return look;
    }

    axis(plus, minus) {
        return (this.held.has(plus) ? 1 : 0) - (this.held.has(minus) ? 1 : 0);
    }

    get x() {
        return this.axis('right', 'left');
    }

    get y() {
        return this.axis('forward', 'back');
    }

    get sprinting() {
        return this.space.held(this.now()) || this.held.has('run');
    }
}
