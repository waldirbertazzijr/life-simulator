// The one panel: controls, the individual being followed, population
// sparklines, average genes and the list of tribes.
import { COLORS, drawFlag } from './render.js';
import { STATE, STATE_LABEL } from './world.js';

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
    // actions: { togglePause, setSpeed(n), reset, setView(v), cycleView,
    //            unfollow, followDescendant, followAnother, followTribe(id) }
    constructor(actions) {
        this.$ = (id) => document.getElementById(id);
        this.actions = actions;
        this.tribeRows = new Map();

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

        window.addEventListener('keydown', (e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === ' ') {
                e.preventDefault();
                actions.togglePause();
            } else if (e.key === 'r') actions.reset();
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
        $('panel').classList.toggle('following', !!id);
        if (!id) return;

        const fate = world.fate && world.fate.id === id ? world.fate : null;
        const kind = target ? target.kind : fate ? fate.kind : 'herbivore';
        const P = world.p[kind];
        const person = kind === 'human';
        $('f-swatch').className = `swatch ${kind}`;
        $('f-name').textContent = `${person ? 'person' : kind} #${id}`;
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
            $('f-age').textContent = `${Math.round(life * 100)}%`;
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
            hunted: `Speared by person #${fate.by}`,
            killed: fate.by ? `Killed by person #${fate.by}` : 'Killed by defenders while raiding',
            starvation: 'Starved',
            'old age': 'Died of old age',
        }[fate.cause];
        const kids = `${fate.children} ${fate.children === 1 ? 'child' : 'children'}`;
        const kills = kind !== 'herbivore' ? `, ${fate.kills} ${fate.kills === 1 ? 'kill' : 'kills'}` : '';
        $('f-fate-text').textContent = `${how} at age ${Math.round(fate.age)}. Left ${kids}${kills}.`;
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
        for (const row of this.tribeRows.values()) row.remove();
        this.tribeRows = new Map(); // a new world reuses tribe ids
        for (const l of Object.values(this.lines)) l.clear();
        this.sample(world);
        this.update(world);
    }

    sample(world) {
        this.lines.grass.push(world.grass.mean());
        this.lines.herbivores.push(world.herbivores.n);
        this.lines.carnivores.push(world.carnivores.n);
        this.lines.humans.push(world.humans.n);
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
        let status = `step ${time} · seed ${world.seed}${world.watch ? '' : ' · click anyone to follow them'}`;
        if (!world.herbivores.n || !world.carnivores.n) {
            status = `${world.herbivores.n ? 'carnivores' : 'herbivores'} went extinct · press R`;
        }
        $('status').textContent = status;

        for (const l of Object.values(this.lines)) l.draw();
    }
}
