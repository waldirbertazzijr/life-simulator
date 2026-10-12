// Uniform-grid spatial hash over a torus. build() buckets a population with a
// counting sort (two passes, no allocation); nearest() scans only the buckets
// that overlap the search circle, wrapping around the world's edges.
export class SpatialHash {
    constructor(width, height, cellSize) {
        this.width = width;
        this.height = height;
        this.cols = Math.max(1, Math.floor(width / cellSize));
        this.rows = Math.max(1, Math.floor(height / cellSize));
        this.cellW = width / this.cols;
        this.cellH = height / this.rows;
        const cells = this.cols * this.rows;
        this.start = new Int32Array(cells + 1);
        this.cursor = new Int32Array(cells);
        this.items = new Int32Array(0);
        this.cellOf = new Int32Array(0);
        this.pop = null;
        // Offset to the result of the last nearest() call.
        this.dx = 0;
        this.dy = 0;
        this.d2 = 0;
    }

    build(pop) {
        if (this.items.length < pop.capacity) {
            this.items = new Int32Array(pop.capacity);
            this.cellOf = new Int32Array(pop.capacity);
        }
        const { start, cursor, items, cellOf, cols, rows, cellW, cellH } = this;
        const { x, y, energy, n } = pop;
        const cells = cols * rows;
        start.fill(0);
        for (let i = 0; i < n; i++) {
            if (energy[i] <= 0) {
                cellOf[i] = -1;
                continue;
            }
            let cx = (x[i] / cellW) | 0;
            let cy = (y[i] / cellH) | 0;
            if (cx >= cols) cx = cols - 1;
            if (cy >= rows) cy = rows - 1;
            const c = cy * cols + cx;
            cellOf[i] = c;
            start[c + 1]++;
        }
        for (let c = 0; c < cells; c++) start[c + 1] += start[c];
        cursor.set(start.subarray(0, cells));
        for (let i = 0; i < n; i++) {
            const c = cellOf[i];
            if (c >= 0) items[cursor[c]++] = i;
        }
        this.pop = pop;
    }

    // Index of the nearest living member within radius r of (px, py), or -1.
    // `skip` excludes one index (the asker itself, when searching its own kind).
    // `group`/`value`/`same` optionally keep only members whose group[i] equals
    // `value` (same = true: "a tribe-mate") or differs from it ("a stranger").
    nearest(px, py, r, skip = -1, group = null, value = 0, same = true) {
        return this.scan(px, py, r, skip, group, value, same, false);
    }

    // How many living members (with the same optional filters) are within r.
    count(px, py, r, skip = -1, group = null, value = 0, same = true) {
        return this.scan(px, py, r, skip, group, value, same, true);
    }

    scan(px, py, r, skip, group, value, same, counting) {
        const { start, items, cols, rows, cellW, cellH, width, height } = this;
        const { x, y, energy } = this.pop;
        const halfW = width / 2;
        const halfH = height / 2;

        // Exactly the buckets the circle's bounding box touches (may run off an
        // edge; the loops below wrap them around).
        const c0 = Math.floor((px - r) / cellW);
        const r0 = Math.floor((py - r) / cellH);
        const spanX = Math.min(Math.floor((px + r) / cellW) - c0 + 1, cols);
        const spanY = Math.min(Math.floor((py + r) / cellH) - r0 + 1, rows);
        const x0 = spanX === cols ? 0 : c0;
        const y0 = spanY === rows ? 0 : r0;

        const r2 = r * r;
        let best = -1;
        let bestD2 = r2;
        let found = 0;
        for (let j = 0; j < spanY; j++) {
            let row = y0 + j;
            if (row < 0) row += rows;
            else if (row >= rows) row -= rows;
            const rowBase = row * cols;
            for (let k = 0; k < spanX; k++) {
                let col = x0 + k;
                if (col < 0) col += cols;
                else if (col >= cols) col -= cols;
                const c = rowBase + col;
                for (let s = start[c], end = start[c + 1]; s < end; s++) {
                    const i = items[s];
                    if (i === skip || energy[i] <= 0) continue;
                    if (group !== null && (group[i] === value) !== same) continue;
                    let dx = x[i] - px;
                    if (dx > halfW) dx -= width;
                    else if (dx < -halfW) dx += width;
                    let dy = y[i] - py;
                    if (dy > halfH) dy -= height;
                    else if (dy < -halfH) dy += height;
                    const d2 = dx * dx + dy * dy;
                    if (counting) {
                        if (d2 < r2) found++;
                    } else if (d2 < bestD2) {
                        bestD2 = d2;
                        best = i;
                        this.dx = dx;
                        this.dy = dy;
                    }
                }
            }
        }
        if (counting) return found;
        this.d2 = bestD2;
        return best;
    }
}
