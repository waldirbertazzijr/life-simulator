// Grass: a grid of patches, each holding 0..1 units of food.
export class Grass {
    constructor(width, height, cellSize, initial, rng) {
        this.cols = Math.max(1, Math.round(width / cellSize));
        this.rows = Math.max(1, Math.round(height / cellSize));
        this.cellW = width / this.cols;
        this.cellH = height / this.rows;
        this.invW = 1 / this.cellW;
        this.invH = 1 / this.cellH;
        this.g = new Float64Array(this.cols * this.rows);
        for (let i = 0; i < this.g.length; i++) this.g[i] = initial * (0.5 + rng.next());
        for (let i = 0; i < this.g.length; i++) if (this.g[i] > 1) this.g[i] = 1;
        this.fertility = null; // flat world: every patch can hold a full 1.0
        this.land = this.g.length;
        this.boost = 1;
        this.level = this.mean(); // the mean grass over the land (regrow keeps it)
    }

    // With terrain, each patch can hold at most its fertility (0 on water and
    // rock, 1 in the lowlands, less up the mountains).
    //
    // Water and rock take land away, and a smaller world holds fewer animals,
    // which §8 of THEORY.md says is dangerous. With `compensate`, the land that
    // is left regrows faster, by just enough that the whole world grows as much
    // food as a flat one would with the grass grazed down to `grazed`:
    // the same sunshine, landing in different places.
    setFertility(fertility, compensate, grazed) {
        const g = this.g;
        this.fertility = fertility;
        this.land = 0;
        let supply = 0;
        for (let i = 0; i < g.length; i++) {
            if (g[i] > fertility[i]) g[i] = fertility[i];
            if (fertility[i] > 0) this.land++;
            if (fertility[i] > grazed) supply += fertility[i] - grazed;
        }
        this.boost = compensate && supply > 0 ? (g.length * (1 - grazed)) / supply : 1;
        this.level = this.mean();
        // The runs of patches that can grow anything (from, to, from, to, ...).
        // Where nothing grows (fertility 0: water, bare rock), the grass is 0
        // and stays 0 (it was cut down to 0 above, and grazing and gathering
        // only ever take what is there), so regrow() can pass it by.
        const runs = [];
        for (let i = 0; i < g.length;) {
            if (fertility[i] === 0) {
                i++;
                continue;
            }
            const from = i;
            while (i < g.length && fertility[i] !== 0) i++;
            runs.push(from, i);
        }
        this.runs = Int32Array.from(runs);
    }

    index(x, y) {
        let cx = (x * this.invW) | 0;
        let cy = (y * this.invH) | 0;
        if (cx >= this.cols) cx = this.cols - 1;
        if (cy >= this.rows) cy = this.rows - 1;
        return cy * this.cols + cx;
    }

    // Supply-driven regrowth, like rain filling a pond: fastest when grazed
    // down, never from zero. With terrain each patch fills toward its own
    // fertility f instead of 1 (a smaller pond): g += rate·(f − g). Bare peaks
    // stay bare, water stays empty, and the regrowth is still supply-driven.
    // Also keeps `level`, the mean grass over the land after it (as mean()).
    regrow(rate) {
        const g = this.g;
        const f = this.fertility;
        let sum = 0;
        if (f === null) {
            for (let i = 0; i < g.length; i++) sum += g[i] += rate * (1 - g[i]);
        } else {
            const r = rate * this.boost;
            if (Number.isFinite(r)) {
                // Only where grass grows: elsewhere g is 0, stays 0 (0 + r·(0 − 0)),
                // and adds 0 to the sum, so the sum is the same to the bit.
                const runs = this.runs;
                for (let k = 0; k < runs.length; k += 2) {
                    for (let i = runs[k], end = runs[k + 1]; i < end; i++) sum += g[i] += r * (f[i] - g[i]);
                }
            } else {
                for (let i = 0; i < g.length; i++) sum += g[i] += r * (f[i] - g[i]);
            }
        }
        this.level = sum / (this.land || 1);
    }

    // Mean grass over the land (water holds none, so it is left out).
    mean() {
        const { g, fertility: f } = this;
        let s = 0;
        if (f === null) {
            for (let i = 0; i < g.length; i++) s += g[i];
        } else {
            for (let i = 0; i < g.length; i++) if (f[i] > 0) s += g[i];
        }
        return s / (this.land || 1);
    }
}
