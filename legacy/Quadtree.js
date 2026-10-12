// Quadtree spatial partitioning for efficient collision detection

class Rectangle {
    constructor(x, y, width, height) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
    }

    contains(point) {
        return (
            point.positionX >= this.x &&
            point.positionX < this.x + this.width &&
            point.positionY >= this.y &&
            point.positionY < this.y + this.height
        );
    }

    intersects(range) {
        return !(
            range.x > this.x + this.width ||
            range.x + range.width < this.x ||
            range.y > this.y + this.height ||
            range.y + range.height < this.y
        );
    }
}

class Circle {
    constructor(x, y, radius) {
        this.x = x;
        this.y = y;
        this.radius = radius;
        this.radiusSquared = radius * radius;
    }

    contains(point) {
        const dx = point.positionX - this.x;
        const dy = point.positionY - this.y;
        return dx * dx + dy * dy <= this.radiusSquared;
    }

    intersects(range) {
        const xDist = Math.abs(range.x + range.width / 2 - this.x);
        const yDist = Math.abs(range.y + range.height / 2 - this.y);

        const w = range.width / 2;
        const h = range.height / 2;

        if (xDist > w + this.radius || yDist > h + this.radius) return false;
        if (xDist <= w || yDist <= h) return true;

        const cornerDistanceSq = (xDist - w) ** 2 + (yDist - h) ** 2;
        return cornerDistanceSq <= this.radiusSquared;
    }
}

export class Quadtree {
    constructor(boundary, capacity = 4) {
        this.boundary = boundary;
        this.capacity = capacity;
        this.points = [];
        this.divided = false;
    }

    subdivide() {
        const x = this.boundary.x;
        const y = this.boundary.y;
        const w = this.boundary.width / 2;
        const h = this.boundary.height / 2;

        const ne = new Rectangle(x + w, y, w, h);
        const nw = new Rectangle(x, y, w, h);
        const se = new Rectangle(x + w, y + h, w, h);
        const sw = new Rectangle(x, y + h, w, h);

        this.northeast = new Quadtree(ne, this.capacity);
        this.northwest = new Quadtree(nw, this.capacity);
        this.southeast = new Quadtree(se, this.capacity);
        this.southwest = new Quadtree(sw, this.capacity);

        this.divided = true;
    }

    insert(point) {
        if (!this.boundary.contains(point)) {
            return false;
        }

        if (this.points.length < this.capacity) {
            this.points.push(point);
            return true;
        }

        if (!this.divided) {
            this.subdivide();
        }

        return (
            this.northeast.insert(point) ||
            this.northwest.insert(point) ||
            this.southeast.insert(point) ||
            this.southwest.insert(point)
        );
    }

    query(range, found = []) {
        if (!range.intersects(this.boundary)) {
            return found;
        }

        for (const point of this.points) {
            if (range.contains(point)) {
                found.push(point);
            }
        }

        if (this.divided) {
            this.northwest.query(range, found);
            this.northeast.query(range, found);
            this.southwest.query(range, found);
            this.southeast.query(range, found);
        }

        return found;
    }

    clear() {
        this.points = [];
        this.divided = false;
        this.northeast = null;
        this.northwest = null;
        this.southeast = null;
        this.southwest = null;
    }
}

export { Rectangle, Circle };
