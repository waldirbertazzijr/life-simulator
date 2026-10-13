// The admin console: a line to type commands into, sliding down from the top
// like a game's developer console, with a log of what they did. ` (the key
// left of 1, by its place, so on any layout) or F2 opens and closes it, as
// does the button in the panel's header; Esc closes it too. The commands
// themselves run in the simulation (src/admin.js, the `admin` message), at
// its next step; their answers come back as `admin` events.
//
// While it is open the pointer is let go, and keys and clicks are not the
// body's or the page's (input.js `blocked`, and every key is caught on its
// way in). ↑ and ↓ walk back through the commands typed before (kept by this
// browser), and Tab completes commands, kinds, materials and parameters.
//
// Two commands are the page's own: `seed` (a new world is built here too,
// mirror.js) and `clear`; `help` is answered here at once.
//
// Play mode: once a command that changes the world has been used in a Play
// game, a quiet "admin" mark shows on the HUD for the rest of that game
// (honest, not a punishment). A game is modes.js's `story`: a new one comes
// with each new Play game and each new world.
//
// No DOM is touched without `doc` (node tests).
import { COMMANDS, COMMAND_NAMES, parse, helpText } from '../admin.js';
import { setParam } from '../sim.js';

export const HISTORY_KEY = 'life-simulator.console';
const HISTORY_MAX = 100;
const LOG_MAX = 400; // lines kept in the log
const GREETING = 'admin console · help lists the commands · Tab completes · ↑↓ history · Esc closes';

const typing = (e) => {
    const el = e.target;
    return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

function commonPrefix(words) {
    let p = words[0];
    for (const w of words) while (!w.startsWith(p)) p = p.slice(0, -1);
    return p;
}

// The parameters' paths that could follow `word` (e.g. 'herbivore.sp'):
// those in the group it has reached, a group ending in '.'.
function paramChoices(params, word) {
    if (!params) return [];
    const parts = word.split('.');
    let o = params;
    for (const k of parts.slice(0, -1)) {
        if (o === null || typeof o !== 'object' || !(k in o)) return [];
        o = o[k];
    }
    if (o === null || typeof o !== 'object') return [];
    const lead = parts.slice(0, -1).map((k) => `${k}.`).join('');
    return Object.keys(o).map((k) => {
        const v = o[k];
        return `${lead}${k}${v !== null && typeof v === 'object' && !Array.isArray(v) ? '.' : ''}`;
    });
}

// Tab on `line`: its last word completed as far as the choices agree, and
// the choices that fit (more than one: nothing could be decided). `params`:
// the page's parameters, for set and get.
export function completeLine(line, params = null) {
    const lead = line.replace(/\S*$/, '');
    const word = line.slice(lead.length);
    const before = lead.trim().split(/\s+/).filter(Boolean);
    let choices = [];
    let param = false;
    if (!before.length) choices = COMMAND_NAMES;
    else {
        const list = COMMANDS[before[0].toLowerCase()]?.complete?.[before.length - 1];
        if (list === 'commands') choices = COMMAND_NAMES;
        else if (list === 'param') {
            param = true;
            choices = paramChoices(params, word);
        } else if (Array.isArray(list)) choices = list;
    }
    // (Parameters as they are written, camelCase; words in any case.)
    const fits = param ? choices.filter((c) => c.startsWith(word)) : choices.filter((c) => c.startsWith(word.toLowerCase()));
    if (!fits.length) return { line, choices: [] };
    if (fits.length === 1) return { line: `${lead}${fits[0]}${fits[0].endsWith('.') ? '' : ' '}`, choices: [] };
    const common = commonPrefix(fits);
    return { line: `${lead}${common.length > word.length ? common : word}`, choices: fits };
}

function defaultStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null; // (storage refused: history for this visit only)
    }
}

export class Console {
    // env: {
    //   send(msg)      to the simulation (the Mirror's host)
    //   start(seed)    a new world (main.js)
    //   target()       what a kill goes for: the lock-on, or who is under the crosshair (0: none)
    //   modes          play/modes.js (game, story: the Play mark)
    //   params()       the page's parameters (Tab for set and get; a set is mirrored there)
    //   input          play/input.js (let go of while open)
    //   events()       this frame's events (the Mirror's)
    //   doc, win       the DOM (none in tests)
    //   storage        where the history is kept (default: localStorage)
    // }
    constructor(env) {
        this.env = env;
        this.storage = 'storage' in env ? env.storage : defaultStorage();
        this.history = this.load();
        this.at = this.history.length; // the entry ↑↓ show (the length: the line being typed)
        this.draft = '';               // the line being typed, while ↑↓ show older ones
        this.text = '';                // the line (without a DOM)
        this.isOpen = false;
        this.lines = [];               // the log: {kind: 'cmd' | 'ok' | 'error' | 'usage' | 'info', text}
        this.asked = new Map();        // command id → the Play game it was typed in (modes.story), or null
        this.nextId = 1;
        this.marked = null;            // the Play game a command changed the world in
        this.markShown = false;
        this.root = null;
        this.logEl = null;
        this.inputEl = null;
        this.markEl = null;
        if (env.doc) this.bind(env.doc, env.win);
    }

    bind(doc, win) {
        this.doc = doc;
        this.root = doc.getElementById('console');
        this.logEl = doc.getElementById('console-log');
        this.inputEl = doc.getElementById('console-input');
        this.markEl = doc.getElementById('hud-admin');
        doc.getElementById('console-open')?.addEventListener('click', () => this.toggle());
        // Keys typed into the line are its alone: not the page's shortcuts,
        // the camera's or the body's. (Key releases go on: nothing stays held.)
        this.inputEl.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (this.key(e)) e.preventDefault();
        });
        // ` and F2 anywhere; and, while open, every key on its way in.
        win.addEventListener('keydown', (e) => this.watch(e), true);
    }

    // A key on its way to anything but the line (the window, capturing).
    watch(e) {
        if (e.target === this.inputEl) return; // (the line's own handler has it)
        const toggle = e.code === 'Backquote' || e.key === 'F2';
        if (!this.isOpen) {
            if (!toggle || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key !== 'F2' && typing(e)) return; // (typed into another field)
            e.preventDefault();
            e.stopPropagation();
            this.open();
            return;
        }
        if (e.ctrlKey || e.metaKey) return; // (the browser's own, such as copying from the log)
        e.stopPropagation();
        if (toggle || e.key === 'Escape') {
            e.preventDefault();
            if (!e.repeat) this.close();
            return;
        }
        this.inputEl?.focus(); // (what is typed goes to the line)
    }

    get value() {
        return this.inputEl ? this.inputEl.value : this.text;
    }

    set value(v) {
        if (this.inputEl) this.inputEl.value = v;
        else this.text = v;
    }

    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }

    open() {
        if (this.isOpen) return;
        this.isOpen = true;
        const input = this.env.input;
        if (input) {
            input.clear();
            input.unlock();
            input.blocked = true;
        }
        if (!this.lines.length) this.write('info', GREETING);
        if (this.root) {
            this.root.classList.add('open');
            this.root.setAttribute('aria-hidden', 'false');
            this.inputEl.focus();
        }
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        if (this.env.input) this.env.input.blocked = false;
        if (this.root) {
            this.root.classList.remove('open');
            this.root.setAttribute('aria-hidden', 'true');
            this.inputEl.blur();
        }
    }

    // A key in the line ({code, key, repeat}): true if it was the console's.
    key(e) {
        if (e.code === 'Backquote' || e.key === 'F2' || e.key === 'Escape') {
            if (!e.repeat) this.close();
            return true;
        }
        switch (e.key) {
            case 'Enter': {
                const line = this.value;
                this.value = '';
                this.submit(line);
                return true;
            }
            case 'Tab':
                if (!e.shiftKey) this.complete();
                return true;
            case 'ArrowUp':
                this.older();
                return true;
            case 'ArrowDown':
                this.newer();
                return true;
            default:
                return false;
        }
    }

    // A command typed (and Enter): echoed, then done here or sent.
    submit(line) {
        const p = parse(line);
        if (!p) return;
        const text = String(line).trim();
        this.remember(text);
        this.write('cmd', text);
        const c = COMMANDS[p.cmd];
        if (!c) {
            this.write('error', `unknown command "${p.cmd}": type help`);
            return;
        }
        if (p.cmd === 'clear') {
            this.clear();
            return;
        }
        if (p.cmd === 'help') {
            const help = helpText(p.args[0]);
            if (help === null) {
                this.write('error', `no such command: ${p.args[0]}`);
                this.write('usage', `usage: ${c.usage}`);
            } else this.write('ok', help);
            return;
        }
        if (p.cmd === 'seed') {
            const n = Number(p.args[0]);
            if (!Number.isInteger(n) || n <= 0) {
                this.write('error', p.args[0] === undefined ? 'which seed?' : `not a seed: ${p.args[0]}`);
                this.write('usage', `usage: ${c.usage}`);
                return;
            }
            this.env.start(n, this.env.params?.() ?? undefined); // (with the numbers as set: set world.area, then seed)
            this.write('ok', `a new world, from seed ${n}`);
            return;
        }
        const id = this.nextId++;
        const m = this.env.modes;
        this.asked.set(id, m && m.game === 'play' ? m.story : null);
        this.env.send({ type: 'admin', id, cmd: p.cmd, args: p.args, target: this.env.target?.() || 0 });
    }

    // Shortcut for the browser's console and probes: open, and type `line`.
    run(line) {
        this.open();
        this.submit(line);
    }

    // The simulation's answer (an `admin` event).
    answer(e) {
        const game = this.asked.get(e.id);
        this.asked.delete(e.id);
        if (e.ok) {
            if (e.text) this.write('ok', e.text);
        } else {
            for (const l of String(e.text).split('\n')) this.write(l.startsWith('usage:') ? 'usage' : 'error', l);
        }
        if (!e.ok) return;
        // A parameter set there is set here too, so the page reads the same.
        if (e.param && this.env.params) {
            try {
                setParam(this.env.params(), e.param.path, e.param.value);
            } catch {
                // (the page has no such parameter: nothing to follow)
            }
        }
        const m = this.env.modes;
        if (e.changed && game && m && m.game === 'play' && m.story === game) this.marked = game;
    }

    // Each frame: the answers that came into view, and the HUD's mark.
    frame() {
        const events = this.env.events?.() ?? [];
        for (const e of events) if (e.type === 'admin') this.answer(e);
        const m = this.env.modes;
        const on = this.marked !== null && !!m && m.game === 'play' && m.story === this.marked;
        if (on === this.markShown) return;
        this.markShown = on;
        if (this.markEl) this.markEl.hidden = !on;
    }

    // ---- The log ----

    write(kind, text) {
        const fresh = String(text).split('\n').map((t) => ({ kind, text: t }));
        this.lines.push(...fresh);
        const extra = this.lines.length - LOG_MAX;
        if (extra > 0) this.lines.splice(0, extra);
        if (!this.logEl) return;
        for (const l of fresh) {
            const div = this.doc.createElement('div');
            div.className = l.kind;
            div.textContent = l.text || ' ';
            this.logEl.append(div);
        }
        while (this.logEl.childElementCount > LOG_MAX) this.logEl.firstElementChild.remove();
        this.logEl.scrollTop = this.logEl.scrollHeight;
    }

    clear() {
        this.lines = [];
        this.logEl?.replaceChildren();
    }

    // ---- History (↑ ↓), kept by this browser ----

    load() {
        try {
            const h = JSON.parse(this.storage?.getItem(HISTORY_KEY) ?? '[]');
            return Array.isArray(h) ? h.filter((s) => typeof s === 'string').slice(-HISTORY_MAX) : [];
        } catch {
            return [];
        }
    }

    remember(line) {
        if (this.history.at(-1) !== line) this.history.push(line);
        if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
        this.at = this.history.length;
        this.draft = '';
        try {
            this.storage?.setItem(HISTORY_KEY, JSON.stringify(this.history));
        } catch {
            // (no storage here: for this visit only)
        }
    }

    older() {
        if (this.at === 0) return;
        if (this.at === this.history.length) this.draft = this.value;
        this.at--;
        this.value = this.history[this.at];
    }

    newer() {
        if (this.at >= this.history.length) return;
        this.at++;
        this.value = this.at === this.history.length ? this.draft : this.history[this.at];
    }

    // ---- Tab ----

    complete() {
        const before = this.value;
        const r = completeLine(before, this.env.params?.() ?? null);
        this.value = r.line;
        if (r.choices.length > 1 && r.line === before) this.write('info', r.choices.join('  '));
    }
}
