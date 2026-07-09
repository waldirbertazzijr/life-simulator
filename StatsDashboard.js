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
            bottom: 10px;
            left: 10px;
            width: 300px;
            padding: 10px;
            z-index: 10;
        `;

        // Create title
        const title = document.createElement('h3');
        title.textContent = 'Population Statistics';
        title.style.cssText = 'margin: 0 0 10px 0; font-size: 14px;';
        this.container.appendChild(title);

        // Create stats text container
        this.statsText = document.createElement('div');
        this.statsText.style.cssText = 'margin-bottom: 10px; font-size: 11px;';
        this.container.appendChild(this.statsText);

        // Create canvas for chart
        this.canvas = document.createElement('canvas');
        this.canvas.width = 280;
        this.canvas.height = 120;
        this.canvas.style.cssText = 'border: 1px solid #333; background: white;';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');

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
            <div><span style="color: #228B22;">🌳 Trees:</span> ${counts.trees}</div>
            <div><span style="color: #FF8C00;">🦌 Herbivores:</span> ${counts.herbivores}</div>
            <div><span style="color: #DC143C;">🦁 Carnivores:</span> ${counts.carnivores}</div>
            <div><strong>Total:</strong> ${total}</div>
            <div style="margin-top: 5px; padding-top: 5px; border-top: 1px solid #ccc;">
                <small>Births: ${this.totalBirths} | Deaths: ${this.totalDeaths}</small>
            </div>
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
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = (height / 4) * i;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        // Draw lines for each species
        this.drawLine(this.history.trees, maxValue, '#228B22', 2); // Green for trees
        this.drawLine(this.history.herbivores, maxValue, '#FF8C00', 2); // Orange for herbivores
        this.drawLine(this.history.carnivores, maxValue, '#DC143C', 2); // Red for carnivores

        // Draw scale labels
        ctx.fillStyle = '#666';
        ctx.font = '10px Arial';
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
