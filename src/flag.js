// A tribe's flag, painted on any 2D canvas context. Shared by the 2D map, the
// 3D view (where it becomes a texture on a pole) and the panel.
const TAU = Math.PI * 2;

// Paint a tribe's flag into the rectangle (x, y, w, h).
export function drawFlag(ctx, flag, x, y, w, h) {
    const [a, b, c] = flag.colors;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    const fill = (color, fx, fy, fw, fh) => {
        ctx.fillStyle = color;
        ctx.fillRect(fx, fy, fw, fh);
    };
    switch (flag.pattern) {
        case 'bands':
            fill(a, x, y, w, h / 2);
            fill(b, x, y + h / 2, w, h / 2);
            break;
        case 'stripes':
            fill(a, x, y, w / 3, h);
            fill(b, x + w / 3, y, w / 3, h);
            fill(c, x + (2 * w) / 3, y, w / 3, h);
            break;
        case 'tricolor':
            fill(a, x, y, w, h / 3);
            fill(b, x, y + h / 3, w, h / 3);
            fill(c, x, y + (2 * h) / 3, w, h / 3);
            break;
        case 'diagonal':
            fill(a, x, y, w, h);
            ctx.fillStyle = b;
            ctx.beginPath();
            ctx.moveTo(x + w, y);
            ctx.lineTo(x + w, y + h);
            ctx.lineTo(x, y + h);
            ctx.fill();
            break;
        case 'cross':
            fill(a, x, y, w, h);
            fill(b, x + w * 0.3, y, w * 0.16, h);
            fill(b, x, y + h * 0.4, w, h * 0.2);
            break;
        case 'disc':
            fill(a, x, y, w, h);
            ctx.fillStyle = b;
            ctx.beginPath();
            ctx.arc(x + w / 2, y + h / 2, h * 0.3, 0, TAU);
            ctx.fill();
            break;
        case 'chevron':
            fill(a, x, y, w, h);
            ctx.fillStyle = b;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + w * 0.5, y + h / 2);
            ctx.lineTo(x, y + h);
            ctx.fill();
            break;
        default: // 'border'
            fill(b, x, y, w, h);
            fill(a, x + w * 0.2, y + h * 0.22, w * 0.6, h * 0.56);
    }
    ctx.restore();
}
