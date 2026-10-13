// The home screen (spec §14): Hearthline's title over the living world, a
// slow camera drifting over a valley at dawn while the world runs on
// beneath, and the menu:
//
//   Continue           the autosave (only when there is one)
//   Begin a life       choose your people (3–4 tribes as cards; the camera
//                      flies to each camp), then who you are (the tribe's
//                      adults; the most experienced suggested), their look
//                      (the character editor), the promise, and into the
//                      body in Play mode, where the first steps are hinted
//                      (hints.js)
//   Oversee the world  the God view, with the panel
//   Load               the save menu, for loading (panel/saves.js)
//   Settings           hints, blood, graphics
//   Credits
//
// Away from it, a small mark at the top right comes back here, from the
// God view or a body. With a life in progress and not saved lately it asks
// first, and offers to save (the autosave, which Continue then carries on).
// Leaving a life lets go of it, and a fresh world dawns behind the title.
//
// While it is up, the keys are its own (↑ ↓ ← → or WASD, Enter, Esc), but
// for the editor's, the save menu's and the admin console's; the panel
// hides; the page's clock shows a dawn of its own (almanac.js setShift).
//
// `env` = {
//   doc, win          the DOM (none in tests)
//   world             the Mirror
//   saves             panel/saves.js Saves (slots, load, open, autosave, unsaved)
//   editor            play/editor.js Editor, or null (the flat view)
//   cinema            view3d/cinema.js Cinema, or null (the flat view)
//   canPlay, why      a life can be lived here (the 3D view and a mouse), or why not
//   settings          the rows of Settings: [{ id, label, options: [[value, text]], get(), set(v), again? }]
//   life(tribe, id)   into the body of `id`, in Play mode; true if it went
//   oversee()         the God view
//   leave(hadLife)    let go of whoever is played (a fresh world if a life was)
//   playing()         a life is in progress; name(): whose
//   shown(on)         the page around the home screen (panel, view, speed, keys)
//   input, setPaused(p), getPaused()
// }
import { drawFlag } from '../flag.js';
import { fillCredits } from '../panel/credits.js';
import { tribeCards, adultCards, deedsText, landOf } from './words.js';
import { valleyOf } from '../view3d/cinema.js';
import { heldDawn, setShift } from '../view3d/almanac.js';
import { smoothstep } from '../view3d/util.js';
import { personName } from '../play/names.js';

const EASE_OUT = 2.5;     // seconds for the sky to catch up with the world, leaving
const SUNRISE_YAW = -0.3; // the dawn looks east (the sun rises in +x), a little north of it
const DAWN_FLIGHT = 3;    // seconds to fly back to the dawn

// Who an autosave is about, for Continue: "Tiko of the Neto", or the world watched.
export function continueText(meta) {
    const p = meta?.player;
    const who = !p || !p.id || p.over ? 'watching the world'
        : p.tribeName ? `${p.name} of the ${p.tribeName}` : p.name;
    return `${who} · ${meta?.date ?? ''}`;
}

// The menu's items: Continue only with an autosave; Begin a life only where
// a life can be lived (else said why).
export function homeMenu({ autosave = null, canPlay = true, why = '' } = {}) {
    const items = [];
    if (autosave) items.push({ id: 'continue', label: 'Continue', sub: continueText(autosave.meta) });
    items.push({ id: 'begin', label: 'Begin a life', disabled: !canPlay, sub: canPlay ? '' : why });
    items.push({ id: 'oversee', label: 'Oversee the world' });
    items.push({ id: 'load', label: 'Load' });
    items.push({ id: 'settings', label: 'Settings' });
    items.push({ id: 'credits', label: 'Credits' });
    return items;
}

// The promise, in the game's voice.
export const PROMISE = [
    'Live a full life.',
    'Feed yourself, and feed your people.',
    'Keep warm through the winter.',
    'Raise a child, and name your heir.',
    'You will die. Your line goes on.',
];

// Each page: the element it shows, and where Esc goes back to.
const PAGES = {
    title: { el: 'home-title', back: null },
    settings: { el: 'home-settings', back: 'title' },
    credits: { el: 'home-credits', back: 'title' },
    people: { el: 'home-people', back: 'title' },
    who: { el: 'home-who', back: 'people' },
    look: { el: null, back: 'who' },
    promise: { el: 'home-promise', back: 'who' },
};

export class Home {
    constructor(env) {
        this.env = env;
        this.world = env.world;
        this.cinema = env.cinema ?? null;
        this.page = null;      // the page shown, or null: closed
        this.focus = 0;        // the item, card or row in focus
        this.items = [];       // the title's menu (homeMenu)
        this.tribes = [];      // the tribes' cards (words.js tribeCards)
        this.adults = [];      // the chosen tribe's adults (adultCards)
        this.tribe = null;     // the tribe chosen
        this.person = null;    // the adult chosen
        this.opened = 0;       // the world's time when the dawn began
        this.shift = 0;        // the clock's shift (almanac.js), easing out after
        this.easing = -1;      // seconds into easing it out, or -1
        this.easeFrom = 0;
        this.asking = false;   // the leave dialog is open
        this.touched = false;  // the menu's focus was moved by hand
        if (env.doc) this.bind(env.doc, env.win);
    }

    get isOpen() {
        return this.page !== null;
    }

    bind(doc, win) {
        this.doc = doc;
        const $ = (id) => doc.getElementById(id);
        this.$ = $;
        this.root = $('home');
        this.menuEl = $('home-menu');
        this.markEl = $('home-mark');
        this.leaveEl = $('leave');
        this.menuEl.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-go]');
            if (b && !b.disabled) this.go(b.dataset.go);
        });
        this.menuEl.addEventListener('pointermove', (e) => {
            const b = e.target.closest('button[data-go]');
            if (!b || b.disabled) return;
            const k = this.items.findIndex((it) => it.id === b.dataset.go);
            if (k >= 0 && k !== this.focus) this.setFocus(k);
        });
        for (const id of ['people', 'who']) {
            const list = $(`home-${id}-cards`);
            list.addEventListener('click', (e) => {
                const card = e.target.closest('[data-k]');
                if (!card) return;
                const k = Number(card.dataset.k);
                if (k === this.focus && e.detail >= 2) this.choose();
                else this.setFocus(k);
            });
        }
        $('home-people-choose').addEventListener('click', () => this.choose());
        $('home-who-choose').addEventListener('click', () => this.choose());
        $('home-promise-begin').addEventListener('click', () => this.begin());
        for (const b of this.root.querySelectorAll('[data-back]')) b.addEventListener('click', () => this.back());
        $('home-settings-rows').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-row]');
            if (!b) return;
            const row = this.env.settings.find((r) => r.id === b.dataset.row);
            if (!row) return;
            if (b.dataset.again) row.again?.();
            else row.set(b.dataset.value);
            this.renderSettings();
        });
        this.markEl.hidden = false; // (until the home screen opens)
        this.markEl.addEventListener('click', () => this.askHome());
        $('leave-save').addEventListener('click', () => this.leaveSaving());
        $('leave-go').addEventListener('click', () => this.goHome());
        $('leave-stay').addEventListener('click', () => this.stay());
        // While open, the keys are the home screen's (or the leave dialog's).
        win.addEventListener('keydown', (e) => this.key(e), true);
    }

    // ---- Open and close ----

    // Show the home screen at `page` (the title by default). `cut`: the
    // camera is there at once (the page opening), rather than flying.
    open(page = 'title', { cut = false } = {}) {
        const was = this.page;
        this.env.shown?.(true);
        if (this.root) this.root.hidden = false;
        if (this.markEl) this.markEl.hidden = true;
        if (was === null) {
            this.opened = this.world.time;
            this.easing = -1;
            this.dawn(cut);
        }
        this.show(page);
    }

    // Begin a life (also the story's "Play again"): choose your people.
    beginLife() {
        this.open('title');
        this.go('begin');
    }

    // The camera's dawn, over the valley that lies deepest (with life in it: a camp).
    dawn(cut) {
        const c = this.cinema;
        if (!c) return;
        const camps = this.world.tribes.map((t) => ({ camp: t.camp, land: landOf(this.world.terrain, t.camp.x, t.camp.y) }));
        const best = valleyOf(camps);
        const x = best ? best.camp.x : this.world.width / 2;
        const y = best ? best.camp.y : this.world.height / 2;
        const shot = c.dawn(x, y, SUNRISE_YAW);
        if (cut) c.cut(shot);
        else c.fly(shot, DAWN_FLIGHT);
    }

    // A new world behind the home screen (main.js start): its own dawn.
    newWorld() {
        if (!this.isOpen) return;
        this.opened = this.world.time;
        this.dawn(true);
        this.show('title');
    }

    // Close it: `to` 'oversee' (the camera rises to see the whole world),
    // 'life' (the body's camera takes over) or 'resumed' (a save put the
    // page as it was).
    close(to) {
        if (this.page === null) return;
        this.page = null;
        if (this.root) this.root.hidden = true;
        if (this.markEl) this.markEl.hidden = false;
        this.env.editor?.close();
        if (this.env.editor) this.env.editor.onClose = null;
        this.easing = 0;
        this.easeFrom = this.shift;
        const c = this.cinema;
        if (c) {
            if (to === 'oversee') c.fly(c.overview(), 2.6, true);
            else c.release();
        }
        this.env.shown?.(false);
    }

    // A save was loaded (from the menu, or anywhere): the page is as it was.
    resumed() {
        this.close('resumed');
    }

    // Each frame, before the camera (main.js): the dawn, and the camera's shot.
    frame(dt) {
        const w = this.world;
        if (w.p?.calendar) {
            const now = w.shown ?? w.time;
            if (this.page !== null) this.shift = heldDawn(w.p.calendar, this.opened, now) - now;
            else if (this.easing >= 0) {
                this.easing += dt;
                this.shift = this.easeFrom * (1 - smoothstep(0, EASE_OUT, this.easing));
                if (this.easing >= EASE_OUT) {
                    this.easing = -1;
                    this.shift = 0;
                }
            }
            setShift(this.shift);
        }
        this.cinema?.update(dt);
    }

    // ---- Pages ----

    show(page) {
        this.page = page;
        if (this.root) {
            for (const [name, p] of Object.entries(PAGES)) {
                if (p.el) this.$(p.el).hidden = name !== page;
            }
            this.root.dataset.page = page;
        }
        if (page === 'title') this.renderTitle();
        else if (page === 'settings') this.renderSettings();
        else if (page === 'credits') this.renderCredits();
        else if (page === 'people') this.renderPeople();
        else if (page === 'who') this.renderWho();
        else if (page === 'promise') this.renderPromise();
    }

    // What is kept may have changed (saves.js start, a save made): the menu again.
    refresh() {
        if (this.page === 'title') this.renderTitle();
    }

    renderTitle() {
        const saves = this.env.saves;
        const was = this.items[this.focus]?.id;
        this.items = homeMenu({ autosave: saves?.slots.get('auto') ?? null, canPlay: this.env.canPlay, why: this.env.why });
        const k = this.touched ? this.items.findIndex((it) => it.id === was) : -1;
        this.focus = k >= 0 ? k : this.items.findIndex((it) => !it.disabled);
        if (!this.menuEl) return;
        this.menuEl.replaceChildren(...this.items.map((it) => {
            const b = this.doc.createElement('button');
            b.type = 'button';
            b.dataset.go = it.id;
            b.disabled = !!it.disabled;
            const label = this.doc.createElement('span');
            label.className = 'label';
            label.textContent = it.label;
            b.append(label);
            if (it.sub) {
                const sub = this.doc.createElement('span');
                sub.className = 'sub';
                sub.textContent = it.sub;
                b.append(sub);
            }
            return b;
        }));
        this.lit();
    }

    renderSettings() {
        this.focus = Math.min(this.focus, this.env.settings.length - 1);
        if (!this.doc) return;
        const doc = this.doc;
        this.$('home-settings-rows').replaceChildren(...this.env.settings.map((row) => {
            const el = doc.createElement('div');
            el.className = 'set-row';
            el.dataset.id = row.id;
            const label = doc.createElement('span');
            label.className = 'set-label';
            label.textContent = row.label;
            const opts = doc.createElement('span');
            opts.className = 'set-opts';
            const now = String(row.get());
            for (const [value, text] of row.options) {
                const b = doc.createElement('button');
                b.type = 'button';
                b.dataset.row = row.id;
                b.dataset.value = String(value);
                b.textContent = text;
                b.setAttribute('aria-pressed', String(String(value) === now));
                opts.append(b);
            }
            el.append(label, opts);
            const again = row.again && row.againShown?.();
            if (again) {
                const b = doc.createElement('button');
                b.type = 'button';
                b.className = 'set-again';
                b.dataset.row = row.id;
                b.dataset.again = '1';
                b.textContent = row.againLabel ?? 'again';
                el.append(b);
            }
            return el;
        }));
        this.lit();
    }

    renderCredits() {
        const list = this.$?.('home-credit-list');
        if (list && !list.childElementCount) fillCredits(list);
    }

    // Choose your people: the tribes' cards, the camera at the first one's camp.
    renderPeople() {
        this.tribes = tribeCards(this.world);
        if (!this.tribes.length) {
            this.show('title');
            return;
        }
        const k = this.tribe ? this.tribes.findIndex((t) => t.id === this.tribe.id) : -1;
        if (this.doc) {
            const doc = this.doc;
            this.$('home-people-cards').replaceChildren(...this.tribes.map((t, i) => {
                const card = doc.createElement('button');
                card.type = 'button';
                card.className = 'card tribe-card';
                card.dataset.k = i;
                const flag = doc.createElement('canvas');
                flag.width = 66;
                flag.height = 44;
                drawFlag(flag.getContext('2d'), t.flag, 0, 0, 66, 44);
                const text = doc.createElement('span');
                text.className = 'card-text';
                text.append(
                    line(doc, 'name', t.name),
                    line(doc, 'culture', t.culture),
                    line(doc, 'size', `${t.members} people`),
                    line(doc, 'land', t.land),
                );
                card.append(flag, text);
                return card;
            }));
        }
        this.setFocus(k >= 0 ? k : 0, true);
    }

    // Choose who you are: the chosen tribe's adults, the most experienced first.
    renderWho() {
        const t = this.tribe;
        this.adults = t ? adultCards(this.world, t.id) : [];
        if (!this.adults.length) {
            this.show('people');
            return;
        }
        const k = this.person ? this.adults.findIndex((a) => a.id === this.person.id) : -1;
        if (this.doc) {
            const doc = this.doc;
            const flag = this.$('home-who-flag');
            const ctx = flag.getContext('2d');
            ctx.clearRect(0, 0, flag.width, flag.height);
            drawFlag(ctx, t.flag, 0, 0, flag.width, flag.height);
            this.$('home-who-tribe').textContent = `of the ${t.name}`;
            this.$('home-who-cards').replaceChildren(...this.adults.map((a, i) => {
                const card = doc.createElement('button');
                card.type = 'button';
                card.className = `card adult-card${a.suggested ? ' suggested' : ''}`;
                card.dataset.k = i;
                const head = line(doc, 'name', a.name);
                if (a.suggested) {
                    const tag = doc.createElement('span');
                    tag.className = 'tag';
                    tag.textContent = 'most experienced';
                    head.append(tag);
                }
                card.append(
                    head,
                    line(doc, 'age', `${a.years} years`),
                    line(doc, 'traits', a.traits.join(', ')),
                    line(doc, 'deeds', deedsText(a.kills, a.children)),
                );
                return card;
            }));
        }
        this.setFocus(k >= 0 ? k : 0, true);
    }

    renderPromise() {
        const p = this.person;
        const t = this.tribe;
        if (!this.doc || !p) return;
        this.$('home-promise-who').textContent = t ? `${p.name} of the ${t.name}` : p.name;
        this.$('home-promise-lines').replaceChildren(...PROMISE.map((text, i) => {
            const el = this.doc.createElement('p');
            el.textContent = text;
            el.style.animationDelay = `${0.35 + i * 0.55}s`;
            return el;
        }));
        this.$('home-promise-begin').style.animationDelay = `${0.35 + PROMISE.length * 0.55}s`;
    }

    // ---- Focus ----

    // The number of things to move between on this page.
    count() {
        return this.page === 'title' ? this.items.length
            : this.page === 'people' ? this.tribes.length
            : this.page === 'who' ? this.adults.length
            : this.page === 'settings' ? this.env.settings.length
            : 0;
    }

    setFocus(k, fresh = false) {
        const n = this.count();
        if (!n) return;
        const before = this.focus;
        this.focus = ((k % n) + n) % n;
        if (this.page === 'title' && this.items[this.focus]?.disabled && n > 1) {
            this.focus = (this.focus + (k < before ? -1 : 1) + n) % n; // (step over a disabled item)
        }
        if (this.page === 'people' && (fresh || this.focus !== before)) this.toCamp(this.tribes[this.focus]);
        if (this.page === 'who' && (fresh || this.focus !== before)) this.toPerson(this.adults[this.focus]);
        this.lit();
    }

    // Light the item in focus, and say what choosing does.
    lit() {
        if (!this.root) return;
        const page = this.page;
        const list = page === 'title' ? this.menuEl
            : page === 'people' ? this.$('home-people-cards')
            : page === 'who' ? this.$('home-who-cards')
            : page === 'settings' ? this.$('home-settings-rows') : null;
        if (!list) return;
        [...list.children].forEach((el, i) => el.classList.toggle('on', i === this.focus));
        const on = list.children[this.focus];
        if (on && page !== 'title') on.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'smooth' });
        if (page === 'people') this.$('home-people-choose').textContent = `Live among the ${this.tribes[this.focus].name}`;
        if (page === 'who') this.$('home-who-choose').textContent = `Be ${this.adults[this.focus].name}`;
    }

    // The camera to a tribe's camp, or to a person.
    toCamp(t) {
        const c = this.cinema;
        if (!c || !t) return;
        c.fly(c.camp(t.camp.x, t.camp.y, c.yaw));
    }

    toPerson(a) {
        const c = this.cinema;
        if (!c || !a) return;
        c.fly(c.person(a.id, c.yaw, this.world), 1.8);
    }

    // ---- Choosing ----

    // A menu item.
    go(id) {
        const it = this.items.find((x) => x.id === id);
        if (!it || it.disabled) return;
        if (id === 'continue') {
            this.env.saves.load('auto').catch((err) => {
                this.env.saves.open(false, 'load');
                this.env.saves.say(err?.message ?? String(err), true);
            });
        } else if (id === 'begin') {
            this.tribe = null;
            this.person = null;
            this.focus = 0;
            this.show('people');
        } else if (id === 'oversee') {
            this.close('oversee');
            this.env.oversee();
        } else if (id === 'load') {
            this.env.saves.open(false, 'load');
        } else {
            this.focus = 0;
            this.show(id);
        }
    }

    // Enter, or the page's button: what is in focus.
    choose() {
        const page = this.page;
        if (page === 'title') this.go(this.items[this.focus]?.id);
        else if (page === 'people') {
            this.tribe = this.tribes[this.focus] ?? null;
            this.person = null;
            if (this.tribe) this.show('who');
        } else if (page === 'who') {
            this.person = this.adults[this.focus] ?? null;
            if (this.person) this.look();
        } else if (page === 'promise') this.begin();
    }

    // The chosen person's look (the character editor), then the promise.
    look() {
        const ed = this.env.editor;
        if (!ed || !this.world.find(this.person.id)) {
            this.show(this.world.find(this.person.id) ? 'promise' : 'who');
            return;
        }
        this.show('look');
        ed.onClose = () => {
            ed.onClose = null;
            if (this.page === 'look') this.show('promise');
        };
        ed.open(this.person.id);
    }

    // Into the body: the life begins (Play mode). Should the person have
    // died while you chose, back to who you could be.
    begin() {
        const p = this.person;
        if (!p || !this.tribe) return;
        if (!this.world.find(p.id)) {
            this.person = null;
            this.show('who');
            return;
        }
        this.close('life');
        if (!this.env.life(this.tribe.id, p.id)) this.open('who');
    }

    back() {
        const to = PAGES[this.page]?.back;
        if (!to) return;
        const ed = this.env.editor;
        if (this.page === 'look' && ed) {
            ed.onClose = null;
            ed.close();
        }
        this.focus = 0;
        this.show(to);
    }

    // ---- The keys ----

    key(e) {
        if (this.asking) {
            e.stopPropagation();
            if (e.key === 'Escape') {
                e.preventDefault();
                this.stay();
            }
            return;
        }
        if (this.page === null || e.ctrlKey || e.metaKey || e.altKey) return;
        // (The editor's and the save menu's, open or just closed by this key.)
        if (e.defaultPrevented || this.env.editor?.isOpen || this.env.saves?.isOpen) return;
        if (e.code === 'Backquote' || e.code === 'F2') return; // (the admin console's)
        if (e.target instanceof Element && e.target.closest?.('input, textarea, select')) return;
        e.stopPropagation();
        const step = { ArrowUp: -1, KeyW: -1, ArrowDown: 1, KeyS: 1, ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 }[e.code];
        const across = ['ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD'].includes(e.code);
        if (step) {
            e.preventDefault();
            if (this.page === 'settings' && across) this.nudge(step);
            else if (this.page === 'title' || this.page === 'settings' || across) {
                this.touched = true;
                this.setFocus(this.focus + step);
            }
        } else if (e.key === 'Enter' || e.code === 'Space') {
            e.preventDefault();
            if (e.repeat) return;
            if (this.page === 'settings') this.nudge(1);
            else this.choose();
        } else if (e.key === 'Escape' || e.key === 'Backspace') {
            e.preventDefault();
            this.back();
        }
    }

    // Settings: the row in focus to its next (or previous) option.
    nudge(step) {
        const row = this.env.settings[this.focus];
        if (!row) return;
        const values = row.options.map(([v]) => String(v));
        const k = values.indexOf(String(row.get()));
        row.set(values[(k + step + values.length) % values.length]);
        this.renderSettings();
    }

    // ---- Going home, from anywhere ----

    // The home mark: with a life in progress and not saved lately, ask first.
    askHome() {
        if (this.isOpen) return;
        if (this.env.playing() && this.env.saves.unsaved()) this.ask();
        else this.goHome();
    }

    ask() {
        this.asking = true;
        this.pausedBefore = this.env.getPaused();
        this.env.setPaused(true);
        const input = this.env.input;
        if (input) {
            input.clear();
            input.unlock();
            input.blocked = true;
        }
        if (this.leaveEl) {
            this.$('leave-text').textContent = `${this.env.name()}'s life since the last save will be lost.`;
            this.$('leave-status').textContent = '';
            this.leaveEl.hidden = false;
        }
    }

    closeAsk() {
        if (!this.asking) return;
        this.asking = false;
        if (this.leaveEl) this.leaveEl.hidden = true;
        if (this.env.input) this.env.input.blocked = false;
    }

    stay() {
        this.closeAsk();
        this.env.setPaused(this.pausedBefore);
    }

    // Save (the autosave: Continue carries on from it), then go.
    async leaveSaving() {
        const ok = await this.env.saves.autosave('home');
        if (ok) this.goHome();
        else if (this.leaveEl) this.$('leave-status').textContent = this.env.saves.problem ?? 'It could not be saved.';
    }

    goHome() {
        const hadLife = this.env.playing();
        this.closeAsk();
        this.env.setPaused(false);
        this.env.leave(hadLife);
        this.open('title');
    }
}

// A line of a card: <span class="cls">text</span>.
function line(doc, cls, text) {
    const el = doc.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
}
