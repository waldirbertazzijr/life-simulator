// UI Components - Tooltip and Toolbar
import { config } from './config.js';
import { animals, AnimalFactory } from './Animal.js';

export class Tooltip {
    constructor() {
        this.tooltip = document.getElementById('tooltip');
        this.canvas = document.getElementById('canvas');
        this.canvasRect = this.canvas.getBoundingClientRect();

        this.tooltip.classList.add("panel");

        this.canvas.addEventListener('mousemove', (event) => this.onMouseMove(event));
        this.canvas.addEventListener('mouseout', () => this.onMouseOut());
    }

    onMouseMove(event) {
        // Map screen pixels to simulation-world coordinates (the canvas buffer can
        // be a different size than its on-screen display; see fixCanvasSize).
        const scaleX = this.canvas.width / this.canvasRect.width;
        const scaleY = this.canvas.height / this.canvasRect.height;
        const mouseX = (event.clientX - this.canvasRect.left) * scaleX;
        const mouseY = (event.clientY - this.canvasRect.top) * scaleY;

        let hoveredAnimal = null;
        for (const animal of animals) {
            const distance = Math.hypot(animal.positionX - mouseX, animal.positionY - mouseY);
            if (distance < 15) {
                hoveredAnimal = animal;
                break;
            }
        }

        if (hoveredAnimal) {
            this.tooltip.style.display = 'block';
            this.tooltip.style.left = `${event.pageX + 10}px`;
            this.tooltip.style.top = `${event.pageY + 10}px`;

            // Format genetics
            const genetics = hoveredAnimal.genetics;
            const geneticsHTML = `
                <strong>Genetics:</strong><br>
                <div style="margin-left: 10px; font-size: 10px;">
                    ⚡ Speed: ${genetics.speedMultiplier.toFixed(2)}x<br>
                    📏 Size: ${genetics.sizeMultiplier.toFixed(2)}x<br>
                    💪 Max Energy: ${genetics.maxEnergyMultiplier.toFixed(2)}x<br>
                    👁️ Vision: ${genetics.visionRange.toFixed(2)}x<br>
                    😠 Aggression: ${genetics.aggression.toFixed(2)}x<br>
                    🧠 Intelligence: ${genetics.intelligence.toFixed(2)}x
                </div>
            `;

            // Format mutations
            let mutationsHTML = '';
            if (hoveredAnimal.mutations && hoveredAnimal.mutations.length > 0) {
                mutationsHTML = `
                    <strong style="color: #8B008B;">✨ Mutations:</strong><br>
                    <div style="margin-left: 10px; font-size: 10px; color: #8B008B;">
                        ${hoveredAnimal.mutations.map(m => m.replace(/_/g, ' ')).join(', ')}
                    </div>
                `;
            }

            // Format basic info
            const lifeStage = hoveredAnimal.getLifeStage();
            const basicInfo = `
                <strong>Type:</strong> ${hoveredAnimal.kind}<br>
                <strong>Life Stage:</strong> ${lifeStage} (age: ${hoveredAnimal.age.toFixed(0)})<br>
                <strong>Energy:</strong> ${hoveredAnimal.energy.toFixed(1)} / ${hoveredAnimal.maxEnergy.toFixed(1)}<br>
                <strong>Behavior:</strong> ${hoveredAnimal.walkStrategy || 'static'}<br>
                <strong>Sleeping:</strong> ${hoveredAnimal.isSleeping ? 'Yes' : 'No'}
            `;

            this.tooltip.innerHTML = `
                <strong style="font-size: 12px;">${hoveredAnimal.name}</strong>
                <hr style="margin: 5px 0;"/>
                <div style="font-size: 11px; line-height: 1.5;">
                    ${basicInfo}
                    <br>
                    ${geneticsHTML}
                    ${mutationsHTML ? '<br>' + mutationsHTML : ''}
                </div>
            `;
        } else {
            this.tooltip.style.display = 'none';
        }
    }

    onMouseOut() {
        this.tooltip.style.display = 'none';
    }
}

export const initializeToolbar = (tooltip) => {
    let selectedAnimal = null;
    const buttons = document.getElementsByClassName('add_animal');

    // Animal selection buttons
    Object.keys(buttons).forEach(key => {
        buttons[key].addEventListener('click', (event) => {
            let clickedAnimal = event.target.attributes['animal'].value;
            Object.values(buttons).forEach(button => button.style.backgroundColor = '');
            if (clickedAnimal == selectedAnimal) {
                selectedAnimal = null;
                return;
            }
            event.target.style.backgroundColor = 'lightskyblue';
            selectedAnimal = event.target.attributes['animal'].value;
        });
    });

    // Canvas click to add animals
    document.getElementById('canvas').addEventListener('click', (event) => {
        if (selectedAnimal) {
            const rect = config.canvas.getBoundingClientRect();
            const scaleX = config.canvas.width / rect.width;
            const scaleY = config.canvas.height / rect.height;
            const x = (event.clientX - rect.left) * scaleX;
            const y = (event.clientY - rect.top) * scaleY;

            const animal = AnimalFactory.getAnimal(selectedAnimal);
            animal.positionX = x;
            animal.positionY = y;
            animals.push(animal);

            tooltip.onMouseMove(event);
        }
    });

    // Pause/Play button
    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) {
        pauseBtn.addEventListener('click', () => {
            config.run = !config.run;
            pauseBtn.textContent = config.run ? '⏸' : '▶';
            pauseBtn.style.background = config.run ? 'var(--amber)' : 'var(--tree)';
        });
    }

    // Speed control buttons
    const speedButtons = document.getElementsByClassName('speed-btn');
    const highlightSpeed = (active) => {
        Object.values(speedButtons).forEach(btn => {
            btn.style.background = (parseFloat(btn.getAttribute('data-speed')) === active) ? 'var(--amber)' : 'var(--btn)';
        });
    };
    Object.keys(speedButtons).forEach(key => {
        speedButtons[key].addEventListener('click', (event) => {
            config.simulationSpeed = parseFloat(event.target.getAttribute('data-speed'));
            highlightSpeed(config.simulationSpeed);
        });
    });
    highlightSpeed(config.simulationSpeed); // mark the default speed
};
