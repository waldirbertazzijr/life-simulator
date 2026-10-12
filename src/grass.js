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
    regrow(rate) {
        const g = this.g;
        const f = this.fertility;
        if (f === null) {
            for (let i = 0; i < g.length; i++) g[i] += rate * (1 - g[i]);
            return;
        }
        const r = rate * this.boost;
        for (let i = 0; i < g.length; i++) g[i] += r * (f[i] - g[i]);
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
