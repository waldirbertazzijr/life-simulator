// A species stored as parallel typed arrays ("struct of arrays"): an
// individual is just an index. Cache-friendly, and it creates no garbage.

// Genes are fixed for life, so their metabolic upkeep is computed once, at birth.
// The second line is each individual's biography: who it is, who its parent was,
// what it is doing and what it is reacting to (`focus`, an id). The third is
// for people: their tribe, the food they carry, and a camp they are raiding.
// The fourth, people's items (items.js): the weapon and the tool in hand (item
// ids, 0: none) and their kinds (`gear`: weapon × 8 + tool); a task (TASK in
// items.js), its progress, and the kind it makes; wood or flint carried home,
// and hides; and how many items each has made. The last, the seasons (stage
// 4): a reserve of fat, laid on in the good months and drawn on in the lean
// ones, and the step an animal last gave birth.
const FLOAT_FIELDS = [
    'x', 'y', 'heading', 'energy', 'age', 'lifespan', 'speedGene', 'senseGene', 'upkeep',
    'id', 'parent', 'lineage', 'generation', 'children', 'kills', 'focus',
    'tribe', 'carry', 'goal',
    'weapon', 'tool', 'gear', 'task', 'work', 'make', 'load', 'hides', 'crafted',
    'fat', 'bred',
];
const INT_FIELDS = ['timer', 'state'];

// What an individual is doing right now (`state`).
export const STATE = {
    GRAZING: 0, SEARCHING: 1, FLEEING: 2, ROAMING: 3, CHASING: 4, EATING: 5, RESTING: 6, SATED: 7,
    // people
    GATHERING: 8, HUNTING: 9, HOMEWARD: 10, AT_CAMP: 11, FIGHTING: 12, PLAYING: 13, AVOIDING: 14, RAIDING: 15,
    // the person the page controls (player.js)
    WALKING: 16, RUNNING: 17, CREEPING: 18, ROLLING: 19,
    // people the player leads (orders.js)
    FOLLOWING: 20, GUARDING: 21,
    // the controlled person's hands (player.js); with items, everyone's (items.js)
    BUTCHERING: 22,
    // items (items.js): going for and gathering wood, or flint; making an item
    CHOPPING: 23, QUARRYING: 24, CRAFTING: 25,
    // the night (stage 4): asleep at camp
    SLEEPING: 26,
};
export const STATE_LABEL = [
    'grazing', 'looking for grass', 'fleeing', 'looking for prey', 'chasing', 'eating', 'catching its breath', 'full, ambling',
    'gathering', 'hunting', 'carrying food home', 'resting at camp', 'fighting', 'playing at camp', 'avoiding strangers', 'raiding',
    'walking', 'running', 'creeping', 'rolling',
    'following the leader', 'guarding the camp',
    'butchering',
    'chopping wood', 'quarrying flint', 'crafting',
    'sleeping',
];

// One species, stored as parallel arrays. An individual is an index.
export class Population {
    constructor(capacity = 1024) {
        this.n = 0;
        this.capacity = 0;
        this.grow(capacity);
    }

    grow(capacity) {
        for (const f of FLOAT_FIELDS) {
            const next = new Float64Array(capacity);
            if (this[f]) next.set(this[f].subarray(0, this.n));
            this[f] = next;
        }
        for (const f of INT_FIELDS) {
            const next = new Int32Array(capacity);
            if (this[f]) next.set(this[f].subarray(0, this.n));
            this[f] = next;
        }
        this.columns = [...FLOAT_FIELDS, ...INT_FIELDS].map((f) => this[f]);
        // (The same, by kind, so compact() copies each kind in a loop of its own.)
        this.floatColumns = FLOAT_FIELDS.map((f) => this[f]);
        this.intColumns = INT_FIELDS.map((f) => this[f]);
        this.capacity = capacity;
    }

    // Make room for `extra` more individuals, so a step can cache the array
    // references up front without them being swapped out mid-loop.
    reserve(extra) {
        if (this.n + extra > this.capacity) this.grow(Math.max(this.capacity * 2, this.n + extra));
    }

    add() {
        if (this.n === this.capacity) this.grow(this.capacity * 2);
        const i = this.n++;
        this.timer[i] = 0;
        return i;
    }

    // Drop everyone with energy <= 0 by moving the last individual into each
    // gap: only the dead cost anything.
    compact() {
        const { energy, floatColumns, intColumns } = this;
        let n = this.n;
        for (let i = 0; i < n; ) {
            if (energy[i] > 0) {
                i++;
                continue;
            }
            n--;
            if (i !== n) {
                for (let k = 0; k < floatColumns.length; k++) floatColumns[k][i] = floatColumns[k][n];
                for (let k = 0; k < intColumns.length; k++) intColumns[k][i] = intColumns[k][n];
            }
        }
        this.n = n;
    }
}
