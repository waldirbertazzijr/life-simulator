// Uniform spatial grid (a.k.a. spatial hash) — the neighbour index.
//
// Drop-in replacement for Quadtree as far as callers are concerned: it exposes
// the same query(range, found) contract, returning every point p for which
// range.contains(p) is true. The ONLY observable difference from the quadtree is
// the ORDER in which those points come back (row-major cell order, insertion
// order within a cell) — the SET is identical.
//
// Why this is faster than a quadtree here:
//   • O(1) insert (compute a cell index, push) — no recursion, no node objects.
//   • O(1)-ish query (scan the handful of cells overlapping the query circle).
//   • The cell arrays are REUSED across frames (clear() just truncates them), so
//     after warm-up a whole frame allocates essentially nothing — no per-node
//     Rectangle/Quadtree churn, so the garbage collector stays quiet.
//
// Populations here are roughly uniform in density, which is exactly the case a
// uniform grid handles best (a quadtree's adaptivity buys you nothing when depth
// would be uniform anyway, and costs you allocation + pointer chasing).
//
// NOTE: like the quadtree it replaces, this index is NOT toroidal — a query near
// an edge does not wrap to the far side. That matches the old behaviour so the
// only thing that changes is neighbour order.
export class SpatialGrid {
    constructor(width, height, cellSize) {
        this.width = width;
        this.height = height;
        this.cellSize = cellSize;
        this.cols = Math.max(1, Math.ceil(width / cellSize));
        this.rows = Math.max(1, Math.ceil(height / cellSize));
        this.cells = new Array(this.cols * this.rows);
        for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
    }

    // Empty every cell but keep its backing storage (so refilling is alloc-free).
    clear() {
        const cells = this.cells;
        for (let i = 0; i < cells.length; i++) cells[i].length = 0;
    }

    insert(point) {
        let cx = (point.positionX / this.cellSize) | 0;
        let cy = (point.positionY / this.cellSize) | 0;
        // Clamp — positions are meant to be in-bounds, but a float at exactly
        // width/height (or a transient overshoot) must not index out of range.
        if (cx < 0) cx = 0; else if (cx >= this.cols) cx = this.cols - 1;
        if (cy < 0) cy = 0; else if (cy >= this.rows) cy = this.rows - 1;
        this.cells[cy * this.cols + cx].push(point);
    }

    // Collect every point inside `range` (a Circle: {x, y, radius, contains()}).
    // Same contract as Quadtree.query; different iteration order.
    query(range, found = []) {
        const cs = this.cellSize;
        const r = range.radius;
        let minCol = ((range.x - r) / cs) | 0;
        let maxCol = ((range.x + r) / cs) | 0;
        let minRow = ((range.y - r) / cs) | 0;
        let maxRow = ((range.y + r) / cs) | 0;
        if (minCol < 0) minCol = 0;
        if (minRow < 0) minRow = 0;
        if (maxCol >= this.cols) maxCol = this.cols - 1;
        if (maxRow >= this.rows) maxRow = this.rows - 1;

        const cells = this.cells;
        const cols = this.cols;
        for (let cy = minRow; cy <= maxRow; cy++) {
            const rowBase = cy * cols;
            for (let cx = minCol; cx <= maxCol; cx++) {
                const cell = cells[rowBase + cx];
                for (let i = 0; i < cell.length; i++) {
                    const p = cell[i];
                    if (range.contains(p)) found.push(p);
                }
            }
        }
        return found;
    }
}
