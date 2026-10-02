export const CELL_FREE = 0;
export const CELL_BLOCKED = 1;
export const CELL_UNKNOWN = 2;

export function createGrid(width, height, fill = CELL_FREE) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new TypeError('grid dimensions must be integers greater than one');
  }
  const cells = new Uint8Array(width * height);
  if (fill !== CELL_FREE) cells.fill(fill);
  return { width, height, cells };
}

function gridIndex(grid, x, y) {
  return y * grid.width + x;
}

function inBounds(grid, x, y) {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height;
}

export function setCell(grid, x, y, value) {
  if (inBounds(grid, x, y)) grid.cells[gridIndex(grid, x, y)] = value;
}

export function getCell(grid, x, y) {
  if (!inBounds(grid, x, y)) return CELL_BLOCKED;
  return grid.cells[gridIndex(grid, x, y)];
}

export function inflateGrid(grid, radius) {
  const inflated = createGrid(grid.width, grid.height);
  inflated.cells.set(grid.cells);
  const safeRadius = Math.max(0, Math.floor(radius));

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      if (getCell(grid, x, y) === CELL_FREE) continue;
      const value = getCell(grid, x, y);
      for (let dy = -safeRadius; dy <= safeRadius; dy += 1) {
        for (let dx = -safeRadius; dx <= safeRadius; dx += 1) {
          if (dx * dx + dy * dy > safeRadius * safeRadius) continue;
          if (value === CELL_BLOCKED || getCell(inflated, x + dx, y + dy) === CELL_FREE) {
            setCell(inflated, x + dx, y + dy, value);
          }
        }
      }
    }
  }
  return inflated;
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= item.priority) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop() {
    if (!this.items.length) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (!this.items.length) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.items.length) break;
      let child = left;
      if (right < this.items.length && this.items[right].priority < this.items[left].priority) child = right;
      if (this.items[child].priority >= last.priority) break;
      this.items[index] = this.items[child];
      index = child;
    }
    this.items[index] = last;
    return first;
  }

  get size() {
    return this.items.length;
  }
}

function heuristic(x, y, goals) {
  let best = Number.POSITIVE_INFINITY;
  for (const goal of goals) best = Math.min(best, Math.hypot(goal.x - x, goal.y - y));
  return best;
}

function reconstructPath(cameFrom, endIndex, width) {
  const path = [];
  let cursor = endIndex;
  while (cursor !== -1) {
    path.push({ x: cursor % width, y: Math.floor(cursor / width) });
    cursor = cameFrom[cursor];
  }
  return path.reverse();
}

export function findPath(grid, startPoint, exitPoints, options = {}) {
  const start = { x: Math.round(startPoint.x), y: Math.round(startPoint.y) };
  const goals = exitPoints
    .map((exit) => ({ ...exit, x: Math.round(exit.x), y: Math.round(exit.y) }))
    .filter((goal) => Number.isFinite(goal.x) && Number.isFinite(goal.y) && getCell(grid, goal.x, goal.y) === CELL_FREE);

  if (getCell(grid, start.x, start.y) !== CELL_FREE || goals.length === 0) {
    return { status: 'blocked', path: [], cost: Number.POSITIVE_INFINITY };
  }

  const total = grid.width * grid.height;
  const distances = new Float64Array(total);
  distances.fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Int32Array(total);
  cameFrom.fill(-1);
  const closed = new Uint8Array(total);
  const queue = new MinHeap();
  const startIndex = gridIndex(grid, start.x, start.y);
  distances[startIndex] = 0;
  queue.push({ x: start.x, y: start.y, priority: heuristic(start.x, start.y, goals) });
  const goalIndexes = new Map(goals.map((goal) => [gridIndex(grid, goal.x, goal.y), goal]));
  const usage = options.usage || new Float32Array(total);
  const congestionWeight = options.congestionWeight || 0;
  const riskAt = options.riskAt || (() => 0);
  const neighbors = [
    [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
    [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, 1, Math.SQRT2],
  ];

  while (queue.size) {
    const current = queue.pop();
    const currentIndex = gridIndex(grid, current.x, current.y);
    if (closed[currentIndex]) continue;
    closed[currentIndex] = 1;

    if (goalIndexes.has(currentIndex)) {
      const goal = goalIndexes.get(currentIndex);
      return {
        status: 'safe',
        path: reconstructPath(cameFrom, currentIndex, grid.width),
        cost: distances[currentIndex],
        exitId: goal.id,
      };
    }

    for (const [dx, dy, movementCost] of neighbors) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (getCell(grid, nx, ny) !== CELL_FREE) continue;
      if (dx !== 0 && dy !== 0) {
        if (getCell(grid, current.x + dx, current.y) !== CELL_FREE) continue;
        if (getCell(grid, current.x, current.y + dy) !== CELL_FREE) continue;
      }
      const nextIndex = gridIndex(grid, nx, ny);
      const nextDistance = distances[currentIndex]
        + movementCost
        + riskAt(nx, ny)
        + usage[nextIndex] * congestionWeight;
      if (nextDistance >= distances[nextIndex]) continue;
      distances[nextIndex] = nextDistance;
      cameFrom[nextIndex] = currentIndex;
      queue.push({
        x: nx,
        y: ny,
        priority: nextDistance + heuristic(nx, ny, goals),
      });
    }
  }

  return { status: 'blocked', path: [], cost: Number.POSITIVE_INFINITY };
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function normalizedToCell(point, width, height) {
  return {
    ...point,
    x: Math.round(clamp01(point.x) * (width - 1)),
    y: Math.round(clamp01(point.y) * (height - 1)),
  };
}

function cellToNormalized(point, width, height) {
  return { x: point.x / (width - 1), y: point.y / (height - 1) };
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = ((yi > point.y) !== (yj > point.y))
      && point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function paintShape(grid, shape, value) {
  if (shape.type === 'circle') {
    const center = normalizedToCell(shape, grid.width, grid.height);
    const radius = Math.max(1, Math.round(shape.radius * Math.min(grid.width, grid.height)));
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (dx * dx + dy * dy <= radius * radius) setCell(grid, center.x + dx, center.y + dy, value);
      }
    }
    return;
  }

  if (shape.type === 'rect') {
    const left = Math.round(clamp01(Math.min(shape.x, shape.x + shape.width)) * (grid.width - 1));
    const right = Math.round(clamp01(Math.max(shape.x, shape.x + shape.width)) * (grid.width - 1));
    const top = Math.round(clamp01(Math.min(shape.y, shape.y + shape.height)) * (grid.height - 1));
    const bottom = Math.round(clamp01(Math.max(shape.y, shape.y + shape.height)) * (grid.height - 1));
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) setCell(grid, x, y, value);
    }
    return;
  }

  if (shape.type === 'polygon' && Array.isArray(shape.points)) {
    for (let y = 0; y < grid.height; y += 1) {
      for (let x = 0; x < grid.width; x += 1) {
        const point = cellToNormalized({ x, y }, grid.width, grid.height);
        if (pointInPolygon(point, shape.points)) setCell(grid, x, y, value);
      }
    }
  }
}

export function buildPlanningGrid({ width, height, obstacles = [], unknowns = [], fires = [], clearance = 0 }) {
  const grid = createGrid(width, height);
  for (const obstacle of obstacles) paintShape(grid, obstacle, CELL_BLOCKED);
  for (const unknown of unknowns) paintShape(grid, unknown, CELL_UNKNOWN);
  for (const fire of fires) {
    if (fire.hardRadius > 0) paintShape(grid, { type: 'circle', ...fire, radius: fire.hardRadius }, CELL_BLOCKED);
  }
  return inflateGrid(grid, clearance);
}

function createRiskFunction(fires, width, height) {
  return (cellX, cellY) => {
    const x = cellX / (width - 1);
    const y = cellY / (height - 1);
    let risk = 0;
    for (const fire of fires) {
      const radius = Math.max(fire.radius || 0, fire.hardRadius || 0);
      if (radius <= 0) continue;
      const distance = Math.hypot(x - fire.x, y - fire.y);
      if (distance < radius) risk += (1 - distance / radius) * (fire.intensity || 4);
    }
    return risk;
  };
}

export function planEvacuation({
  width = 96,
  height = 72,
  obstacles = [],
  unknowns = [],
  starts = [],
  exits = [],
  fires = [],
  clearance = 1,
  congestionWeight = 1.4,
}) {
  const grid = buildPlanningGrid({ width, height, obstacles, unknowns, fires, clearance });
  const usage = new Float32Array(width * height);
  const riskAt = createRiskFunction(fires, width, height);
  const cellExits = exits.map((exit) => normalizedToCell(exit, width, height));
  const routes = [];

  for (const start of starts) {
    const cellStart = normalizedToCell(start, width, height);
    const result = findPath(grid, cellStart, cellExits, {
      usage,
      congestionWeight,
      riskAt,
    });
    const normalizedPath = result.path.map((point) => cellToNormalized(point, width, height));
    if (result.status === 'safe') {
      for (const point of result.path) {
        const index = gridIndex(grid, point.x, point.y);
        usage[index] += 1;
      }
    }
    routes.push({
      personId: start.id,
      personLabel: start.label,
      color: start.color,
      status: result.status,
      exitId: result.exitId || null,
      cost: result.cost,
      path: normalizedPath,
    });
  }

  return {
    grid,
    routes,
    allSafe: routes.length > 0 && routes.every((route) => route.status === 'safe'),
    blockedCount: routes.filter((route) => route.status !== 'safe').length,
  };
}

export function filterRoutes(routes, selectedId) {
  if (!selectedId || selectedId === 'all') return routes;
  return routes.filter((route) => route.personId === selectedId);
}

export function validateSceneForPlanning(scene, expectedStartCount = 7) {
  const startCount = Array.isArray(scene?.starts) ? scene.starts.length : 0;
  const exitCount = Array.isArray(scene?.exits) ? scene.exits.length : 0;
  if (startCount !== expectedStartCount) {
    return {
      valid: false,
      code: 'start_count',
      message: `当前有 ${startCount} 个起点，请校准为 ${expectedStartCount} 个绿色门`,
    };
  }
  if (exitCount === 0) {
    return { valid: false, code: 'missing_exit', message: '请至少标记一个安全出口' };
  }
  if (scene?.obstaclesReviewed !== true) {
    return {
      valid: false,
      code: 'obstacles_unreviewed',
      message: '请先逐区核对白色泡沫与其他障碍，并勾选“障碍已复核”',
    };
  }
  return { valid: true, code: 'ready', message: '地图可规划' };
}

function isGreenPixel(data, offset) {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  return green >= 70
    && green > red * 1.22
    && green > blue * 1.18
    && green - Math.min(red, blue) >= 34;
}

export function detectGreenRegions(imageData, options = {}) {
  const { data, width, height } = imageData;
  if (!data || !width || !height) return [];
  const minPixels = Math.max(1, options.minPixels || Math.round((width * height) / 18000));
  const visited = new Uint8Array(width * height);
  const greenMask = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    if (isGreenPixel(data, index * 4)) greenMask[index] = 1;
  }

  const regions = [];
  for (let seed = 0; seed < greenMask.length; seed += 1) {
    if (!greenMask[seed] || visited[seed]) continue;
    const queue = [seed];
    visited[seed] = 1;
    let cursor = 0;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;

    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      count += 1;
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      const candidates = [current - 1, current + 1, current - width, current + width];
      for (const next of candidates) {
        if (next < 0 || next >= greenMask.length || visited[next] || !greenMask[next]) continue;
        const nextX = next % width;
        const nextY = Math.floor(next / width);
        if (Math.abs(nextX - x) + Math.abs(nextY - y) !== 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    if (count >= minPixels) {
      regions.push({
        x: sumX / count / Math.max(1, width - 1),
        y: sumY / count / Math.max(1, height - 1),
        width: (maxX - minX + 1) / width,
        height: (maxY - minY + 1) / height,
        pixels: count,
        confidence: 'candidate',
      });
    }
  }

  return regions.sort((a, b) => b.pixels - a.pixels);
}
