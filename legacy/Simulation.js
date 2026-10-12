// Main simulation logic
import { config } from './config.js';
import { populate } from './Animal.js';
import { step } from './Engine.js';
import { renderScene, createProcreationAnimation } from './Renderer.js';
import { Tooltip, initializeToolbar } from './UI.js';
import { StatsDashboard } from './StatsDashboard.js';
import { DayNightCycle } from './DayNightCycle.js';
import { EvolutionTracker } from './EvolutionTracker.js';

export class Simulation {
    constructor() {
        this.stats = new Stats();
        this.stats.showPanel(0);
        this.ctx = null;
        this.tooltip = null;
        this.statsDashboard = new StatsDashboard();
        this.dayNightCycle = new DayNightCycle();
        this.evolutionTracker = new EvolutionTracker();
        this.timeAccumulator = 0;  // leftover real-time, in ms, not yet turned into steps
        this.lastFrameTime = 0;    // timestamp of the previous animation frame
    }

    fixCanvasSize() {
        const winW = Math.max(window.innerWidth, document.documentElement.clientWidth);
        const winH = Math.max(window.innerHeight, document.documentElement.clientHeight);
        const refArea = config.world.referenceWidth * config.world.referenceHeight;
        const aspect = winW / winH;

        // Simulate in a world with the TUNED AREA but the window's aspect ratio.
        // This keeps population density — and therefore the balance the search
        // found — the same on any screen size. The canvas *buffer* is the
        // simulation size; CSS stretches it uniformly to fill the window (same
        // aspect ratio => no distortion).
        config.world.width = Math.round(Math.sqrt(refArea * aspect));
        config.world.height = Math.round(Math.sqrt(refArea / aspect));
        config.world.areaScale = (config.world.width * config.world.height) / refArea; // ~1.0

        config.canvas.width = config.world.width;
        config.canvas.height = config.world.height;
        config.canvas.style.width = winW + 'px';
        config.canvas.style.height = winH + 'px';
    }

    init() {
        config.canvas = document.getElementById('canvas');
        this.fixCanvasSize();

        this.ctx = config.canvas.getContext('2d');
        this.ctx.globalCompositeOperation = 'destination-over';

        this.tooltip = new Tooltip();
        initializeToolbar(this.tooltip);

        // Initialize statistics dashboard
        this.statsDashboard.init();

        // Initialize evolution tracker
        this.evolutionTracker.init();

        // Initialize populations
        populate('tree', config.trees.initialPopulation);
        populate('herbivore', config.herbivores.initialPopulation);
        populate('carnivore', config.carnivores.initialPopulation);

        // Start animation loop
        this.animate();
    }

    animate(now = performance.now()) {
        this.stats.begin();

        // Real time elapsed since the last frame (clamped so a background tab or a
        // very slow frame can't dump a huge backlog of steps at once).
        const dt = Math.min(Math.max(now - this.lastFrameTime, 0), 250);
        this.lastFrameTime = now;

        // Advance the simulation only while running. Steps are driven by REAL
        // elapsed time, so a given speed runs at the same wall-clock pace no matter
        // the frame rate. Under heavy load we run catch-up steps up to a cap; past
        // the cap the sim slows gracefully instead of spiralling.
        if (config.run) {
            const stepMs = 1000 / (config.targetStepsPerSecond || 60);
            this.timeAccumulator += dt * config.simulationSpeed;
            let steps = Math.floor(this.timeAccumulator / stepMs);
            const cap = config.maxStepsPerFrame || 40;
            if (steps > cap) {
                steps = cap;
                this.timeAccumulator = 0; // drop the unpayable backlog
            } else {
                this.timeAccumulator -= steps * stepMs;
            }
            for (let i = 0; i < steps; i++) {
                this.dayNightCycle.update(); // clock advances ONLY when running & stepping
                step(this.dayNightCycle, createProcreationAnimation);
            }
            if (steps > 0) {
                this.statsDashboard.update();
                this.evolutionTracker.update();
            }
        } else {
            this.timeAccumulator = 0; // no backlog builds up while paused
        }

        // Always paint (once per frame) — so a paused world stays visible and a
        // fast world renders once instead of many times.
        renderScene(this.ctx, this.dayNightCycle);
        this.stats.end();

        // Update time display
        const timeDisplay = document.getElementById('time-display');
        if (timeDisplay) {
            timeDisplay.textContent = `Day ${this.dayNightCycle.day} · ${this.dayNightCycle.getTimeString()}`;
        }

        // Update world-size display (stays current if the canvas is resized)
        const worldSizeDisplay = document.getElementById('world-size-display');
        if (worldSizeDisplay) {
            const pct = Math.round((config.world.areaScale || 1) * 100);
            worldSizeDisplay.textContent = `world: ${config.world.width} × ${config.world.height} · ${pct}% of tuned`;
        }

        window.requestAnimationFrame((t) => this.animate(t));
    }

    start() {
        document.body.appendChild(this.stats.dom);
        this.init();
    }
}
