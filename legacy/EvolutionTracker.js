// Evolution Tracker - tracks genetic evolution over time
import { animals } from './Animal.js';

export class EvolutionTracker {
    constructor() {
        this.container = null;
        this.canvas = null;
        this.ctx = null;

        // Track genetic trait averages over time
        this.history = {
            herbivores: {
                speed: [],
                size: [],
                maxEnergy: [],
                vision: [],
                aggression: [],
                intelligence: []
            },
            carnivores: {
                speed: [],
                size: [],
                maxEnergy: [],
                vision: [],
                aggression: [],
                intelligence: []
            }
        };

        // Starting baselines (for comparison)
        this.baselines = {
            herbivores: { speed: 1.0, size: 1.0, maxEnergy: 1.0, vision: 1.0, aggression: 1.0, intelligence: 1.0 },
            carnivores: { speed: 1.0, size: 1.0, maxEnergy: 1.0, vision: 1.0, aggression: 1.0, intelligence: 1.0 }
        };

        // Track mutation prevalence
        this.mutationCounts = {};

        this.maxHistoryLength = 200; // Keep last 200 data points
        this.updateInterval = 20; // Update every 20 frames
        this.frameCounter = 0;
    }

    init() {
        // Create evolution tracker container
        this.container = document.createElement('div');
        this.container.id = 'evolution-tracker';
        this.container.className = 'panel';
        this.container.style.cssText = `
            position: absolute;
            bottom: 12px;
            right: 12px;
            width: 244px;
            z-index: 10;
            max-height: 62vh;
            overflow-y: auto;
        `;

        // Header: title + collapse toggle
        const header = document.createElement('div');
        header.className = 'panel-header';
        const title = document.createElement('h3');
        title.textContent = '🧬 Evolution';
        const toggle = document.createElement('button');
        toggle.className = 'panel-toggle';
        toggle.textContent = '–';
        header.appendChild(title);
        header.appendChild(toggle);
        this.container.appendChild(header);

        // Collapsible body
        const body = document.createElement('div');

        // Compact trait legend (was a verbose paragraph)
        const tradeoffs = document.createElement('div');
        tradeoffs.style.cssText = 'font-size: 13px; color: #8892b0; margin-bottom: 8px; line-height: 1.2;';
        tradeoffs.innerHTML = `⚡spd 📏size 💪nrg 👁️vis 😠agr 🧠int &nbsp;<span style="opacity:.7">(all but 💪 cost energy)</span>`;
        body.appendChild(tradeoffs);

        // Stats text
        this.statsText = document.createElement('div');
        this.statsText.style.cssText = 'margin-bottom: 4px;';
        body.appendChild(this.statsText);

        // Charts toggle (charts hidden by default to keep the panel compact)
        this.chartsVisible = false;
        const chartToggle = document.createElement('button');
        chartToggle.className = 'chart-toggle';
        chartToggle.textContent = '▸ show trait charts';
        body.appendChild(chartToggle);

        // Charts canvas (6 charts), hidden initially
        this.canvas = document.createElement('canvas');
        this.canvas.width = 220;
        this.canvas.height = 360;
        this.canvas.style.display = 'none';
        body.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');

        this.container.appendChild(body);

        chartToggle.addEventListener('click', () => {
            this.chartsVisible = !this.chartsVisible;
            this.canvas.style.display = this.chartsVisible ? '' : 'none';
            chartToggle.textContent = this.chartsVisible ? '▾ hide trait charts' : '▸ show trait charts';
            if (this.chartsVisible) this.drawCharts();
        });

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

        // Calculate average genetics for each species
        const herbivores = animals.filter(a => a.kind === 'herbivore');
        const carnivores = animals.filter(a => a.kind === 'carnivore');

        if (herbivores.length > 0) {
            const avgSpeed = herbivores.reduce((sum, a) => sum + a.genetics.speedMultiplier, 0) / herbivores.length;
            const avgSize = herbivores.reduce((sum, a) => sum + a.genetics.sizeMultiplier, 0) / herbivores.length;
            const avgEnergy = herbivores.reduce((sum, a) => sum + a.genetics.maxEnergyMultiplier, 0) / herbivores.length;
            const avgVision = herbivores.reduce((sum, a) => sum + a.genetics.visionRange, 0) / herbivores.length;
            const avgAggression = herbivores.reduce((sum, a) => sum + a.genetics.aggression, 0) / herbivores.length;
            const avgIntelligence = herbivores.reduce((sum, a) => sum + a.genetics.intelligence, 0) / herbivores.length;

            this.history.herbivores.speed.push(avgSpeed);
            this.history.herbivores.size.push(avgSize);
            this.history.herbivores.maxEnergy.push(avgEnergy);
            this.history.herbivores.vision.push(avgVision);
            this.history.herbivores.aggression.push(avgAggression);
            this.history.herbivores.intelligence.push(avgIntelligence);
        }

        if (carnivores.length > 0) {
            const avgSpeed = carnivores.reduce((sum, a) => sum + a.genetics.speedMultiplier, 0) / carnivores.length;
            const avgSize = carnivores.reduce((sum, a) => sum + a.genetics.sizeMultiplier, 0) / carnivores.length;
            const avgEnergy = carnivores.reduce((sum, a) => sum + a.genetics.maxEnergyMultiplier, 0) / carnivores.length;
            const avgVision = carnivores.reduce((sum, a) => sum + a.genetics.visionRange, 0) / carnivores.length;
            const avgAggression = carnivores.reduce((sum, a) => sum + a.genetics.aggression, 0) / carnivores.length;
            const avgIntelligence = carnivores.reduce((sum, a) => sum + a.genetics.intelligence, 0) / carnivores.length;

            this.history.carnivores.speed.push(avgSpeed);
            this.history.carnivores.size.push(avgSize);
            this.history.carnivores.maxEnergy.push(avgEnergy);
            this.history.carnivores.vision.push(avgVision);
            this.history.carnivores.aggression.push(avgAggression);
            this.history.carnivores.intelligence.push(avgIntelligence);
        }

        // Count mutations
        this.mutationCounts = {};
        for (const animal of animals) {
            for (const mutation of animal.mutations) {
                this.mutationCounts[mutation] = (this.mutationCounts[mutation] || 0) + 1;
            }
        }

        // Trim history if too long
        if (this.history.herbivores.speed.length > this.maxHistoryLength) {
            this.history.herbivores.speed.shift();
            this.history.herbivores.size.shift();
            this.history.herbivores.maxEnergy.shift();
            this.history.herbivores.vision.shift();
            this.history.herbivores.aggression.shift();
            this.history.herbivores.intelligence.shift();
        }
        if (this.history.carnivores.speed.length > this.maxHistoryLength) {
            this.history.carnivores.speed.shift();
            this.history.carnivores.size.shift();
            this.history.carnivores.maxEnergy.shift();
            this.history.carnivores.vision.shift();
            this.history.carnivores.aggression.shift();
            this.history.carnivores.intelligence.shift();
        }

        this.render();
    }

    render() {
        // Helper to get latest value
        const getLast = (arr) => arr.length > 0 ? arr[arr.length - 1] : 1.0;

        // Get current values for all traits
        const herbStats = {
            speed: getLast(this.history.herbivores.speed),
            size: getLast(this.history.herbivores.size),
            energy: getLast(this.history.herbivores.maxEnergy),
            vision: getLast(this.history.herbivores.vision),
            aggression: getLast(this.history.herbivores.aggression),
            intelligence: getLast(this.history.herbivores.intelligence)
        };

        const carnStats = {
            speed: getLast(this.history.carnivores.speed),
            size: getLast(this.history.carnivores.size),
            energy: getLast(this.history.carnivores.maxEnergy),
            vision: getLast(this.history.carnivores.vision),
            aggression: getLast(this.history.carnivores.aggression),
            intelligence: getLast(this.history.carnivores.intelligence)
        };

        // Calculate changes from baseline
        const herbChanges = {
            speed: ((herbStats.speed - this.baselines.herbivores.speed) / this.baselines.herbivores.speed * 100).toFixed(1),
            size: ((herbStats.size - this.baselines.herbivores.size) / this.baselines.herbivores.size * 100).toFixed(1),
            energy: ((herbStats.energy - this.baselines.herbivores.maxEnergy) / this.baselines.herbivores.maxEnergy * 100).toFixed(1),
            vision: ((herbStats.vision - this.baselines.herbivores.vision) / this.baselines.herbivores.vision * 100).toFixed(1),
            aggression: ((herbStats.aggression - this.baselines.herbivores.aggression) / this.baselines.herbivores.aggression * 100).toFixed(1),
            intelligence: ((herbStats.intelligence - this.baselines.herbivores.intelligence) / this.baselines.herbivores.intelligence * 100).toFixed(1)
        };

        const carnChanges = {
            speed: ((carnStats.speed - this.baselines.carnivores.speed) / this.baselines.carnivores.speed * 100).toFixed(1),
            size: ((carnStats.size - this.baselines.carnivores.size) / this.baselines.carnivores.size * 100).toFixed(1),
            energy: ((carnStats.energy - this.baselines.carnivores.maxEnergy) / this.baselines.carnivores.maxEnergy * 100).toFixed(1),
            vision: ((carnStats.vision - this.baselines.carnivores.vision) / this.baselines.carnivores.vision * 100).toFixed(1),
            aggression: ((carnStats.aggression - this.baselines.carnivores.aggression) / this.baselines.carnivores.aggression * 100).toFixed(1),
            intelligence: ((carnStats.intelligence - this.baselines.carnivores.intelligence) / this.baselines.carnivores.intelligence * 100).toFixed(1)
        };

        // Format change with arrow
        const formatChange = (val) => {
            const num = parseFloat(val);
            if (num > 0) return `<span style="color: #7ee787;">↑${val}%</span>`;
            if (num < 0) return `<span style="color: #ff7b72;">↓${Math.abs(val)}%</span>`;
            return `<span style="color: #8892b0;">0%</span>`;
        };

        // Build mutation stats HTML
        let mutationHTML = '';
        if (Object.keys(this.mutationCounts).length > 0) {
            mutationHTML = '<div style="font-size: 12px; margin-top: 5px; color: #c792ea;"><strong>✨ Mutations:</strong> ';
            const mutEntries = Object.entries(this.mutationCounts)
                .map(([mut, count]) => `${mut.replace(/_/g, ' ')}: ${count}`)
                .join(', ');
            mutationHTML += mutEntries + '</div>';
        }

        // Update stats text
        this.statsText.innerHTML = `
            <div style="margin-bottom: 6px;">
                <strong style="color: #ffa657;">🦌 Herbivores</strong>
                <div style="margin-left: 8px; font-size: 13px; line-height: 1.25;">
                    ⚡${herbStats.speed.toFixed(2)}x ${formatChange(herbChanges.speed)} |
                    📏${herbStats.size.toFixed(2)}x ${formatChange(herbChanges.size)} |
                    💪${herbStats.energy.toFixed(2)}x ${formatChange(herbChanges.energy)}<br>
                    👁️${herbStats.vision.toFixed(2)}x ${formatChange(herbChanges.vision)} |
                    😠${herbStats.aggression.toFixed(2)}x ${formatChange(herbChanges.aggression)} |
                    🧠${herbStats.intelligence.toFixed(2)}x ${formatChange(herbChanges.intelligence)}
                </div>
            </div>
            <div style="margin-bottom: 6px;">
                <strong style="color: #ff7b72;">🦁 Carnivores</strong>
                <div style="margin-left: 8px; font-size: 13px; line-height: 1.25;">
                    ⚡${carnStats.speed.toFixed(2)}x ${formatChange(carnChanges.speed)} |
                    📏${carnStats.size.toFixed(2)}x ${formatChange(carnChanges.size)} |
                    💪${carnStats.energy.toFixed(2)}x ${formatChange(carnChanges.energy)}<br>
                    👁️${carnStats.vision.toFixed(2)}x ${formatChange(carnChanges.vision)} |
                    😠${carnStats.aggression.toFixed(2)}x ${formatChange(carnChanges.aggression)} |
                    🧠${carnStats.intelligence.toFixed(2)}x ${formatChange(carnChanges.intelligence)}
                </div>
            </div>
            ${mutationHTML}
        `;

        // Draw charts
        this.drawCharts();
    }

    drawCharts() {
        if (!this.chartsVisible) return; // charts hidden — skip the draw work
        const ctx = this.ctx;
        const width = this.canvas.width;
        const height = this.canvas.height;
        const chartHeight = height / 6; // 6 charts now

        // Clear canvas
        ctx.clearRect(0, 0, width, height);

        // Draw six charts for all traits
        this.drawSingleChart(0, 'Speed ⚡', this.history.herbivores.speed, this.history.carnivores.speed, chartHeight);
        this.drawSingleChart(chartHeight, 'Size 📏', this.history.herbivores.size, this.history.carnivores.size, chartHeight);
        this.drawSingleChart(chartHeight * 2, 'Energy 💪', this.history.herbivores.maxEnergy, this.history.carnivores.maxEnergy, chartHeight);
        this.drawSingleChart(chartHeight * 3, 'Vision 👁️', this.history.herbivores.vision, this.history.carnivores.vision, chartHeight);
        this.drawSingleChart(chartHeight * 4, 'Aggression 😠', this.history.herbivores.aggression, this.history.carnivores.aggression, chartHeight);
        this.drawSingleChart(chartHeight * 5, 'Intelligence 🧠', this.history.herbivores.intelligence, this.history.carnivores.intelligence, chartHeight);
    }

    drawSingleChart(yOffset, label, herbData, carnData, chartHeight) {
        const ctx = this.ctx;
        const width = this.canvas.width;

        // Draw label
        ctx.fillStyle = '#d7dce8';
        ctx.font = '11px "VT323", monospace';
        ctx.fillText(label, 5, yOffset + 12);

        // Draw baseline (1.0)
        ctx.strokeStyle = '#2a3350';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        const baselineY = yOffset + chartHeight / 2;
        ctx.beginPath();
        ctx.moveTo(0, baselineY);
        ctx.lineTo(width, baselineY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw baseline label
        ctx.fillStyle = '#8892b0';
        ctx.font = '10px "VT323", monospace';
        ctx.fillText('1.0', width - 20, baselineY - 2);

        // Find min/max for scaling
        const allData = [...herbData, ...carnData];
        if (allData.length === 0) return;

        const minVal = Math.min(...allData, 0.5);
        const maxVal = Math.max(...allData, 1.5);
        const range = maxVal - minVal;

        // Draw herbivore data (orange)
        if (herbData.length > 1) {
            this.drawLine(ctx, herbData, yOffset, chartHeight, minVal, range, '#ffa657', 2);
        }

        // Draw carnivore data (red)
        if (carnData.length > 1) {
            this.drawLine(ctx, carnData, yOffset, chartHeight, minVal, range, '#ff7b72', 2);
        }

        // Draw separator
        ctx.strokeStyle = '#232a44';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, yOffset + chartHeight);
        ctx.lineTo(width, yOffset + chartHeight);
        ctx.stroke();
    }

    drawLine(ctx, data, yOffset, chartHeight, minVal, range, color, lineWidth) {
        if (data.length < 2) return;

        const width = this.canvas.width;
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();

        const step = width / (this.maxHistoryLength - 1);
        const padding = 10;

        for (let i = 0; i < data.length; i++) {
            const x = i * step;
            const normalizedValue = (data[i] - minVal) / (range || 1);
            const y = yOffset + chartHeight - padding - (normalizedValue * (chartHeight - padding * 2));

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }

        ctx.stroke();
    }
}
