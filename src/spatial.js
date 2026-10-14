// Uniform-grid spatial hash over a torus. build() buckets a population with a
// counting sort (two passes, no allocation); nearest() scans only the buckets
// that overlap the search circle, wrapping around the world's edges.
//
// A `sparse` hash (few members over many buckets: the predators, the people)
// also marks, at build(), every bucket next to an occupied one, so that a
// small search where none is marked is answered at once: none near.
export class SpatialHash {
    constructor(width, height, cellSize, sparse = false, groupField = null) {
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
        // Sparse: 1 for each bucket with a member in it or in one of its eight
        // neighbours; searches no wider than `small` (a little under a bucket)
        // touch no buckets but these nine around their own.
        this.sparse = sparse;
        this.near = sparse ? new Uint8Array(cells) : null;
        this.small = 0.9 * Math.min(this.cellW, this.cellH);
        this.invW = 1 / this.cellW;
        this.invH = 1 / this.cellH;
        // Sparse, with a group column (the people's tribe): for each marked
        // bucket, the group all the members around it share, or NaN if they
        // differ (strangerNear). `groups` is the column the marks were read
        // from.
        this.groupField = sparse ? groupField : null;
        this.alike = this.groupField !== null ? new Float64Array(cells) : null;
        this.groups = null;
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
        for (let c = 1, sum = 0; c <= cells; c++) start[c] = sum += start[c]; // (start[0] is 0)
        cursor.set(start.subarray(0, cells));
        for (let i = 0; i < n; i++) {
            const c = cellOf[i];
            if (c >= 0) items[cursor[c]++] = i;
        }
        this.pop = pop;
        if (this.sparse) this.mark(n);
    }

    // Sparse: mark the nine buckets around each occupied one (wrapping), and
    // with a group column, the group the members around each share.
    mark(n) {
        const { near, alike, cellOf, cols, rows } = this;
        const group = alike !== null ? this.pop[this.groupField] : null;
        this.groups = group;
        near.fill(0);
        for (let i = 0; i < n; i++) {
            const c = cellOf[i];
            if (c < 0) continue;
            const cy = (c / cols) | 0;
            const cx = c - cy * cols;
            const g = group !== null ? group[i] : 0;
            for (let dy = -1; dy <= 1; dy++) {
                let row = cy + dy;
                if (row < 0) row += rows;
                else if (row >= rows) row -= rows;
                const base = row * cols;
                for (let dx = -1; dx <= 1; dx++) {
                    let col = cx + dx;
                    if (col < 0) col += cols;
                    else if (col >= cols) col -= cols;
                    const b = base + col;
                    if (group !== null) {
                        if (near[b] === 0) alike[b] = g;
                        else if (alike[b] !== g) alike[b] = NaN;
                    }
                    near[b] = 1;
                }
            }
        }
    }

    // The same as nearest(px, py, r, skip, group, value, false), the nearest
    // member of another group (a stranger), for an asker while the group
    // column holds what it held at build() (stepHumans: tribes change only
    // in stepTribes): when the marks show that everyone around shares the
    // asker's group, none, at once.
    strangerNear(px, py, r, skip, group, value) {
        if (this.alike !== null && group === this.groups && r <= this.small) {
            const c = this.bucketOf(px, py);
            if (c >= 0 && (this.near[c] === 0 || this.alike[c] === value)) {
                this.d2 = r * r; // (as a search that found none leaves it)
                return -1;
            }
        }
        return this.nearest(px, py, r, skip, group, value, false);
    }

    // Sparse, and a search within r of (px, py) small enough: does it touch
    // no bucket with a member in it? (Its box lies within the nine buckets
    // around the one (px, py) falls in: if a member's bucket is among those
    // nine, that one is among the member's. With r at most 0.9 of a bucket,
    // that holds for (px, py)'s bucket found by multiplying, as here, or by
    // dividing, as build() does: the two can differ only right at a bucket's
    // edge, and then the box reaches no farther than the next bucket over.)
    empty(px, py, r) {
        if (!this.sparse || !(r <= this.small)) return false;
        const c = this.bucketOf(px, py);
        return c >= 0 && this.near[c] === 0;
    }

    // The bucket (px, py) falls in, for empty(): -1 off the world.
    bucketOf(px, py) {
        if (!(px >= 0 && px < this.width && py >= 0 && py < this.height)) return -1;
        let cx = (px * this.invW) | 0;
        let cy = (py * this.invH) | 0;
        if (cx >= this.cols) cx = this.cols - 1;
        if (cy >= this.rows) cy = this.rows - 1;
        return cy * this.cols + cx;
    }

    // Do this hash and `other` share their buckets (both sparse, so that one
    // bucketOf() serves both empty() tests)?
    twin(other) {
        return this.sparse && other.sparse && this.cols === other.cols && this.rows === other.rows
            && this.cellW === other.cellW && this.cellH === other.cellH && this.width === other.width && this.height === other.height;
    }

    // Index of the nearest living member within radius r of (px, py), or -1.
    // `skip` excludes one index (the asker itself, when searching its own kind).
    // `group`/`value`/`same` optionally keep only members whose group[i] equals
    // `value` (same = true: "a tribe-mate") or differs from it ("a stranger").
    nearest(px, py, r, skip = -1, group = null, value = 0, same = true) {
        if (this.empty(px, py, r)) {
            this.d2 = r * r; // (as a search that found none leaves it)
            return -1;
        }
        return this.scan(px, py, r, skip, group, value, same, false, 0);
    }

    // How many living members (with the same optional filters) are within r.
    // With `limit`, it stops counting there (enough to tell "more than k" or
    // "at least k"): the answer is then min(count, limit).
    count(px, py, r, skip = -1, group = null, value = 0, same = true, limit = Infinity) {
        if (this.empty(px, py, r)) return 0;
        return this.scan(px, py, r, skip, group, value, same, true, limit);
    }

    // Would nearest(px, py, r, skip) find someone no farther than `first`
    // (d2 <= first², first < r)? True as soon as it meets one; false means
    // "ask nearest()" (none that near, or a world too small to tell). Members
    // may have moved up to `moved` since build() (bucketed where they were),
    // so it looks that much farther. It leaves no offsets behind.
    //
    // Why it agrees with nearest(): its buckets are a part of nearest()'s (a
    // smaller box inside the larger, neither wrapping onto itself), and
    // anything within `first` now was within first + moved at build(), so in
    // these buckets.
    closeBy(px, py, r, skip, first, moved) {
        const near = first + moved + 0.5; // (0.5: far beyond any rounding)
        if (!(near < r && 2 * r / this.cellW + 3 < this.cols && 2 * r / this.cellH + 3 < this.rows)) return false;
        const { start, items, cols, rows, cellW, cellH, width, height } = this;
        const { x, y, energy } = this.pop;
        const halfW = width / 2;
        const halfH = height / 2;
        const c0 = Math.floor((px - near) / cellW);
        const r0 = Math.floor((py - near) / cellH);
        const spanX = Math.floor((px + near) / cellW) - c0 + 1;
        const spanY = Math.floor((py + near) / cellH) - r0 + 1;
        const a = c0 < 0 ? c0 + cols : c0;
        const wraps = a + spanX > cols;
        const end1 = wraps ? cols : a + spanX;
        const end2 = wraps ? a + spanX - cols : 0;
        const f2 = first * first;
        for (let j = 0; j < spanY; j++) {
            let row = r0 + j;
            if (row < 0) row += rows;
            else if (row >= rows) row -= rows;
            const rowBase = row * cols;
            let s = start[rowBase + a];
            let end = start[rowBase + end1];
            for (let run = wraps ? 2 : 1; ;) {
                for (; s < end; s++) {
                    const i = items[s];
                    if (i === skip || energy[i] <= 0) continue;
                    let dx = x[i] - px;
                    if (dx > halfW) dx -= width;
                    else if (dx < -halfW) dx += width;
                    let dy = y[i] - py;
                    if (dy > halfH) dy -= height;
                    else if (dy < -halfH) dy += height;
                    if (dx * dx + dy * dy <= f2) return true;
                }
                if (--run === 0) break;
                s = start[rowBase];
                end = start[rowBase + end2];
            }
        }
        return false;
    }

    // The buckets the circle's bounding box touches, row by row. A row's
    // buckets are one run of the items array (two, where the box wraps past
    // the last column), so a row is read straight through, in the order the
    // buckets come in, and an empty row costs only a look at its two ends.
    scan(px, py, r, skip, group, value, same, counting, limit) {
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
        // The columns: a .. end1 - 1, then (wrapping) 0 .. end2 - 1.
        const a = x0 < 0 ? x0 + cols : x0;
        const wraps = a + spanX > cols;
        const end1 = wraps ? cols : a + spanX;
        const end2 = wraps ? a + spanX - cols : 0;

        const r2 = r * r;
        let best = -1;
        let bestD2 = r2;
        let found = 0;
        for (let j = 0; j < spanY; j++) {
            let row = y0 + j;
            if (row < 0) row += rows;
            else if (row >= rows) row -= rows;
            const rowBase = row * cols;
            let s = start[rowBase + a];
            let end = start[rowBase + end1];
            for (let run = wraps ? 2 : 1; ;) {
                for (; s < end; s++) {
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
                        if (d2 < r2 && ++found >= limit) return found;
                    } else if (d2 < bestD2) {
                        bestD2 = d2;
                        best = i;
                        this.dx = dx;
                        this.dy = dy;
                    }
                }
                if (--run === 0) break;
                s = start[rowBase];
                end = start[rowBase + end2];
            }
        }
        if (counting) return found;
        this.d2 = bestD2;
        return best;
    }
}
