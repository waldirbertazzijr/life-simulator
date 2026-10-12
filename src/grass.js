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
    }

    index(x, y) {
        let cx = (x * this.invW) | 0;
        let cy = (y * this.invH) | 0;
        if (cx >= this.cols) cx = this.cols - 1;
        if (cy >= this.rows) cy = this.rows - 1;
        return cy * this.cols + cx;
    }

    regrow(rate) {
        const g = this.g;
        for (let i = 0; i < g.length; i++) g[i] += rate * (1 - g[i]);
    }

    mean() {
        let s = 0;
        for (let i = 0; i < this.g.length; i++) s += this.g[i];
        return s / this.g.length;
    }
}
