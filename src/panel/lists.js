// The panel's lists (ui.js): the living tribes, biggest first; the
// legendary items, newest first; and Play's choice of tribes. The first two
// keep their rows from one refresh to the next (only reordered), so a click
// is never lost to a refresh; the panel's own click handlers read each row's
// data-tribe or data-bearer.
import { drawFlag } from '../flag.js';
import { personName, ageText } from '../play/names.js';
import { mostExperienced, eldestOf } from '../play/modes.js';
import { legendRows } from '../play/gear.js';

const LEGENDS_SHOWN = 10; // rows in the Legends list at most (the newest)

// One row per living tribe: flag, name, size, culture.
export class TribeList {
    constructor($) {
        this.$ = $;
        this.rows = new Map(); // tribe id → its row
    }

    update(world) {
        const list = this.$('tribe-list');
        const seen = new Set();
        for (const t of [...world.tribes].sort((a, b) => b.members - a.members)) {
            seen.add(t.id);
            let row = this.rows.get(t.id);
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
                this.rows.set(t.id, row);
            }
            row.querySelector('.n').textContent = t.members;
            list.appendChild(row); // (re)ordering keeps the biggest on top
        }
        for (const [id, row] of this.rows) {
            if (seen.has(id)) continue;
            row.remove();
            this.rows.delete(id);
        }
        this.$('tribes').hidden = !world.p.human.enabled;
        this.$('tribes-empty').hidden = world.tribes.length > 0;
    }

    // A new world (which reuses tribe ids): no rows.
    reset() {
        for (const row of this.rows.values()) row.remove();
        this.rows = new Map();
    }
}

// The legendary items (gear.js's legendRows): flag, name, kind and bearer,
// kills, generations. A click follows the bearer; one lying on the ground
// cannot be followed.
export class LegendList {
    constructor($) {
        this.$ = $;
        this.rows = new Map(); // item id → its row
    }

    update(world) {
        const all = legendRows(world);
        const rows = all.slice(0, LEGENDS_SHOWN);
        const list = this.$('legend-list');
        const seen = new Set();
        for (const r of rows) {
            seen.add(r.id);
            let row = this.rows.get(r.id);
            if (!row) {
                row = document.createElement('button');
                row.className = 'legend-row';
                row.innerHTML = '<canvas width="36" height="24"></canvas><span class="name"><span class="t"></span><span class="as"></span></span>'
                    + '<span class="n kills"></span><span class="n gens"></span>';
                row.querySelector('.t').textContent = r.name;
                row.flagOf = 0;
                this.rows.set(r.id, row);
            }
            const tribeId = r.tribe ? r.tribe.id : 0;
            if (row.flagOf !== tribeId) {
                row.flagOf = tribeId;
                const ctx = row.querySelector('canvas').getContext('2d');
                ctx.clearRect(0, 0, 36, 24);
                if (r.tribe) drawFlag(ctx, r.tribe.flag, 0, 0, 36, 24);
            }
            row.dataset.bearer = r.bearer;
            row.disabled = !r.bearer;
            const as = `${r.kind} · ${r.bearer ? r.bearerName : r.where}${r.tribe ? `, ${r.tribe.name}` : ''}`;
            if (row.querySelector('.as').textContent !== as) row.querySelector('.as').textContent = as;
            row.title = r.bearer ? `Follow ${r.bearerName}, who bears ${r.name}` : `${r.name} lies on the ground`;
            row.querySelector('.kills').textContent = r.kills;
            row.querySelector('.gens').textContent = r.gens;
            list.appendChild(row); // (newest on top)
        }
        for (const [id, row] of this.rows) {
            if (seen.has(id)) continue;
            row.remove();
            this.rows.delete(id);
        }
        this.$('legends').hidden = !all.length;
        const more = this.$('legends-more');
        more.hidden = all.length <= LEGENDS_SHOWN;
        if (!more.hidden) more.textContent = `and ${all.length - LEGENDS_SHOWN} more`;
    }

    reset() {
        for (const row of this.rows.values()) row.remove();
        this.rows = new Map();
    }
}

// Play's choice: the living tribes, biggest first, each with who you would
// begin as (play/modes.js's rule), into the picker's list (rebuilt).
export function fillPicker($, world) {
    const list = $('picker-list');
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
}
