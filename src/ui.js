// The one panel: controls, the individual being followed, population
// sparklines, average genes and the list of tribes. And the way into play
// (play/modes.js): "become them" on a person's card, Play with its choice of
// tribe, and, while your person is on the map, a bar to return to them. In
// a body the panel hides, and its shortcuts wait.
import { COLORS } from './render.js';
import { drawFlag } from './flag.js';
import { STATE, STATE_LABEL } from './world.js';
import { personName, ageText, years } from './play/names.js';
import { mostExperienced, eldestOf } from './play/modes.js';

// States shown in the alarm colour.
const ALARM = new Set([STATE.FLEEING, STATE.CHASING, STATE.FIGHTING, STATE.RAIDING]);
const PEOPLE_COLOR = '#7fb3ff';

const HISTORY = 480; // samples kept per sparkline

const ICONS = {
    pause: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="3" width="3" height="10" rx="0.6"/><rect x="9.5" y="3" width="3" height="10" rx="0.6"/></svg>',
    play: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z"/></svg>',
};

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

class Sparkline {
    constructor(canvas, color, fixedMax = null) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.color = color;
        this.fixedMax = fixedMax;
        this.data = new Float32Array(HISTORY);
        this.len = 0;
        this.head = 0;
    }

    clear() {
        this.len = 0;
        this.head = 0;
    }

    push(v) {
        this.data[this.head] = v;
        this.head = (this.head + 1) % HISTORY;
        if (this.len < HISTORY) this.len++;
    }

    draw() {
        const { canvas, ctx, data, len } = this;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        if (len < 2) return;

        // Honest baseline: the y-axis always starts at zero.
        let max = this.fixedMax ?? 0;
        if (this.fixedMax === null) for (let k = 0; k < len; k++) max = Math.max(max, data[k]);
        if (max <= 0) return;

        const start = len < HISTORY ? 0 : this.head;
        const dx = w / (HISTORY - 1);
        const x0 = w - (len - 1) * dx;
        ctx.beginPath();
        for (let k = 0; k < len; k++) {
            const v = data[(start + k) % HISTORY];
            const x = x0 + k * dx;
            const y = h - 1 - (v / max) * (h - 2);
            if (k === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = this.color;
        ctx.lineWidth = 1.25;
        ctx.lineJoin = 'round';
        ctx.stroke();
    }
}

export class Panel {
    // actions: { togglePause, setSpeed(n), reset(byKey), start(seed), setView(v), cycleView,
    //            unfollow, followDescendant, followAnother, followTribe(id),
    //            becomeLabel(id) → 'become them' | null, become(id), openPicker,
    //            play(tribeId), back(), stop(), setBlood(on) }
    constructor(actions) {
        this.$ = (id) => document.getElementById(id);
        this.actions = actions;
        this.tribeRows = new Map();
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
        this.$('play-return').addEventListener('click', () => actions.back());
        this.$('play-stop').addEventListener('click', () => actions.stop());
        this.$('blood').addEventListener('click', () => actions.setBlood(!this.blood));

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

    // Play: the living tribes, each with who you would begin as.
    openPicker(world) {
        const list = this.$('picker-list');
        list.textContent = '';
        // (Counted here: a tribe's own count waits for the world's first step.)
        const members = new Map();
        const pop = world.humans;
        for (let i = 0; i < pop.n; i++) members.set(pop.tribe[i], (members.get(pop.tribe[i]) ?? 0) + 1);
        for (const t of [...world.tribes].sort((a, b) => (members.get(b.id) ?? 0) - (members.get(a.id) ?? 0))) {
            const id = mostExperienced(world, t.id) || eldestOf(world, t.id);
            if (!id) continue;
            const found = world.find(id);
            const row = document.createElement('button');
            row.className = 'pick-row';
            row.dataset.tribe = t.id;
            row.title = `Lead the ${t.name}`;
            row.innerHTML = '<canvas width="36" height="24"></canvas><span class="name"><span class="t"></span><span class="as"></span></span><span class="n"></span>'
                + '<span class="bar aggr"><span></span></span><span class="bar soc"><span></span></span>';
            drawFlag(row.querySelector('canvas').getContext('2d'), t.flag, 0, 0, 36, 24);
            row.querySelector('.t').textContent = t.name;
            const kills = found ? found.pop.kills[found.i] : 0;
            row.querySelector('.as').textContent = `as ${personName(id)}${found ? `, ${ageText(found.pop.age[found.i])}` : ''}`
                + `${kills ? `, ${kills} ${kills === 1 ? 'kill' : 'kills'}` : ''}`;
            row.querySelector('.n').textContent = members.get(t.id) ?? 0;
            row.querySelector('.aggr span').style.width = `${t.aggression * 100}%`;
            row.querySelector('.soc span').style.width = `${t.sociality * 100}%`;
            list.appendChild(row);
        }
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
    // alive, how its story ended once it is not.
    showFollow(world, id, target) {
        const $ = this.$;
        const card = $('follow');
        card.hidden = !id;
        this.followId = id;
        $('panel').classList.toggle('following', !!id);
        if (!id) return;

        const fate = world.fate && world.fate.id === id ? world.fate : null;
        const kind = target ? target.kind : fate ? fate.kind : 'herbivore';
        const P = world.p[kind];
        const person = kind === 'human';
        $('f-swatch').className = `swatch ${kind}`;
        $('f-name').textContent = person ? personName(id) : `${kind} #${id}`;
        // Become them.
        const become = $('f-become');
        const label = person && target ? this.actions.becomeLabel(id) : null;
        become.hidden = !label;
        if (label && become.textContent !== label) {
            become.textContent = label;
            become.title = 'Play as this person';
        }
        for (const k of ['f-kills-k', 'f-kills-m', 'f-kills']) $(k).hidden = kind === 'herbivore';
        for (const k of ['f-carry-k', 'f-carry-m', 'f-carry']) $(k).hidden = !person || !target;
        $('f-fate').hidden = !!target;

        // A person's tribe: flag, name and culture.
        const tribeId = person ? (target ? target.pop.tribe[target.i] : fate?.tribe) : 0;
        const tribe = tribeId ? world.tribeById.get(tribeId) ?? world.fallen.find((t) => t.id === tribeId) : null;
        $('f-tribe').hidden = !tribe;
        if (tribe) {
            const flag = $('f-flag');
            const ctx = flag.getContext('2d');
            ctx.clearRect(0, 0, flag.width, flag.height);
            drawFlag(ctx, tribe.flag, 0, 0, flag.width, flag.height);
            $('f-tribe-name').textContent = `of the ${tribe.name}${tribe.alive ? '' : ' (gone)'}`;
            $('f-culture').textContent = `aggr ${tribe.aggression.toFixed(2)} · social ${tribe.sociality.toFixed(2)}`;
        }

        if (target) {
            const { pop, i } = target;
            const state = pop.state[i];
            $('f-gen').textContent = `generation ${pop.generation[i]}`;
            $('f-state').textContent = STATE_LABEL[state];
            $('f-state').className = ALARM.has(state) ? 'alarm' : '';
            $('f-carry').textContent = Math.round(pop.carry[i]);
            const e = pop.energy[i];
            $('f-energy').textContent = Math.round(e);
            $('f-energy-bar').style.width = `${Math.min(100, (e / P.maxEnergy) * 100)}%`;
            const life = pop.age[i] / pop.lifespan[i];
            $('f-age').textContent = person ? ageText(pop.age[i]) : `${Math.round(life * 100)}%`;
            $('f-age-bar').style.width = `${Math.min(100, life * 100)}%`;
            const avg = world.meanGenes(pop);
            $('f-speed').textContent = pop.speedGene[i].toFixed(2);
            $('f-speed-avg').textContent = `avg ${avg.speed.toFixed(2)}`;
            $('f-sense').textContent = pop.senseGene[i].toFixed(2);
            $('f-sense-avg').textContent = `avg ${avg.sense.toFixed(2)}`;
            $('f-children').textContent = pop.children[i];
            $('f-kills').textContent = pop.kills[i];
            return;
        }

        // It died (or the world was reset under it).
        $('f-state').className = '';
        $('f-state').textContent = 'dead';
        $('f-energy').textContent = '0';
        $('f-energy-bar').style.width = '0%';
        if (!fate) {
            $('f-fate-text').textContent = 'Gone.';
            $('f-descendant').disabled = true;
            return;
        }
        const how = {
            eaten: `Eaten by carnivore #${fate.by}`,
            hunted: `Speared by ${personName(fate.by)}`,
            killed: fate.by ? `Killed by ${personName(fate.by)}` : 'Killed by defenders while raiding',
            starvation: 'Starved',
            'old age': 'Died of old age',
        }[fate.cause];
        const kids = `${fate.children} ${fate.children === 1 ? 'child' : 'children'}`;
        const kills = kind !== 'herbivore' ? `, ${fate.kills} ${fate.kills === 1 ? 'kill' : 'kills'}` : '';
        const when = person ? `aged ${years(fate.age)}` : `at age ${Math.round(fate.age)}`;
        $('f-fate-text').textContent = `${how} ${when}. Left ${kids}${kills}.`;
        $('f-children').textContent = fate.children;
        $('f-kills').textContent = fate.kills;
        $('f-descendant').disabled = !world.descendant(id);
    }

    // One row per living tribe, biggest first: flag, name, size, culture.
    // Rows are kept (not rebuilt) so a click is never lost to a refresh.
    updateTribes(world) {
        const list = this.$('tribe-list');
        const seen = new Set();
        for (const t of [...world.tribes].sort((a, b) => b.members - a.members)) {
            seen.add(t.id);
            let row = this.tribeRows.get(t.id);
            if (!row) {
                row = document.createElement('button');
                row.className = 'tribe-row';
                row.dataset.tribe = t.id;
                row.title = `Follow the eldest of the ${t.name}`;
                row.innerHTML = '<canvas width="36" height="24"></canvas><span class="name"></span><span class="n"></span>'
                    + '<span class="bar aggr"><span></span></span><span class="bar soc"><span></span></span>';
                drawFlag(row.querySelector('canvas').getContext('2d'), t.flag, 0, 0, 36, 24);
                row.querySelector('.name').textContent = t.name;
                row.querySelector('.aggr span').style.width = `${t.aggression * 100}%`;
                row.querySelector('.soc span').style.width = `${t.sociality * 100}%`;
                this.tribeRows.set(t.id, row);
            }
            row.querySelector('.n').textContent = t.members;
            list.appendChild(row); // (re)ordering keeps the biggest on top
        }
        for (const [id, row] of this.tribeRows) {
            if (seen.has(id)) continue;
            row.remove();
            this.tribeRows.delete(id);
        }
        this.$('tribes').hidden = !world.p.human.enabled;
        this.$('tribes-empty').hidden = world.tribes.length > 0;
    }

    reset(world) {
        this.closePicker();
        this.selfShown = null;
        for (const row of this.tribeRows.values()) row.remove();
        this.tribeRows = new Map(); // a new world reuses tribe ids
        for (const l of Object.values(this.lines)) l.clear();
        this.sample(world);
        this.update(world);
    }

    sample(world) {
        this.record(world.grass.mean(), world.herbivores.n, world.carnivores.n, world.humans.n);
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
        this.updateTribes(world);

        const gh = world.meanGenes(world.herbivores);
        const gc = world.meanGenes(world.carnivores);
        const fmt = (v, n) => (n ? v.toFixed(2) : '—');
        $('g-h-speed').textContent = fmt(gh.speed, world.herbivores.n);
        $('g-h-sense').textContent = fmt(gh.sense, world.herbivores.n);
        $('g-c-speed').textContent = fmt(gc.speed, world.carnivores.n);
        $('g-c-sense').textContent = fmt(gc.sense, world.carnivores.n);

        const t = world.time;
        const time = t < 1000 ? `${t}` : t < 1e6 ? `${(t / 1000).toFixed(1)}k` : `${(t / 1e6).toFixed(2)}M`;
        let status = `step ${time}${world.watch ? '' : ' · click anyone to follow them'}`;
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
