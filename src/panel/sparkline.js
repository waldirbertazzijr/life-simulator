// A sparkline: one population's recent history as a thin line on a small
// canvas in the panel (ui.js), the newest sample at the right edge.
export const HISTORY = 480; // samples kept per sparkline

export class Sparkline {
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

    // The samples kept, oldest first.
    *values() {
        for (let k = 0; k < this.len; k++) yield this.data[(this.head - this.len + k + HISTORY) % HISTORY];
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
