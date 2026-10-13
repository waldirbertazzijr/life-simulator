// Saving and loading games, on the page: the save menu, the autosave, and
// "continue" in the panel when the page opens. One game is a long evening
// (a five-hour session is one character's life), so it must be possible to
// stop and come back.
//
// The menu opens from the panel's save button, and with P in a body (the
// pause key: the world waits while it is open, and closing it carries on).
// It saves to one of three slots, loads any slot, deletes, exports a slot or
// the game now to a file (.lifesave: save.js packFile) and imports one. Each
// slot shows the date by the calendar, the seed, who you play and their
// tribe, God or Play, and when it was saved. Overwriting and deleting ask
// once more ("sure?").
//
// The autosave (slot 'auto') is made at each dawn in the world while the
// page is shown (at most every DAWN_GAP_MS: at 256× a day lasts a second),
// when the tab is hidden or closed, and after a succession (your heir takes
// over). It costs the simulation a few milliseconds (save.js), and the
// page an IndexedDB write. Two rules keep a long game from being written
// over by a new one:
//   - while "continue" is offered (an autosave was found as the page
//     opened, and you have not yet played, loaded or saved), nothing is
//     autosaved: a world only watched does not replace the game you left;
//   - a game's first autosave over another game's keeps that one as
//     'previous' ("an earlier game"), one game back.
// Nothing is ever loaded unless you ask.
//
// Storage is IndexedDB (save-store.js); where it is refused, the menu says
// so, and export and import still work.
//
// `env` = {
//   world        the Mirror (save(), p, time, seed)
//   store        a SaveStore
//   record()     the page's own state to keep with a save, `run` (which game) among it (main.js)
//   resume(kept) carry on from a kept save (main.js); throws a SaveError if it cannot
//   playing()    someone is played: the "continue" offer goes
//   getPaused(), setPaused(p)
//   input        play/input.js (let go of while open)
//   quiet()      the home screen is up (home/home.js): nothing is played, nothing autosaved
//   closed()     the menu has closed (the home screen's Continue may have changed)
//   doc, win     the DOM (none in tests)
// }
//
// From the home screen the menu opens for loading only (open(false, 'load')):
// no saving to a slot, no export of the world behind the title.
import { packFile, unpackFile, SaveError, SAVE_VERSION } from '../save.js';
import { dateLabel } from '../calendar.js';
import { StorageError } from '../save-store.js';

export const DAWN_GAP_MS = 15000;
const CONFIRM_MS = 3000;
const MANUAL = ['1', '2', '3'];
const NAMES = { auto: 'autosave', previous: 'an earlier game', 1: 'slot 1', 2: 'slot 2', 3: 'slot 3' };

// Who a save is about: "Tiko of the Neto · Play", "God · watching".
export function whoOf(meta) {
    const p = meta?.player;
    if (!p) return 'God · watching';
    if (p.over || !p.id) return 'Play · the line has ended';
    const who = p.tribeName ? `${p.name} of the ${p.tribeName}` : p.name;
    return `${who} · ${p.mode === 'play' ? 'Play' : 'God'}${p.auto ? ' (on the map)' : ''}`;
}

// When it was saved, as people say it: "14 Oct, 21:42".
export function whenOf(ms, now = Date.now()) {
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric', hour: '2-digit', minute: '2-digit' });
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;

// The character editor's choices go with a save: they are kept in this
// browser by seed and id (view3d/looks.js, under this key, as
// [[seed, [[id, choice], ...]], ...]). These read and write that list
// without the 3D view (main.js has the view's Looks read it again).
export const LOOKS_KEY = 'life-simulator.looks';

function readLooks(storage) {
    try {
        const all = JSON.parse(storage?.getItem(LOOKS_KEY) ?? '[]');
        return Array.isArray(all) ? all : [];
    } catch {
        return [];
    }
}

// The choices for the world of `seed`: [[id, choice], ...].
export function looksOf(storage, seed) {
    const entry = readLooks(storage).find((e) => Array.isArray(e) && e[0] === seed);
    return entry && Array.isArray(entry[1]) ? entry[1] : [];
}

// Put a save's choices back for the world of `seed` (over any made since).
export function putLooks(storage, seed, people) {
    if (!Array.isArray(people) || !people.length) return;
    const all = readLooks(storage);
    const k = all.findIndex((e) => Array.isArray(e) && e[0] === seed);
    const kept = new Map(k >= 0 && Array.isArray(all[k][1]) ? all[k][1] : []);
    for (const [id, choice] of people) kept.set(id, choice);
    if (k >= 0) all.splice(k, 1);
    all.push([seed, [...kept]]); // (the latest last, as looks.js keeps them)
    try {
        storage?.setItem(LOOKS_KEY, JSON.stringify(all));
    } catch {
        // (storage refused: the looks are as born this visit)
    }
}

export class Saves {
    constructor(env) {
        this.env = env;
        this.world = env.world;
        this.store = env.store;
        this.slots = new Map(); // slot → kept summary (the store's list)
        this.problem = null;    // storage's trouble, said in the menu
        this.isOpen = false;
        this.paused = false;    // P opened it, and paused the world
        this.offered = false;   // "continue" is offered
        this.busy = false;      // an autosave on its way
        this.day = null;        // the world's day at the last look (dawn: a new one)
        this.lastDawn = -Infinity;
        this.lastAuto = -1;     // the world time of the last autosave
        this.keptAt = -Infinity; // the world time of this game's latest save (any slot), or of the save loaded
        this.last = null;       // the latest save: {slot, ms (in the simulation), bytes, captureMs, storeMs, reason}
        this.confirming = null; // {slot, act, until}
        this.only = null;       // 'load': the menu opened from the home screen, for loading
        this.status = '';
        if (env.doc) this.bind(env.doc, env.win);
    }

    bind(doc, win) {
        this.doc = doc;
        const $ = (id) => doc.getElementById(id);
        this.root = $('saves');
        this.listEl = $('sv-list');
        this.subEl = $('sv-sub');
        this.statusEl = $('sv-status');
        this.fileEl = $('sv-file');
        this.exportEl = $('sv-export');
        this.continueEl = $('continue');
        $('sv-close').addEventListener('click', () => this.close());
        $('sv-export').addEventListener('click', () => this.exportNow());
        $('sv-import').addEventListener('click', () => this.fileEl.click());
        this.fileEl.addEventListener('change', () => {
            const file = this.fileEl.files?.[0];
            this.fileEl.value = '';
            if (file) this.importFile(file);
        });
        this.listEl.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-act]');
            if (b) this.act(b.dataset.slot, b.dataset.act);
        });
        this.continueEl?.addEventListener('click', () => {
            this.load('auto').catch((err) => {
                // (It cannot be: the menu says why.)
                this.open();
                this.say(err?.message ?? String(err), true);
            });
        });
        // While open, every key on its way in is the menu's: Esc (and P, from a body) closes it.
        win.addEventListener('keydown', (e) => {
            if (!this.isOpen || e.ctrlKey || e.metaKey || e.timeStamp <= this.openedAt) return;
            e.stopPropagation();
            if (e.key === 'Escape' || (this.paused && e.code === 'KeyP')) {
                e.preventDefault();
                if (!e.repeat) this.close();
            }
        }, true);
        // Hidden or closed: autosave (as far as the browser lets it finish).
        doc.addEventListener('visibilitychange', () => {
            if (doc.visibilityState === 'hidden') this.autosave('hidden');
        });
        win.addEventListener('pagehide', () => this.autosave('closed'));
    }

    // ---- The page opens ----

    // What is kept; "continue" if there is an autosave.
    async start() {
        await this.refresh();
        const auto = this.slots.get('auto');
        if (auto && !this.env.playing()) {
            this.offered = true;
            this.showContinue(auto);
        }
    }

    showContinue(auto) {
        const el = this.continueEl;
        if (!el) return;
        el.hidden = !this.offered;
        if (!this.offered) return;
        el.replaceChildren();
        const head = this.doc.createElement('span');
        head.textContent = 'continue ';
        const date = this.doc.createElement('span');
        date.className = 'muted';
        date.textContent = auto.meta.date;
        head.append(date);
        const who = this.doc.createElement('span');
        who.className = 'muted';
        who.textContent = whoOf(auto.meta);
        el.append(head, who);
        el.title = `Carry on from the autosave of ${whenOf(auto.savedAt)} (seed ${auto.meta.seed})`;
    }

    // The offer goes: you have played, loaded or saved.
    dismiss() {
        if (!this.offered) return;
        this.offered = false;
        if (this.continueEl) this.continueEl.hidden = true;
    }

    // ---- Each moment ----

    // A new world (or a loaded one): its days are counted afresh.
    newWorld() {
        this.day = null;
        this.lastAuto = -1;
        this.keptAt = -Infinity;
    }

    // Has the world moved on since this game was last saved (or loaded), by
    // more than `grace` steps (10 s at 1×)? The home mark asks first if so.
    unsaved(grace = 150) {
        return !(this.world.time - this.keptAt <= grace);
    }

    // Every few frames (main.js): the dawn's autosave, and the offer.
    tick(now = performance.now()) {
        const w = this.world;
        if (!w.p) return;
        if (this.offered && this.env.playing()) this.dismiss();
        const day = Math.floor(w.time / w.p.calendar.day);
        if (this.day !== null && day > this.day && this.visible() && now - this.lastDawn >= DAWN_GAP_MS) {
            this.lastDawn = now;
            this.autosave('dawn');
        }
        this.day = day;
    }

    visible() {
        return !this.doc || this.doc.visibilityState === 'visible';
    }

    // Your heir has taken over (modes.js).
    succession() {
        this.autosave('heir');
    }

    // ---- Saving ----

    // A save of the world now, kept in `slot`: {slot, savedAt, run, meta, page, data}.
    async capture(slot) {
        const t0 = performance.now();
        const reply = await this.world.save(slot);
        const page = this.env.record();
        const kept = { slot, savedAt: Date.now(), run: page.run, version: reply.data.version, meta: reply.data.meta, page, data: reply.data };
        this.last = { slot, ms: reply.ms, bytes: reply.bytes, captureMs: performance.now() - t0 };
        return kept;
    }

    async keep(kept) {
        const t0 = performance.now();
        await this.store.put(kept);
        this.last.storeMs = performance.now() - t0;
        const { data, ...summary } = kept;
        this.slots.set(kept.slot, summary);
        this.keptAt = kept.meta.time;
        this.problem = null;
    }

    // The autosave, for `reason` ('dawn', 'hidden', 'closed', 'heir', 'home'): not
    // while "continue" is offered, nor on the home screen, nor twice for the
    // same moment.
    async autosave(reason) {
        if (this.offered || this.busy || this.env.quiet?.() || !this.world.p || this.world.time === this.lastAuto) return false;
        this.busy = true;
        try {
            const kept = await this.capture('auto');
            this.lastAuto = kept.meta.time;
            const before = this.slots.get('auto');
            if (before && before.run !== kept.run) {
                await this.store.move('auto', 'previous'); // (another game's: kept one game back)
                this.slots.set('previous', { ...before, slot: 'previous' });
                this.slots.delete('auto');
            }
            await this.keep(kept);
            this.last.reason = reason;
            if (this.isOpen) this.render();
            return true;
        } catch (err) {
            this.problem = err?.message ?? String(err);
            if (this.isOpen) this.render();
            return false;
        } finally {
            this.busy = false;
        }
    }

    // Save by hand to slot 1, 2 or 3. → the line to show.
    async save(slot) {
        slot = String(slot);
        if (!MANUAL.includes(slot)) throw new Error(`no such slot: ${slot} (1, 2 or 3)`);
        const kept = await this.capture(slot);
        await this.keep(kept);
        this.dismiss();
        const l = this.last;
        return `saved to ${NAMES[slot]}: ${kept.meta.date} (${l.ms.toFixed(1)} ms in the simulation, ${mb(l.bytes)})`;
    }

    // ---- Loading ----

    // Carry on from slot `slot`. → the line to show; throws if it cannot.
    async load(slot) {
        slot = String(slot);
        if (!NAMES[slot]) throw new Error(`no such slot: ${slot} (1, 2, 3 or auto)`);
        const kept = await this.store.get(slot);
        if (!kept) throw new Error(`${NAMES[slot]} is empty`);
        this.resume(kept);
        return `loaded ${NAMES[slot]}: ${kept.meta.date}, seed ${kept.meta.seed}`;
    }

    resume(kept) {
        this.env.resume(kept);
        this.dismiss();
        this.newWorld();
        this.lastAuto = kept.meta.time; // (nothing new to autosave yet)
        this.keptAt = kept.meta.time;
        if (this.isOpen) this.close(false);
    }

    // ---- Files ----

    download(kept) {
        const bytes = packFile(kept);
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = this.doc.createElement('a');
        const stamp = new Date(kept.savedAt).toISOString().slice(0, 16).replace(/[-T:]/g, '');
        a.href = url;
        a.download = `life-${kept.meta.seed}-${stamp}.lifesave`;
        this.doc.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return bytes.byteLength;
    }

    async exportNow() {
        try {
            const kept = await this.capture('file');
            const n = this.download(kept);
            this.say(`exported this game (${mb(n)})`);
        } catch (err) {
            this.say(err?.message ?? String(err), true);
        }
    }

    async importFile(file) {
        try {
            const kept = unpackFile(await file.arrayBuffer());
            this.resume({ ...kept, slot: null });
        } catch (err) {
            this.say(err instanceof SaveError ? err.message : `This file cannot be read: ${err?.message ?? err}`, true);
        }
    }

    // ---- The menu ----

    toggle(fromBody = false) {
        if (this.isOpen) this.close();
        else this.open(fromBody);
    }

    // Open it; from a body (P), the world waits until it closes. `only`
    // 'load': for loading alone (from the home screen).
    open(fromBody = false, only = null) {
        if (this.isOpen) return;
        this.isOpen = true;
        this.only = only;
        if (this.exportEl) this.exportEl.hidden = only === 'load';
        this.openedAt = typeof performance !== 'undefined' ? performance.now() : 0;
        this.paused = fromBody && !this.env.getPaused();
        if (this.paused) this.env.setPaused(true);
        const input = this.env.input;
        if (input) {
            input.clear();
            input.unlock();
            input.blocked = true;
        }
        this.status = '';
        if (this.root) this.root.hidden = false;
        this.render();
        this.refresh().then(() => this.render());
    }

    // Close it (`resume`: a pause it made ends).
    close(resume = true) {
        if (!this.isOpen) return;
        this.isOpen = false;
        if (this.env.input) this.env.input.blocked = false;
        if (this.root) this.root.hidden = true;
        if (this.paused && resume) this.env.setPaused(false);
        this.paused = false;
        this.confirming = null;
        this.env.closed?.();
    }

    async refresh() {
        try {
            this.slots = await this.store.list();
            this.problem = null;
        } catch (err) {
            this.problem = err instanceof StorageError ? err.message : String(err?.message ?? err);
        }
    }

    say(text, bad = false) {
        this.status = text;
        this.statusBad = bad;
        if (this.statusEl) {
            this.statusEl.textContent = text;
            this.statusEl.classList.toggle('bad', bad);
        }
    }

    // A button: save, load, export, delete (the first two over a kept save,
    // and delete, ask once more).
    async act(slot, act) {
        const kept = this.slots.get(slot);
        const sure = (act === 'delete' || (act === 'save' && kept)) && !this.confirmed(slot, act);
        if (sure) {
            this.confirming = { slot, act, until: performance.now() + CONFIRM_MS };
            this.render();
            setTimeout(() => {
                if (this.confirming?.slot === slot && performance.now() >= this.confirming.until) {
                    this.confirming = null;
                    if (this.isOpen) this.render();
                }
            }, CONFIRM_MS + 50);
            return;
        }
        this.confirming = null;
        try {
            if (act === 'save') this.say(await this.save(slot));
            else if (act === 'load') this.say(await this.load(slot));
            else if (act === 'delete') {
                await this.store.remove(slot);
                this.slots.delete(slot);
                this.say(`${NAMES[slot]} deleted`);
            } else if (act === 'export') {
                const whole = await this.store.get(slot);
                if (!whole) throw new Error(`${NAMES[slot]} is empty`);
                this.say(`exported ${NAMES[slot]} (${mb(this.download(whole))})`);
            }
        } catch (err) {
            this.say(err?.message ?? String(err), true);
        }
        if (this.isOpen) this.render();
    }

    confirmed(slot, act) {
        const c = this.confirming;
        return !!c && c.slot === slot && c.act === act && performance.now() < c.until;
    }

    // The menu's rows: the autosave, an earlier game's (if kept), the three slots.
    rows() {
        const out = [];
        for (const slot of ['auto', 'previous', ...MANUAL]) {
            const kept = this.slots.get(slot) ?? null;
            if (slot === 'previous' && !kept) continue;
            const acts = kept ? ['load', 'export', 'delete'] : [];
            if (MANUAL.includes(slot) && this.only !== 'load') acts.unshift('save');
            out.push({ slot, name: NAMES[slot], kept, acts });
        }
        return out;
    }

    render() {
        if (!this.root) return;
        const doc = this.doc;
        const w = this.world;
        this.subEl.textContent = this.only === 'load' ? 'carry on a game'
            : w.p ? `this game: ${dateLabel(w.p.calendar, w.time)} · seed ${w.seed}` : '';
        const rows = this.rows().map(({ slot, name, kept, acts }) => {
            const row = doc.createElement('div');
            row.className = `sv-row${kept ? '' : ' empty'}`;
            const n = doc.createElement('div');
            n.className = 'sv-name';
            n.textContent = name;
            const info = doc.createElement('div');
            info.className = 'sv-info';
            if (kept) {
                const date = doc.createElement('div');
                date.textContent = kept.meta.date;
                const who = doc.createElement('div');
                who.className = 'muted';
                who.textContent = `${whoOf(kept.meta)} · seed ${kept.meta.seed}`;
                const when = doc.createElement('div');
                when.className = 'muted when';
                const old = kept.version !== SAVE_VERSION ? ' · another version: cannot be loaded' : '';
                when.textContent = `saved ${whenOf(kept.savedAt)}${old}`;
                info.append(date, who, when);
            } else {
                info.className += ' muted';
                info.textContent = 'empty';
            }
            const buttons = doc.createElement('div');
            buttons.className = 'sv-acts';
            for (const act of acts) {
                const b = doc.createElement('button');
                b.type = 'button';
                b.dataset.slot = slot;
                b.dataset.act = act;
                const asking = this.confirming && this.confirming.slot === slot && this.confirming.act === act;
                b.textContent = asking ? 'sure?' : act;
                if (asking) b.classList.add('sure');
                if (act === 'load' || act === 'save') b.classList.add('main');
                buttons.append(b);
            }
            row.append(n, info, buttons);
            return row;
        });
        this.listEl.replaceChildren(...rows);
        if (this.problem) this.say(this.problem, true);
        else if (this.statusEl) {
            this.statusEl.textContent = this.status;
            this.statusEl.classList.toggle('bad', !!this.statusBad);
        }
    }
}
