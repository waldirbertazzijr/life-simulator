// The one panel: controls, the individual being followed, population
// sparklines, average genes and the list of tribes. And the way into play
// (play/modes.js): "become them" on a person's card, Play with its choice of
// tribe, and, while your person is on the map, a bar to return to them. In
// a body the panel hides, and its shortcuts wait. Its save button opens the
// save menu (panel/saves.js, which also shows "continue" here).
//
// Its parts (panel/): the follow card (card.js), the lists of tribes and
// legends and Play's picker (lists.js), the sparklines (sparkline.js), and
// the credits (credits.js).
// The markup is in index.html; this wires it up and keeps it current.
import { COLORS } from './render.js';
import { drawFlag } from './flag.js';
import { personName } from './play/names.js';
import { callName, MATERIAL_CALLS } from './play/calls.js';
import { Sparkline } from './panel/sparkline.js';
import { fillCard } from './panel/card.js';
import { TribeList, LegendList, fillPicker } from './panel/lists.js';
import { wireCredits } from './panel/credits.js';
import { dateLabel } from './calendar.js';
import { clockOf } from './view3d/almanac.js';

const PEOPLE_COLOR = '#7fb3ff';

const ICONS = {
    pause: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="3" width="3" height="10" rx="0.6"/><rect x="9.5" y="3" width="3" height="10" rx="0.6"/></svg>',
    play: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z"/></svg>',
};

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Panel {
    // actions: { togglePause, setSpeed(n), reset(byKey), start(seed), setView(v), cycleView,
    //            unfollow, followDescendant, followAnother, followTribe(id), follow(id),
    //            becomeLabel(id) → 'become them' | null, become(id), openPicker,
    //            play(tribeId), back(), stop(), look() (the character editor), setBlood(on),
    //            saves() (the save menu: panel/saves.js), setQuality('high' | 'medium' | 'low') }
    constructor(actions) {
        this.$ = (id) => document.getElementById(id);
        this.actions = actions;
        this.tribes = new TribeList(this.$);
        this.legends = new LegendList(this.$);
        this.suspended = false; // in a body: the shortcuts are the body's (play/input.js)
        this.blood = true;
        this.followId = 0;
        this.selfShown = null;

        this.lines = {
            grass: new Sparkline(this.$('spark-grass'), css('--grass'), 1),
            herbivores: new Sparkline(this.$('spark-herbivores'), COLORS.herbivore),
            carnivores: new Sparkline(this.$('spark-carnivores'), COLORS.carnivore),
            humans: new Sparkline(this.$('spark-humans'), PEOPLE_COLOR),
        };

        wireCredits(this.$);
        this.$('pause').addEventListener('click', () => actions.togglePause());
        this.$('reset').addEventListener('click', () => actions.reset());
        this.$('collapse').addEventListener('click', () => this.toggleCollapsed());
        this.$('f-close').addEventListener('click', () => actions.unfollow());
        this.$('f-descendant').addEventListener('click', () => actions.followDescendant());
        this.$('f-another').addEventListener('click', () => actions.followAnother());
        this.$('tribe-list').addEventListener('click', (e) => {
            const row = e.target.closest('[data-tribe]');
            if (row) actions.followTribe(Number(row.dataset.tribe));
        });
        this.$('legend-list').addEventListener('click', (e) => {
            const row = e.target.closest('[data-bearer]');
            if (row && Number(row.dataset.bearer)) actions.follow(Number(row.dataset.bearer));
        });
        for (const b of document.querySelectorAll('[data-speed]')) {
            b.addEventListener('click', () => actions.setSpeed(Number(b.dataset.speed)));
        }
        for (const b of document.querySelectorAll('[data-view]')) {
            b.addEventListener('click', () => actions.setView(b.dataset.view));
        }
        this.$('f-become').addEventListener('click', () => actions.become(this.followId));
        this.$('play').addEventListener('click', () => {
            if (this.$('picker').hidden) actions.openPicker();
            else this.closePicker();
        });
        this.$('picker-close').addEventListener('click', () => this.closePicker());
        this.$('picker-list').addEventListener('click', (e) => {
            const row = e.target.closest('[data-tribe]');
            if (!row) return;
            this.closePicker();
            actions.play(Number(row.dataset.tribe));
        });
        this.$('play-look').addEventListener('click', () => actions.look());
        this.$('play-return').addEventListener('click', () => actions.back());
        this.$('play-stop').addEventListener('click', () => actions.stop());
        this.$('play-calls').addEventListener('click', (e) => {
            const b = e.target.closest('[data-call]');
            if (b) actions.armCall(b.dataset.call);
        });
        this.$('blood').addEventListener('click', () => actions.setBlood(!this.blood));
        this.$('saves-open').addEventListener('click', () => actions.saves());
        for (const b of document.querySelectorAll('[data-quality]')) {
            b.addEventListener('click', () => actions.setQuality(b.dataset.quality));
        }

        // The seed field: type a number, Enter starts that world; Escape (or
        // clicking away) puts back the current one. Keys typed here are the
        // field's alone: they do not reach the shortcuts below, nor anyone
        // else listening on the window (such as camera keys).
        const seed = this.$('seed');
        this.seedShown = '';
        seed.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                const n = Number(seed.value.trim());
                if (Number.isInteger(n) && n > 0) {
                    seed.blur();
                    actions.start(n);
                } else {
                    seed.select();
                }
            } else if (e.key === 'Escape') {
                seed.blur();
            }
        });
        seed.addEventListener('keyup', (e) => e.stopPropagation());
        seed.addEventListener('input', () => this.fitSeed());
        seed.addEventListener('focus', () => seed.select());
        seed.addEventListener('blur', () => {
            seed.value = this.seedShown;
            this.fitSeed();
        });

        window.addEventListener('keydown', (e) => {
            if (this.suspended || e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
            if (e.key === ' ') {
                e.preventDefault();
                actions.togglePause();
            } else if (e.key === 'r') actions.reset(true);
            else if (e.key === 'h') this.toggleCollapsed();
            else if (e.key === 'Escape') actions.unfollow();
            else if (e.key === 'v') actions.cycleView();
            else if (e.key === 'f') actions.followAnother();
            else {
                const speeds = [...document.querySelectorAll('[data-speed]')].map((b) => Number(b.dataset.speed));
                const k = Number(e.key) - 1;
                if (k >= 0 && k < speeds.length) actions.setSpeed(speeds[k]);
            }
        });
    }

    // The seed field is as wide as its digits, so it reads as part of the line.
    fitSeed() {
        const seed = this.$('seed');
        seed.style.width = `${Math.max(1, seed.value.length)}ch`;
    }

    // In a body the panel is hidden (index.html) and its shortcuts wait.
    suspend(on) {
        this.suspended = on;
        if (on) this.closePicker();
    }

    setBlood(on) {
        this.blood = on;
        const b = this.$('blood');
        b.title = on ? 'Blood: on' : 'Blood: off';
        b.setAttribute('aria-pressed', String(on));
    }

    // The graphics setting (view3d/graphics.js), or null: the 2D view has none.
    setQuality(quality) {
        this.$('quality').hidden = quality === null;
        for (const b of document.querySelectorAll('[data-quality]')) {
            b.setAttribute('aria-pressed', String(b.dataset.quality === quality));
        }
    }

    // Play and your person on the map: `play` = { can (the 3D view, not a
    // touch-only device), self, inBody, tribe (yours, or null), playing }.
    showPlay(world, play) {
        const $ = this.$;
        $('play').hidden = !play.can || !!play.self;
        const bar = $('play-bar');
        bar.hidden = !play.self || play.inBody;
        if (bar.hidden) return;
        const key = `${play.self}:${play.tribe?.id}`;
        if (key === this.selfShown) return;
        this.selfShown = key;
        const flag = $('play-flag');
        const ctx = flag.getContext('2d');
        ctx.clearRect(0, 0, flag.width, flag.height);
        if (play.tribe) drawFlag(ctx, play.tribe.flag, 0, 0, flag.width, flag.height);
        $('play-who').textContent = `${play.playing ? 'leading as' : 'playing'} ${personName(play.self)}`;
        $('play-who').title = play.tribe ? `${personName(play.self)} of the ${play.tribe.name}` : '';
    }

    // Calls to your tribe from the map (play/calls.js), under the bar above:
    // `calls` = { shown, armed (the call waiting for a click, or null),
    // order (your tribe's standing order, or null), hungry (the tribe feeds
    // itself before heeding it), materials (items are on: Gather wood and
    // flint can be given) }.
    showCalls(calls) {
        const $ = this.$;
        const row = $('play-calls');
        const line = $('play-order');
        row.hidden = !calls.shown;
        line.hidden = !calls.shown;
        if (!calls.shown) return;
        for (const b of row.querySelectorAll('[data-call]')) {
            b.setAttribute('aria-pressed', String(b.dataset.call === calls.armed));
            if (MATERIAL_CALLS.has(b.dataset.call)) b.hidden = !calls.materials;
        }
        const text = calls.armed ? `click the map: ${callName(calls.armed).toLowerCase()} there`
            : calls.order ? `standing order: ${callName(calls.order.kind).toLowerCase()}${calls.hungry ? ', once the camp is fed' : ''}`
            : 'no standing order';
        if (line.textContent !== text) line.textContent = text;
        line.classList.toggle('armed', !!calls.armed);
    }

    // Play: the living tribes, each with who you would begin as (lists.js).
    openPicker(world) {
        fillPicker(this.$, world);
        this.$('picker').hidden = false;
        if (this.$('panel').classList.contains('collapsed')) this.toggleCollapsed();
    }

    closePicker() {
        this.$('picker').hidden = true;
    }

    toggleCollapsed() {
        const panel = this.$('panel');
        panel.classList.toggle('collapsed');
        this.$('collapse').setAttribute('aria-expanded', String(!panel.classList.contains('collapsed')));
    }

    setPaused(paused) {
        const b = this.$('pause');
        b.innerHTML = paused ? ICONS.play : ICONS.pause;
        b.title = paused ? 'Play (space)' : 'Pause (space)';
    }

    setSpeed(speed) {
        for (const b of document.querySelectorAll('[data-speed]')) {
            b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === speed));
        }
    }

    setView(view) {
        for (const b of document.querySelectorAll('[data-view]')) {
            b.setAttribute('aria-pressed', String(b.dataset.view === view));
        }
    }

    // The card for the animal being followed: its state and biography while
    // alive, how its story ended once it is not (card.js).
    showFollow(world, id, target) {
        const $ = this.$;
        const card = $('follow');
        card.hidden = !id;
        this.followId = id;
        $('panel').classList.toggle('following', !!id);
        if (!id) return;
        fillCard($, world, id, target, this.actions);
    }

    reset(world) {
        this.closePicker();
        this.selfShown = null;
        this.tribes.reset(); // (a new world reuses tribe ids)
        this.legends.reset();
        for (const l of Object.values(this.lines)) l.clear();
        this.sample(world);
        this.update(world);
    }

    sample(world) {
        this.record(world.grass.mean(), world.herbivores.n, world.carnivores.n, world.humans.n);
    }

    // The sparklines' points, oldest first (kept with a save), and back.
    sparks() {
        const out = {};
        for (const [k, l] of Object.entries(this.lines)) out[k] = Array.from(l.values());
        return out;
    }

    restoreSparks(s) {
        if (!s || typeof s !== 'object') return;
        for (const [k, l] of Object.entries(this.lines)) {
            if (!Array.isArray(s[k])) continue;
            l.clear();
            for (const v of s[k]) if (Number.isFinite(v)) l.push(v);
        }
    }

    // One point on each sparkline (the simulation sends these every 50 steps).
    record(grass, herbivores, carnivores, humans) {
        this.lines.grass.push(grass);
        this.lines.herbivores.push(herbivores);
        this.lines.carnivores.push(carnivores);
        this.lines.humans.push(humans);
    }

    update(world) {
        const $ = this.$;
        $('n-grass').textContent = `${Math.round(world.grass.mean() * 100)}%`;
        $('n-herbivores').textContent = world.herbivores.n;
        $('n-carnivores').textContent = world.carnivores.n;
        $('n-humans').textContent = world.humans.n;
        this.tribes.update(world);
        this.legends.update(world);

        const gh = world.meanGenes(world.herbivores);
        const gc = world.meanGenes(world.carnivores);
        const fmt = (v, n) => (n ? v.toFixed(2) : '—');
        $('g-h-speed').textContent = fmt(gh.speed, world.herbivores.n);
        $('g-h-sense').textContent = fmt(gh.sense, world.herbivores.n);
        $('g-c-speed').textContent = fmt(gc.speed, world.carnivores.n);
        $('g-c-sense').textContent = fmt(gc.sense, world.carnivores.n);

        // The date (the calendar as the page shows it: view3d/almanac.js), and
        // the step count on hover.
        const t = world.time;
        const time = t < 1000 ? `${t}` : t < 1e6 ? `${(t / 1000).toFixed(1)}k` : `${(t / 1e6).toFixed(2)}M`;
        $('status').title = `step ${time}`;
        let status = `${dateLabel(world.p.calendar, clockOf(world))}${world.watch ? '' : ' · click anyone to follow them'}`;
        if (!world.herbivores.n || !world.carnivores.n) {
            status = `${world.herbivores.n ? 'carnivores' : 'herbivores'} went extinct · press R`;
        }
        $('status').textContent = status;
        // The seed, unless someone is typing one.
        this.seedShown = String(world.seed);
        if (document.activeElement !== $('seed') && $('seed').value !== this.seedShown) {
            $('seed').value = this.seedShown;
            this.fitSeed();
        }

        for (const l of Object.values(this.lines)) l.draw();
    }
}
