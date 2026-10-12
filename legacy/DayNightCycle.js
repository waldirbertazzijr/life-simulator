// Day/Night cycle system
export class DayNightCycle {
    constructor() {
        this.timeOfDay = 0; // 0-24 hours
        this.dayLength = 1000; // Frames for a full day cycle
        this.timeIncrement = 24 / this.dayLength;
        this.day = 1; // in-game day counter
    }

    update() {
        this.timeOfDay += this.timeIncrement;
        if (this.timeOfDay >= 24) {
            this.timeOfDay = 0;
            this.day++;
        }
    }

    getCurrentHour() {
        return Math.floor(this.timeOfDay);
    }

    isNight() {
        return this.timeOfDay < 6 || this.timeOfDay >= 20;
    }

    isDay() {
        return !this.isNight();
    }

    isDusk() {
        return this.timeOfDay >= 18 && this.timeOfDay < 20;
    }

    isDawn() {
        return this.timeOfDay >= 5 && this.timeOfDay < 7;
    }

    // Returns a brightness value from 0 (darkest) to 1 (brightest)
    getBrightness() {
        if (this.timeOfDay >= 7 && this.timeOfDay <= 17) {
            // Full daylight (7 AM to 5 PM)
            return 1;
        } else if (this.timeOfDay >= 21 || this.timeOfDay <= 3) {
            // Deepest night (9 PM to 3 AM)
            return 0.3;
        } else if (this.timeOfDay > 17 && this.timeOfDay < 21) {
            // Dusk (5 PM to 9 PM)
            const progress = (this.timeOfDay - 17) / 4;
            return 1 - (progress * 0.7);
        } else {
            // Dawn (3 AM to 7 AM)
            const progress = (this.timeOfDay - 3) / 4;
            return 0.3 + (progress * 0.7);
        }
    }

    // Get overlay color based on time of day with realistic transitions
    getOverlayColor() {
        const hour = this.timeOfDay;

        // Deep Night (22:00 - 4:00) - Dark blue
        if (hour >= 22 || hour < 4) {
            return 'rgba(10, 15, 60, 0.5)';
        }
        // Early Dawn (4:00 - 5:00) - Deep blue to purple
        else if (hour >= 4 && hour < 5) {
            const progress = hour - 4;
            const r = 10 + (60 * progress);
            const g = 15 + (20 * progress);
            const b = 60 + (40 * progress);
            const alpha = 0.5 - (0.1 * progress);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        // Dawn (5:00 - 6:00) - Purple to pink/orange
        else if (hour >= 5 && hour < 6) {
            const progress = hour - 5;
            const r = 70 + (130 * progress);
            const g = 35 + (75 * progress);
            const b = 100 - (60 * progress);
            const alpha = 0.4 - (0.15 * progress);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        // Sunrise (6:00 - 7:00) - Pink/orange to golden
        else if (hour >= 6 && hour < 7) {
            const progress = hour - 6;
            const r = 200 + (50 * progress);
            const g = 110 + (90 * progress);
            const b = 40 - (20 * progress);
            const alpha = 0.25 - (0.15 * progress);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        // Early Morning (7:00 - 8:00) - Golden to clear
        else if (hour >= 7 && hour < 8) {
            const progress = hour - 7;
            const r = 250 - (150 * progress);
            const g = 200 - (120 * progress);
            const b = 20 + (60 * progress);
            const alpha = 0.1 - (0.1 * progress);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        // Full Day (8:00 - 17:00) - Clear, bright
        else if (hour >= 8 && hour < 17) {
            return 'rgba(255, 250, 200, 0.02)'; // Very subtle warm tint
        }
        // Late Afternoon (17:00 - 18:00) - Clear to golden
        else if (hour >= 17 && hour < 18) {
            const progress = hour - 17;
            const r = 255;
            const g = 220 - (20 * progress);
            const b = 100 - (50 * progress);
            const alpha = 0.05 + (0.1 * progress);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        // Sunset (18:00 - 19:00) - Golden to orange/red
        else if (hour >= 18 && hour < 19) {
            const progress = hour - 18;
            const r = 255;
            const g = 200 - (90 * progress);
            const b = 50 - (20 * progress);
            const alpha = 0.15 + (0.15 * progress);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        // Dusk (19:00 - 20:00) - Orange/red to purple
        else if (hour >= 19 && hour < 20) {
            const progress = hour - 19;
            const r = 255 - (155 * progress);
            const g = 110 - (60 * progress);
            const b = 30 + (70 * progress);
            const alpha = 0.3 + (0.1 * progress);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        // Early Night (20:00 - 22:00) - Purple to deep blue
        else if (hour >= 20 && hour < 22) {
            const progress = (hour - 20) / 2;
            const r = 100 - (90 * progress);
            const g = 50 - (35 * progress);
            const b = 100 - (40 * progress);
            const alpha = 0.4 + (0.1 * progress);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }

        return 'rgba(0, 0, 0, 0)';
    }

    // Draw the day/night overlay
    draw(ctx, width, height) {
        const overlay = this.getOverlayColor();
        ctx.fillStyle = overlay;
        ctx.fillRect(0, 0, width, height);
    }

    // Get activity multiplier for carnivores (more active at night)
    getCarnivoreActivityMultiplier() {
        if (this.isNight()) {
            return 1.3; // 30% more active at night
        } else if (this.isDusk() || this.isDawn()) {
            return 1.15; // 15% more active during twilight
        }
        return 1.0;
    }

    // Get activity multiplier for herbivores (more active during day)
    getHerbivoreActivityMultiplier() {
        if (this.isDay() && !this.isDawn() && !this.isDusk()) {
            return 1.2; // 20% more active during day
        } else if (this.isNight()) {
            return 0.8; // 20% less active at night
        }
        return 1.0;
    }

    getTimeString() {
        const hour = Math.floor(this.timeOfDay);
        const minute = Math.floor((this.timeOfDay - hour) * 60);
        const period = hour >= 12 ? 'PM' : 'AM';
        const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
        return `${displayHour}:${minute.toString().padStart(2, '0')} ${period}`;
    }
}
