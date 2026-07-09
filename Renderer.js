// Rendering only. Advancing the world is Engine.step(); this file just paints
// the current state. Keeping them separate lets Simulation.animate() control
// speed and pause cleanly (step N times, paint once).
import { config } from './config.js';
import { animals } from './Animal.js';

const bg = new Image();
bg.src = config.images.background;

const drawBackground = (ctx) => {
    ctx.drawImage(bg, 0, 0);
};

let procreationAnimations = [];

export const createProcreationAnimation = (x, y) => {
    const animation = {
        x,
        y,
        frames: 30,
    };
    procreationAnimations.push(animation);
};

// Paint the current world. Does NOT mutate simulation state (except advancing
// the short-lived procreation "poof" animations, which are cosmetic only).
export const renderScene = (ctx, dayNightCycle) => {
    ctx.clearRect(0, 0, config.world.width, config.world.height);

    // Draw all animals.
    for (const animal of animals) {
        animal.draw(ctx);
    }

    // Draw the procreation animations
    procreationAnimations.forEach((anim, index) => {
        if (anim.frames > 0) {
            ctx.beginPath();
            ctx.arc(anim.x, anim.y, 30 * (anim.frames / 30), 0, config.visuals.procreationAnimations.radius * Math.PI);
            ctx.fillStyle = `rgba(255, 100, 0, ${anim.frames / 30})`;
            ctx.fill();
            anim.frames--;
        } else {
            procreationAnimations.splice(index, 1);
        }
    });

    // Draw the background
    drawBackground(ctx);

    // Draw day/night overlay on top (reset composite operation)
    if (dayNightCycle) {
        ctx.globalCompositeOperation = 'source-over';
        dayNightCycle.draw(ctx, config.world.width, config.world.height);
        ctx.globalCompositeOperation = 'destination-over';
    }
};
