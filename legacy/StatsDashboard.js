// Statistics Dashboard - tracks and displays population data
import { animals } from './Animal.js';

export class StatsDashboard {
    constructor() {
        this.container = null;
        this.canvas = null;
        this.ctx = null;
        this.history = {
            trees: [],
            herbivores: [],
            carnivores: [],
            total: []
        };
        this.maxHistoryLength = 200; // Keep last 200 data points
        this.updateInterval = 10; // Update every 10 frames
        this.frameCounter = 0;
        this.totalBirths = 0;
        this.totalDeaths = 0;
        this.previousPopulation = 0;
    }

    init() {
        // Create dashboard container
        this.container = document.createElement('div');
        this.container.id = 'stats-dashboard';
        this.container.className = 'panel';
        this.container.style.cssText = `
            position: absolute;
            bottom: 12px;
            left: 12px;
            width: 232px;
            z-index: 10;
        `;

        // Header: title + collapse toggle
        const header = document.createElement('div');
        header.className = 'panel-header';
        const title = document.createElement('h3');
        title.textContent = 'Population';
        const toggle = document.createElement('button');
        toggle.className = 'panel-toggle';
        toggle.textContent = '–';
        header.appendChild(title);
        header.appendChild(toggle);
        this.container.appendChild(header);

        // Collapsible body
        const body = document.createElement('div');
        this.statsText = document.createElement('div');
        this.statsText.style.cssText = 'margin-bottom: 8px;';
        body.appendChild(this.statsText);

        this.canvas = document.createElement('canvas');
        this.canvas.width = 212;
        this.canvas.height = 96;
        body.appendChild(this.canvas);
        this.container.appendChild(body);
        this.ctx = this.canvas.getContext('2d');

        toggle.addEventListener('click', () => {
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? '' : 'none';
            toggle.textContent = hidden ? '–' : '+';
        });

        document.body.appendChild(this.container);
    }

    update() {
        this.frameCounter++;
        if (this.frameCounter < this.updateInterval) return;
        this.frameCounter = 0;

        // Count current populations
        const counts = {
            trees: 0,
            herbivores: 0,
            carnivores: 0
        };

        animals.forEach(animal => {
            if (animal.kind === 'tree') counts.trees++;
            else if (animal.kind === 'herbivore') counts.herbivores++;
            else if (animal.kind === 'carnivore') counts.carnivores++;
        });

        const total = counts.trees + counts.herbivores + counts.carnivores;

        // Track births and deaths
        if (total > this.previousPopulation) {
            this.totalBirths += (total - this.previousPopulation);
        } else if (total < this.previousPopulation) {
            this.totalDeaths += (this.previousPopulation - total);
        }
        this.previousPopulation = total;

        // Add to history
        this.history.trees.push(counts.trees);
        this.history.herbivores.push(counts.herbivores);
        this.history.carnivores.push(counts.carnivores);
        this.history.total.push(total);

        // Trim history if too long
        if (this.history.trees.length > this.maxHistoryLength) {
            this.history.trees.shift();
            this.history.herbivores.shift();
            this.history.carnivores.shift();
            this.history.total.shift();
        }

        this.render(counts, total);
    }

    render(counts, total) {
        // Update stats text
        this.statsText.innerHTML = `
            <div><span style="color:#7ee787;">🌳 ${counts.trees}</span>
                 &nbsp;<span style="color:#ffa657;">🦌 ${counts.herbivores}</span>
                 &nbsp;<span style="color:#ff7b72;">🦁 ${counts.carnivores}</span></div>
            <div style="color:#8892b0;">total ${total} &middot; ▲${this.totalBirths} ▼${this.totalDeaths}</div>
        `;

        // Draw chart
        this.drawChart();
    }

    drawChart() {
        const ctx = this.ctx;
        const width = this.canvas.width;
        const height = this.canvas.height;

        // Clear canvas
        ctx.clearRect(0, 0, width, height);

        if (this.history.total.length < 2) return;

        // Find max value for scaling
        const maxValue = Math.max(
            ...this.history.trees,
            ...this.history.herbivores,
            ...this.history.carnivores
        );

        if (maxValue === 0) return;

        // Draw grid lines
        ctx.strokeStyle = '#232a44';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = (height / 4) * i;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        // Draw lines for each species
        this.drawLine(this.history.trees, maxValue, '#7ee787', 2); // trees
        this.drawLine(this.history.herbivores, maxValue, '#ffa657', 2); // herbivores
        this.drawLine(this.history.carnivores, maxValue, '#ff7b72', 2); // carnivores

        // Draw scale labels
        ctx.fillStyle = '#8892b0';
        ctx.font = '10px "VT323", monospace';
        ctx.fillText('0', 5, height - 5);
        ctx.fillText(Math.round(maxValue).toString(), 5, 12);
    }

    drawLine(data, maxValue, color, lineWidth) {
        if (data.length < 2) return;

        const ctx = this.ctx;
        const width = this.canvas.width;
        const height = this.canvas.height;

        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();

        const step = width / (this.maxHistoryLength - 1);

        for (let i = 0; i < data.length; i++) {
            const x = i * step;
            const y = height - (data[i] / maxValue) * height;

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }

        ctx.stroke();
    }
}
