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

function planningCellBounds(bounds, width, height) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
    || bounds.width <= 0 || bounds.height <= 0) {
    return { left: 0, top: 0, right: width - 1, bottom: height - 1 };
  }
  const left = Math.ceil(clamp01(bounds.x) * (width - 1));
  const top = Math.ceil(clamp01(bounds.y) * (height - 1));
  const right = Math.floor(clamp01(bounds.x + bounds.width) * (width - 1));
  const bottom = Math.floor(clamp01(bounds.y + bounds.height) * (height - 1));
  if (left > right || top > bottom) return null;
  return { left, top, right, bottom };
}

function applyPlanningBoundary(grid, planningBounds, clearance) {
  const bounds = planningCellBounds(planningBounds, grid.width, grid.height);
  if (!bounds) {
    grid.cells.fill(CELL_BLOCKED);
    return;
  }
  // A cell on the image/ROI edge has no known clearance outside the frame.
  // Keep one hard boundary cell even for a zero-radius point agent, then move
  // inward by the configured body-clearance radius.
  const inset = Math.max(1, Math.floor(Math.max(0, clearance)) + 1);
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const outside = x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
      const insideEdge = x < bounds.left + inset || x > bounds.right - inset
        || y < bounds.top + inset || y > bounds.bottom - inset;
      if (outside || insideEdge) setCell(grid, x, y, CELL_BLOCKED);
    }
  }
}

function findPortalOpening(grid, protectedGrid, portal, maximumDepth, allowedBounds) {
  const start = normalizedToCell(portal, grid.width, grid.height);
  if (!inBounds(grid, start.x, start.y)
    || start.x < allowedBounds.left || start.x > allowedBounds.right
    || start.y < allowedBounds.top || start.y > allowedBounds.bottom
    || getCell(protectedGrid, start.x, start.y) !== CELL_FREE
    || getCell(grid, start.x, start.y) === CELL_FREE) return [];
  const startIndex = gridIndex(grid, start.x, start.y);
  const visited = new Uint8Array(grid.width * grid.height);
  const parents = new Int32Array(grid.width * grid.height);
  const depths = new Uint16Array(grid.width * grid.height);
  parents.fill(-1);
  visited[startIndex] = 1;
  const queue = [startIndex];
  let cursor = 0;
  const neighbors = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  while (cursor < queue.length) {
    const currentIndex = queue[cursor];
    cursor += 1;
    const currentX = currentIndex % grid.width;
    const currentY = Math.floor(currentIndex / grid.width);
    const depth = depths[currentIndex];
    if (depth >= maximumDepth) continue;

    for (const [dx, dy] of neighbors) {
      const nextX = currentX + dx;
      const nextY = currentY + dy;
      if (!inBounds(grid, nextX, nextY)) continue;
      if (nextX < allowedBounds.left || nextX > allowedBounds.right
        || nextY < allowedBounds.top || nextY > allowedBounds.bottom) continue;
      if (getCell(protectedGrid, nextX, nextY) !== CELL_FREE) continue;
      const nextIndex = gridIndex(grid, nextX, nextY);
      if (visited[nextIndex]) continue;
      parents[nextIndex] = currentIndex;
      depths[nextIndex] = depth + 1;
      if (getCell(grid, nextX, nextY) === CELL_FREE) {
        const opening = [];
        let openingIndex = currentIndex;
        while (openingIndex !== -1) {
          opening.push(openingIndex);
          openingIndex = parents[openingIndex];
        }
        return opening;
      }
      visited[nextIndex] = 1;
      queue.push(nextIndex);
    }
  }
  return [];
}

function openPortalChannels(grid, protectedGrid, portals, clearance, planningBounds) {
  if (!Array.isArray(portals) || portals.length === 0) return;
  const allowedBounds = planningCellBounds(planningBounds, grid.width, grid.height);
  if (!allowedBounds) return;
  const snapshot = createGrid(grid.width, grid.height);
  snapshot.cells.set(grid.cells);
  const portalRadius = Math.max(0, Math.floor(clearance));
  const maximumDepth = Math.max(4, Math.ceil(Math.max(0, clearance)) * 2 + 4);
  const openings = portals.map((portal) => findPortalOpening(
    snapshot,
    protectedGrid,
    portal,
    maximumDepth,
    allowedBounds,
  ));
  for (const opening of openings) {
    for (const index of opening) {
      const centerX = index % grid.width;
      const centerY = Math.floor(index / grid.width);
      for (let dy = -portalRadius; dy <= portalRadius; dy += 1) {
        for (let dx = -portalRadius; dx <= portalRadius; dx += 1) {
          if (dx * dx + dy * dy > portalRadius * portalRadius) continue;
          const x = centerX + dx;
          const y = centerY + dy;
          if (x < allowedBounds.left || x > allowedBounds.right
            || y < allowedBounds.top || y > allowedBounds.bottom) continue;
          if (getCell(protectedGrid, x, y) === CELL_FREE) setCell(grid, x, y, CELL_FREE);
        }
      }
    }
  }
}

export function buildPlanningGrid({
  width,
  height,
  obstacles = [],
  unknowns = [],
  fires = [],
  clearance = 0,
  planningBounds,
  portals = [],
}) {
  const grid = createGrid(width, height);
  const portalProtectedGrid = createGrid(width, height);
  for (const obstacle of obstacles) paintShape(grid, obstacle, CELL_BLOCKED);
  for (const obstacle of obstacles) {
    const inferredCandidate = ['auto-image', 'learned-sample'].includes(obstacle.source)
      && obstacle.confidence !== 'confirmed';
    if (obstacle.kind === 'foam' || !inferredCandidate) {
      paintShape(portalProtectedGrid, obstacle, CELL_BLOCKED);
    }
  }
  for (const unknown of unknowns) {
    paintShape(grid, unknown, CELL_UNKNOWN);
    paintShape(portalProtectedGrid, unknown, CELL_BLOCKED);
  }
  for (const fire of fires) {
    if (fire.hardRadius > 0) {
      const hardFire = { type: 'circle', ...fire, radius: fire.hardRadius };
      paintShape(grid, hardFire, CELL_BLOCKED);
      paintShape(portalProtectedGrid, hardFire, CELL_BLOCKED);
    }
  }
  const inflated = inflateGrid(grid, clearance);
  const inflatedPortalProtection = inflateGrid(portalProtectedGrid, clearance);
  applyPlanningBoundary(inflated, planningBounds, clearance);
  openPortalChannels(inflated, inflatedPortalProtection, portals, clearance, planningBounds);
  return inflated;
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
  clearance,
  minimumPassageWidth,
  planningBounds,
  congestionWeight = 1.4,
}) {
  const resolvedClearance = Number.isFinite(minimumPassageWidth) && minimumPassageWidth > 0
    ? (minimumPassageCellsForWidth(width, minimumPassageWidth) - 1) / 2
    : (Number.isFinite(clearance) ? Math.max(0, Math.round(clearance)) : 1);
  const grid = buildPlanningGrid({
    width,
    height,
    obstacles,
    unknowns,
    fires,
    clearance: resolvedClearance,
    planningBounds,
    portals: [...starts, ...exits],
  });
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
    clearance: resolvedClearance,
    minimumPassageCells: resolvedClearance * 2 + 1,
    allSafe: routes.length > 0 && routes.every((route) => route.status === 'safe'),
    blockedCount: routes.filter((route) => route.status !== 'safe').length,
  };
}

export function minimumPassageCellsForWidth(width, minimumPassageWidth) {
  const normalizedWidth = Number.isFinite(minimumPassageWidth) ? Math.max(0, minimumPassageWidth) : 0;
  const requiredCells = Math.max(1, Math.ceil(normalizedWidth * Math.max(1, width - 1)));
  return requiredCells % 2 === 0 ? requiredCells + 1 : requiredCells;
}

export function filterRoutes(routes, selectedId) {
  if (!selectedId || selectedId === 'all') return routes;
  return routes.filter((route) => route.personId === selectedId);
}

export function validateSceneForPlanning(scene, minimumStartCount = 1) {
  const startCount = Array.isArray(scene?.starts) ? scene.starts.length : 0;
  const exitCount = Array.isArray(scene?.exits) ? scene.exits.length : 0;
  if (startCount < minimumStartCount) {
    return {
      valid: false,
      code: 'missing_start',
      message: '请至少确认一个绿色门起点',
    };
  }
  if (exitCount === 0) {
    return { valid: false, code: 'missing_exit', message: '请至少标记一个安全出口' };
  }
  if (scene?.source === 'photo' && scene?.obstacleScanCompleted !== true) {
    return {
      valid: false,
      code: 'missing_occupancy',
      message: '障碍扫描尚未完成，不能把未识别区域当作可通行道路',
    };
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
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const saturation = maximum ? (maximum - minimum) / maximum : 0;
  const vividGreen = green >= 65
    && green > red * 1.12
    && green > blue * 1.15
    && green - minimum >= 28;
  const paleDoorGreen = green >= 62
    && green >= red * 0.96
    && green > blue * 1.22
    && green - blue >= 24
    && saturation >= 0.2;
  return vividGreen || paleDoorGreen;
}

export function detectGreenRegions(imageData, options = {}) {
  const { data, width, height } = imageData;
  if (!data || !width || !height) return [];
  const minPixels = Math.max(1, options.minPixels || Math.round((width * height) / 18000));
  const minimumRectangularity = Number.isFinite(options.minimumRectangularity)
    ? Math.max(0, options.minimumRectangularity)
    : 0.34;
  const maximumAreaRatio = Number.isFinite(options.maximumAreaRatio)
    ? Math.max(0, options.maximumAreaRatio)
    : 0.18;
  const minimumAreaRatio = Number.isFinite(options.minimumAreaRatio)
    ? Math.max(0, options.minimumAreaRatio)
    : 0;
  const minimumGreenRedRatio = options.minimumGreenRedRatio ?? 0;
  const maximumGreenRedRatio = options.maximumGreenRedRatio ?? Number.POSITIVE_INFINITY;
  const maximumBlueGreenRatio = options.maximumBlueGreenRatio ?? Number.POSITIVE_INFINITY;
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
    let sumRed = 0;
    let sumGreen = 0;
    let sumBlue = 0;
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
      const colorOffset = current * 4;
      sumRed += data[colorOffset];
      sumGreen += data[colorOffset + 1];
      sumBlue += data[colorOffset + 2];
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

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const boxArea = boxWidth * boxHeight;
    const rectangularity = boxArea ? count / boxArea : 0;
    const areaRatio = boxArea / (width * height);
    const greenRedRatio = sumGreen / Math.max(1, sumRed);
    const blueGreenRatio = sumBlue / Math.max(1, sumGreen);
    if (count >= minPixels
      && rectangularity >= minimumRectangularity
      && areaRatio >= minimumAreaRatio
      && areaRatio <= maximumAreaRatio
      && greenRedRatio >= minimumGreenRedRatio
      && greenRedRatio <= maximumGreenRedRatio
      && blueGreenRatio <= maximumBlueGreenRatio) {
      regions.push({
        x: sumX / count / Math.max(1, width - 1),
        y: sumY / count / Math.max(1, height - 1),
        width: boxWidth / width,
        height: boxHeight / height,
        left: minX / width,
        top: minY / height,
        right: (maxX + 1) / width,
        bottom: (maxY + 1) / height,
        pixels: count,
        rectangularity,
        areaRatio,
        greenRedRatio,
        blueGreenRatio,
        confidence: 'candidate',
      });
    }
  }

  return regions.sort((a, b) => b.rectangularity - a.rectangularity || b.pixels - a.pixels);
}

function pixelMetrics(data, offset) {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  return {
    luminance: red * 0.2126 + green * 0.7152 + blue * 0.0722,
    saturation: maximum ? (maximum - minimum) / maximum : 0,
  };
}

function extractRegionFeatures(imageData, left, top, right, bottom) {
  const { data, width, height } = imageData;
  const safeLeft = Math.max(0, Math.floor(left));
  const safeTop = Math.max(0, Math.floor(top));
  const safeRight = Math.min(width, Math.ceil(right));
  const safeBottom = Math.min(height, Math.ceil(bottom));
  let count = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let saturation = 0;
  let luminance = 0;
  let luminanceSquared = 0;
  let edge = 0;
  let edgeCount = 0;

  for (let y = safeTop; y < safeBottom; y += 1) {
    for (let x = safeLeft; x < safeRight; x += 1) {
      const offset = (y * width + x) * 4;
      const metrics = pixelMetrics(data, offset);
      red += data[offset] / 255;
      green += data[offset + 1] / 255;
      blue += data[offset + 2] / 255;
      saturation += metrics.saturation;
      const normalizedLuminance = metrics.luminance / 255;
      luminance += normalizedLuminance;
      luminanceSquared += normalizedLuminance * normalizedLuminance;
      count += 1;
      if (x + 1 < safeRight) {
        const neighbor = pixelMetrics(data, offset + 4).luminance / 255;
        edge += Math.abs(normalizedLuminance - neighbor);
        edgeCount += 1;
      }
      if (y + 1 < safeBottom) {
        const neighborOffset = ((y + 1) * width + x) * 4;
        const neighbor = pixelMetrics(data, neighborOffset).luminance / 255;
        edge += Math.abs(normalizedLuminance - neighbor);
        edgeCount += 1;
      }
    }
  }

  if (!count) return null;
  const meanLuminance = luminance / count;
  return {
    red: red / count,
    green: green / count,
    blue: blue / count,
    saturation: saturation / count,
    luminanceStd: Math.sqrt(Math.max(0, luminanceSquared / count - meanLuminance * meanLuminance)),
    edgeDensity: edge / Math.max(1, edgeCount),
  };
}

export function extractVisualFeatures(imageData) {
  if (!imageData?.data || !imageData.width || !imageData.height) return null;
  return extractRegionFeatures(imageData, 0, 0, imageData.width, imageData.height);
}

function visualFeatureDistance(left, right) {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  const weighted = [
    ['red', 1.4],
    ['green', 1.4],
    ['blue', 1.4],
    ['saturation', 0.7],
    ['luminanceStd', 0.8],
    ['edgeDensity', 0.8],
  ];
  return Math.sqrt(weighted.reduce((total, [key, weight]) => {
    const difference = (left[key] || 0) - (right[key] || 0);
    return total + difference * difference * weight;
  }, 0));
}

function detectLearnedCategoryRegions(imageData, samples = [], categories = [], options = {}) {
  const acceptedCategories = new Set(categories);
  const prototypes = samples.filter((sample) => (
    sample?.features && acceptedCategories.has(sample.category)
  ));
  if (!imageData?.data || !imageData.width || !imageData.height || !prototypes.length) return [];
  const tileSize = Math.max(4, Math.round(options.tileSize ?? 14));
  const columns = Math.ceil(imageData.width / tileSize);
  const rows = Math.ceil(imageData.height / tileSize);
  const matchedMasks = new Map(categories.map((category) => [category, new Uint8Array(columns * rows)]));
  const threshold = Math.max(0, options.matchThreshold ?? 0.115);

  for (let tileY = 0; tileY < rows; tileY += 1) {
    for (let tileX = 0; tileX < columns; tileX += 1) {
      const features = extractRegionFeatures(
        imageData,
        tileX * tileSize,
        tileY * tileSize,
        Math.min(imageData.width, (tileX + 1) * tileSize),
        Math.min(imageData.height, (tileY + 1) * tileSize),
      );
      let closestSample = null;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const sample of prototypes) {
        const distance = visualFeatureDistance(features, sample.features);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestSample = sample;
        }
      }
      if (closestDistance <= threshold) {
        const index = tileY * columns + tileX;
        matchedMasks.get(closestSample.category)[index] = 1;
      }
    }
  }

  const padding = options.padding ?? 0.008;
  return categories.flatMap((category) => {
    const regions = maskRegions(matchedMasks.get(category), columns, rows, {
      minPixels: options.minimumMatchedTiles ?? 1,
      maximumAreaRatio: options.maximumAreaRatio ?? 0.2,
      minimumFillRatio: options.minimumFillRatio ?? 0.35,
    });
    return regions.map((region, index) => {
      const left = Math.max(0, region.minX * tileSize / imageData.width - padding);
      const top = Math.max(0, region.minY * tileSize / imageData.height - padding);
      const right = Math.min(1, (region.maxX + 1) * tileSize / imageData.width + padding);
      const bottom = Math.min(1, (region.maxY + 1) * tileSize / imageData.height + padding);
      return {
        id: `learned-${category}-${index + 1}`,
        category,
        type: 'rect',
        source: 'learned-sample',
        confidence: 'candidate',
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        matchedTiles: region.count,
      };
    });
  });
}

export function detectLearnedObstacleRegions(imageData, samples = [], options = {}) {
  return detectLearnedCategoryRegions(
    imageData,
    samples,
    ['obstacle', 'building', 'foam'],
    options,
  ).map((region, index) => ({
    ...region,
    id: `learned-obstacle-${index + 1}`,
    kind: region.category === 'foam'
      ? 'foam'
      : (region.category === 'building' ? 'building' : 'object'),
  }));
}

export function detectLearnedFireRegions(imageData, samples = [], options = {}) {
  return detectLearnedCategoryRegions(imageData, samples, ['fire'], options).map((region, index) => ({
    ...region,
    id: `learned-fire-${index + 1}`,
    x: region.x + region.width / 2,
    y: region.y + region.height / 2,
    hardRadius: Math.max(0.018, Math.min(0.04, Math.min(region.width, region.height) / 2)),
    radius: Math.max(0.1, Math.min(0.18, Math.max(region.width, region.height) * 2.5)),
    intensity: 7,
  }));
}

export function detectLearnedGreenDoorRegions(imageData, samples = [], options = {}) {
  return detectLearnedCategoryRegions(imageData, samples, ['green-door'], options).map((region, index) => ({
    ...region,
    id: `learned-green-door-${index + 1}`,
    x: region.x + region.width / 2,
    y: region.y + region.height / 2,
    pixels: region.matchedTiles,
  }));
}

function dilateMask(mask, width, height, radius = 1) {
  if (radius <= 0) return mask;
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
          output[nextY * width + nextX] = 1;
        }
      }
    }
  }
  return output;
}

function maskRegions(mask, width, height, options = {}) {
  const visited = new Uint8Array(mask.length);
  const regions = [];
  const minPixels = Math.max(1, options.minPixels || 1);
  const maximumAreaRatio = options.maximumAreaRatio ?? 0.18;
  const minimumFillRatio = options.minimumFillRatio ?? 0.06;

  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || visited[seed]) continue;
    const queue = [seed];
    visited[seed] = 1;
    let cursor = 0;
    let count = 0;
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
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (visited[next] || !mask[next]) continue;
          visited[next] = 1;
          queue.push(next);
        }
      }
    }
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const boxArea = boxWidth * boxHeight;
    const areaRatio = boxArea / (width * height);
    const fillRatio = count / boxArea;
    if (count < minPixels || areaRatio > maximumAreaRatio || fillRatio < minimumFillRatio) continue;
    regions.push({ minX, minY, maxX, maxY, count, areaRatio, fillRatio });
  }
  return regions;
}

function expandRegion(region, width, height, padding) {
  const padX = padding * width;
  const padY = padding * height;
  const left = Math.max(0, region.minX - padX) / width;
  const top = Math.max(0, region.minY - padY) / height;
  const right = Math.min(width, region.maxX + 1 + padX) / width;
  const bottom = Math.min(height, region.maxY + 1 + padY) / height;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function rectanglesNear(first, second, gap) {
  return first.x <= second.x + second.width + gap
    && second.x <= first.x + first.width + gap
    && first.y <= second.y + second.height + gap
    && second.y <= first.y + first.height + gap;
}

function mergeObstacleRectangles(rectangles, gap, maximumAreaRatio = 1) {
  const pending = rectangles.map((rectangle) => ({ ...rectangle }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let leftIndex = 0; leftIndex < pending.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < pending.length; rightIndex += 1) {
        const left = pending[leftIndex];
        const right = pending[rightIndex];
        if (!rectanglesNear(left, right, gap)) continue;
        const x = Math.min(left.x, right.x);
        const y = Math.min(left.y, right.y);
        const maximumX = Math.max(left.x + left.width, right.x + right.width);
        const maximumY = Math.max(left.y + left.height, right.y + right.height);
        if ((maximumX - x) * (maximumY - y) > maximumAreaRatio) continue;
        pending[leftIndex] = {
          ...left,
          kind: left.kind === 'foam' && right.kind === 'foam' ? 'foam' : 'object',
          x,
          y,
          width: maximumX - x,
          height: maximumY - y,
          pixels: left.pixels + right.pixels,
        };
        pending.splice(rightIndex, 1);
        changed = true;
        break outer;
      }
    }
  }
  return pending;
}

export function detectObstacleRegions(imageData, options = {}) {
  const { data, width, height } = imageData;
  if (!data || !width || !height) return [];
  const totalPixels = width * height;
  const minimumPixels = Math.max(4, options.minPixels || Math.round(totalPixels / 12000));
  const objectMask = new Uint8Array(totalPixels);
  const foamMask = new Uint8Array(totalPixels);
  const luminances = new Uint8Array(totalPixels);
  for (let index = 0; index < totalPixels; index += 1) {
    luminances[index] = Math.round(pixelMetrics(data, index * 4).luminance);
  }
  const sortedLuminances = Uint8Array.from(luminances).sort();
  const medianLuminance = sortedLuminances[Math.floor(sortedLuminances.length / 2)] || 160;
  const darkThreshold = options.darkThreshold ?? Math.min(112, medianLuminance * 0.68);

  for (let index = 0; index < totalPixels; index += 1) {
    const offset = index * 4;
    if ((data[offset + 3] ?? 255) < 200) continue;
    const { luminance, saturation } = pixelMetrics(data, offset);
    const darkObject = luminance <= darkThreshold;
    const vividObject = saturation >= 0.42 && luminance <= 210;
    const brightFoam = luminance >= 232 && saturation <= 0.11;
    if (brightFoam) foamMask[index] = 1;
    else if (darkObject || vividObject) objectMask[index] = 1;
  }

  // Green is not automatically walkable: saturated green toys and clutter
  // must remain obstacles. Suppress only compact panels that satisfy the same
  // bounded colour/shape profile used for automatic green-door candidates.
  const greenDoorOptions = {
    minPixels: Math.max(10, Math.round(totalPixels / 18000)),
    minimumRectangularity: 0.4,
    minimumAreaRatio: 0.0004,
    maximumAreaRatio: 0.015,
    minimumGreenRedRatio: 0.98,
    maximumGreenRedRatio: 1.35,
    maximumBlueGreenRatio: 0.75,
    ...(options.greenDoorOptions || {}),
  };
  const acceptedDoors = detectGreenRegions(imageData, greenDoorOptions);
  for (const door of acceptedDoors) {
    const left = Math.max(0, Math.floor(door.left * width));
    const top = Math.max(0, Math.floor(door.top * height));
    const right = Math.min(width - 1, Math.ceil(door.right * width) - 1);
    const bottom = Math.min(height - 1, Math.ceil(door.bottom * height) - 1);
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) objectMask[y * width + x] = 0;
    }
  }

  const allGreenComponents = detectGreenRegions(imageData, {
    minPixels: Math.max(10, minimumPixels),
    minimumRectangularity: 0.03,
    minimumAreaRatio: 0,
    maximumAreaRatio: 0.04,
    minimumGreenRedRatio: 1.12,
    maximumBlueGreenRatio: 0.75,
  });
  const rejectedGreenRegions = allGreenComponents.filter((component) => !acceptedDoors.some((door) => {
    const left = Math.max(component.left, door.left);
    const top = Math.max(component.top, door.top);
    const right = Math.min(component.right, door.right);
    const bottom = Math.min(component.bottom, door.bottom);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const componentArea = Math.max(1e-6, component.width * component.height);
    return intersection / componentArea >= 0.5;
  }));

  const morphologyRadius = Math.max(0, Math.round(options.morphologyRadius ?? 1));
  const regionOptions = {
    minPixels: minimumPixels,
    maximumAreaRatio: options.maximumAreaRatio ?? 0.18,
    minimumFillRatio: options.minimumFillRatio ?? 0.06,
  };
  const padding = options.padding ?? 0.01;
  const objectRegions = maskRegions(dilateMask(objectMask, width, height, morphologyRadius), width, height, regionOptions)
    .map((region) => ({
      ...expandRegion(region, width, height, padding),
      kind: 'object',
      pixels: region.count,
    }));
  const greenClutterRegions = rejectedGreenRegions.map((region) => ({
    ...expandRegion({
      minX: region.left * width,
      minY: region.top * height,
      maxX: region.right * width - 1,
      maxY: region.bottom * height - 1,
    }, width, height, padding),
    kind: 'object',
    pixels: region.pixels,
  }));
  const foamRegions = maskRegions(dilateMask(foamMask, width, height, morphologyRadius), width, height, regionOptions)
    .filter((region) => {
      const boxWidth = region.maxX - region.minX + 1;
      const boxHeight = region.maxY - region.minY + 1;
      const aspect = Math.max(boxWidth / boxHeight, boxHeight / boxWidth);
      return aspect >= 2 || region.fillRatio >= 0.5;
    })
    .map((region) => ({
      ...expandRegion(region, width, height, padding),
      kind: 'foam',
      pixels: region.count,
    }));
  const merged = mergeObstacleRectangles(
    [...objectRegions, ...foamRegions],
    options.mergeGap ?? 0.018,
    options.maximumMergedAreaRatio ?? 0.16,
  );
  const unrepresentedGreenClutter = greenClutterRegions.filter((greenRegion) => !merged.some((region) => {
    const left = Math.max(greenRegion.x, region.x);
    const top = Math.max(greenRegion.y, region.y);
    const right = Math.min(greenRegion.x + greenRegion.width, region.x + region.width);
    const bottom = Math.min(greenRegion.y + greenRegion.height, region.y + region.height);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    return intersection / Math.max(1e-6, greenRegion.width * greenRegion.height) >= 0.6;
  }));
  const candidates = [...merged, ...unrepresentedGreenClutter]
    .sort((first, second) => (second.width * second.height) - (first.width * first.height));

  return candidates.map((region, index) => ({
    id: `auto-obstacle-${index + 1}`,
    type: 'rect',
    source: 'auto-image',
    confidence: 'candidate',
    ...region,
  }));
}
