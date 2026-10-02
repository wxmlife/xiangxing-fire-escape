import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CELL_FREE,
  CELL_BLOCKED,
  createGrid,
  setCell,
  getCell,
  inflateGrid,
  buildPlanningGrid,
  findPath,
  planEvacuation,
  filterRoutes,
  detectGreenRegions,
  detectObstacleRegions,
  detectLearnedFireRegions,
  detectLearnedGreenDoorRegions,
  detectLearnedObstacleRegions,
  extractVisualFeatures,
  validateSceneForPlanning,
} from '../dist/planner.mjs';
import { demoScene } from '../dist/demo-scene.mjs';

function createImageData(width, height, color = [188, 158, 116, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data.set(color, index * 4);
  }
  return { data, width, height };
}

function paintRectangle(imageData, left, top, right, bottom, color) {
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      imageData.data.set(color, (y * imageData.width + x) * 4);
    }
  }
}

test('A* reaches the exit without crossing a blocked wall', () => {
  const grid = createGrid(7, 5);
  for (let y = 0; y < 4; y += 1) setCell(grid, 3, y, CELL_BLOCKED);

  const result = findPath(grid, { x: 0, y: 2 }, [{ id: 'east', x: 6, y: 2 }]);

  assert.equal(result.status, 'safe');
  assert.deepEqual(result.path.at(-1), { x: 6, y: 2 });
  assert.ok(result.cost > 6, 'route should cost more than the blocked straight line');
  for (const point of result.path) {
    assert.notEqual(getCell(grid, point.x, point.y), CELL_BLOCKED);
  }
});

test('A* rejects starts and exits that are inside hard obstacles', () => {
  const grid = createGrid(9, 5);
  setCell(grid, 1, 2, CELL_BLOCKED);
  setCell(grid, 7, 2, CELL_BLOCKED);

  const blockedStart = findPath(grid, { x: 1, y: 2 }, [{ id: 'east', x: 8, y: 2 }]);
  const blockedExit = findPath(grid, { x: 0, y: 2 }, [{ id: 'east', x: 7, y: 2 }]);

  assert.equal(blockedStart.status, 'blocked');
  assert.equal(blockedExit.status, 'blocked');
});

test('obstacle inflation reserves clearance around every blocked cell', () => {
  const grid = createGrid(7, 7);
  setCell(grid, 3, 3, CELL_BLOCKED);

  const inflated = inflateGrid(grid, 2);

  assert.equal(getCell(inflated, 3, 3), CELL_BLOCKED);
  assert.equal(getCell(inflated, 5, 3), CELL_BLOCKED);
  assert.equal(getCell(inflated, 3, 5), CELL_BLOCKED);
  assert.equal(getCell(inflated, 5, 5), 0, 'cells outside the circular clearance stay free');
});

test('a two-cell body radius closes four-cell alleys but permits five-cell alleys', () => {
  const corridor = (rightWallX) => {
    const grid = createGrid(11, 9);
    for (let y = 0; y < grid.height; y += 1) {
      setCell(grid, 2, y, CELL_BLOCKED);
      setCell(grid, rightWallX, y, CELL_BLOCKED);
    }
    return inflateGrid(grid, 2);
  };

  const fourCellAlley = findPath(corridor(7), { x: 5, y: 0 }, [{ id: 'south', x: 5, y: 8 }]);
  const fiveCellAlley = findPath(corridor(8), { x: 5, y: 0 }, [{ id: 'south', x: 5, y: 8 }]);

  assert.equal(fourCellAlley.status, 'blocked');
  assert.equal(fiveCellAlley.status, 'safe');
});

test('any number of escapees receive routes that avoid a hard fire exclusion zone', () => {
  const starts = Array.from({ length: 9 }, (_, index) => ({
    id: `p${index + 1}`,
    label: `逃生者${index + 1}`,
    x: 0.08,
    y: 0.08 + index * 0.105,
  }));

  const result = planEvacuation({
    width: 80,
    height: 60,
    starts,
    exits: [{ id: 'east', label: '东侧安全口', x: 0.94, y: 0.5 }],
    obstacles: [],
    fires: [{ x: 0.5, y: 0.5, hardRadius: 0.12, radius: 0.25, intensity: 6 }],
    clearance: 1,
  });

  assert.equal(result.routes.length, 9);
  assert.ok(result.routes.every((route) => route.status === 'safe'));
  for (const route of result.routes) {
    for (const point of route.path) {
      const distance = Math.hypot(point.x - 0.5, point.y - 0.5);
      assert.ok(distance >= 0.1, 'route entered the fire exclusion zone');
    }
  }
});

test('route filtering switches between overview and one escapee', () => {
  const routes = [{ personId: 'p1' }, { personId: 'p2' }];

  assert.equal(filterRoutes(routes, 'all').length, 2);
  assert.deepEqual(filterRoutes(routes, 'p2'), [{ personId: 'p2' }]);
});

test('scene validation accepts any positive number of confirmed green-door starts', () => {
  const validBase = {
    starts: Array.from({ length: 3 }, (_, index) => ({ id: `p${index}` })),
    exits: [{ id: 'north' }],
    obstaclesReviewed: true,
  };

  assert.equal(validateSceneForPlanning(validBase).valid, true);
  assert.equal(validateSceneForPlanning({ ...validBase, starts: [] }).code, 'missing_start');
  assert.equal(validateSceneForPlanning({ ...validBase, starts: Array.from({ length: 9 }, (_, index) => ({ id: `p${index}` })) }).valid, true);
  assert.equal(validateSceneForPlanning({ ...validBase, exits: [] }).code, 'missing_exit');
  assert.equal(validateSceneForPlanning({ ...validBase, source: 'photo', obstacleScanCompleted: false }).code, 'missing_occupancy');
  assert.equal(validateSceneForPlanning({ ...validBase, source: 'photo', obstacleScanCompleted: true }).valid, true);
  assert.equal(validateSceneForPlanning({ ...validBase, obstaclesReviewed: false }).code, 'obstacles_unreviewed');
});

test('green region detection ignores isolated noise and returns normalized centers', () => {
  const width = 8;
  const height = 4;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 4] = 180;
    data[pixel * 4 + 1] = 160;
    data[pixel * 4 + 2] = 120;
    data[pixel * 4 + 3] = 255;
  }
  const paintGreen = (x, y) => {
    const offset = (y * width + x) * 4;
    data[offset] = 28;
    data[offset + 1] = 180;
    data[offset + 2] = 72;
  };
  paintGreen(1, 1);
  paintGreen(2, 1);
  paintGreen(1, 2);
  paintGreen(6, 0);

  const regions = detectGreenRegions({ data, width, height }, { minPixels: 2 });

  assert.equal(regions.length, 1);
  assert.ok(Math.abs(regions[0].x - (4 / 3) / 7) < 0.01);
  assert.ok(Math.abs(regions[0].y - (4 / 3) / 3) < 0.01);
});

test('green-door recognition keeps all compact rectangular doors and rejects sparse green vehicles', () => {
  const imageData = createImageData(96, 48);
  const green = [105, 112, 48, 255];
  for (let index = 0; index < 9; index += 1) {
    const left = 3 + index * 10;
    paintRectangle(imageData, left, index % 2 ? 31 : 6, left + 4, index % 2 ? 35 : 10, green);
  }

  // A connected, bike-like cross has enough green pixels to beat minPixels,
  // but its sparse bounding box is not a rectangular door panel.
  for (let offset = 0; offset < 11; offset += 1) {
    paintRectangle(imageData, 46 + offset, 20, 46 + offset, 20, [36, 190, 72, 255]);
    paintRectangle(imageData, 51, 15 + offset, 51, 15 + offset, [36, 190, 72, 255]);
  }
  // A solid neon-green toy can also look rectangular at low resolution. The
  // door profile rejects this hue while keeping the yellow-green door cards.
  paintRectangle(imageData, 80, 20, 85, 25, [30, 190, 35, 255]);

  const regions = detectGreenRegions(imageData, {
    minPixels: 8,
    minimumRectangularity: 0.45,
    maximumAreaRatio: 0.03,
    minimumAreaRatio: 0.0004,
    minimumGreenRedRatio: 0.98,
    maximumGreenRedRatio: 1.35,
    maximumBlueGreenRatio: 0.75,
  });

  assert.equal(regions.length, 9, 'door count must come from the image instead of a fixed seven-item cap');
  assert.ok(regions.every((region) => region.rectangularity >= 0.45));
});

test('automatic obstacle recognition closes a corridor filled by dense clutter', () => {
  const imageData = createImageData(80, 50);
  paintRectangle(imageData, 36, 10, 39, 30, [43, 42, 38, 255]);
  paintRectangle(imageData, 41, 19, 44, 39, [184, 38, 34, 255]);

  const detected = detectObstacleRegions(imageData, {
    minPixels: 18,
    mergeGap: 0.04,
    padding: 0.006,
  });

  assert.equal(detected.length, 1, 'nearby clutter must merge into one conservative blocked region');
  assert.equal(detected[0].confidence, 'candidate');
  assert.equal(detected[0].source, 'auto-image');

  const result = planEvacuation({
    width: 80,
    height: 50,
    obstacles: [
      { id: 'north-wall', kind: 'building', type: 'rect', x: 0, y: 0, width: 1, height: 0.2 },
      { id: 'south-wall', kind: 'building', type: 'rect', x: 0, y: 0.78, width: 1, height: 0.22 },
      ...detected,
    ],
    starts: [{ id: 'p1', label: '1号', x: 0.1, y: 0.5 }],
    exits: [{ id: 'east', label: '东侧安全口', x: 0.9, y: 0.5 }],
    minimumPassageWidth: 0.046,
  });

  assert.equal(result.routes[0].status, 'blocked');
  assert.deepEqual(result.routes[0].path, []);
});

test('green objects rejected by the door profile remain obstacle candidates', () => {
  const imageData = createImageData(100, 60);
  const doorCenter = { x: 12 / 99, y: 15 / 59 };
  const toyCenter = { x: 67 / 99, y: 39 / 59 };

  // This compact yellow-green panel matches the same bounded colour profile
  // used for automatic green-door candidates.
  paintRectangle(imageData, 9, 11, 15, 19, [105, 112, 48, 255]);
  // This saturated toy is green, but its hue is far outside the door profile.
  // It must stay in the occupancy mask instead of disappearing from both scans.
  paintRectangle(imageData, 63, 36, 71, 42, [30, 190, 35, 255]);

  const detected = detectObstacleRegions(imageData, {
    minPixels: 12,
    morphologyRadius: 0,
    padding: 0,
    mergeGap: 0,
  });
  const contains = (region, point) => point.x >= region.x
    && point.x <= region.x + region.width
    && point.y >= region.y
    && point.y <= region.y + region.height;

  assert.ok(detected.some((region) => contains(region, toyCenter)), 'rejected green toy vanished from the obstacle scan');
  assert.equal(detected.some((region) => contains(region, doorCenter)), false, 'accepted green door was mislabeled as clutter');
});

test('automatic obstacle recognition marks bright elongated foam as a hard candidate', () => {
  const imageData = createImageData(72, 48);
  paintRectangle(imageData, 5, 20, 34, 23, [242, 244, 240, 255]);

  const detected = detectObstacleRegions(imageData, { minPixels: 20 });

  assert.equal(detected.length, 1);
  assert.equal(detected[0].kind, 'foam');
});

test('nearby obstacle merging cannot grow into an image-spanning false wall', () => {
  const imageData = createImageData(100, 40);
  for (let left = 4; left <= 79; left += 15) {
    paintRectangle(imageData, left, 10, left + 5, 29, [38, 37, 34, 255]);
  }

  const detected = detectObstacleRegions(imageData, {
    minPixels: 15,
    mergeGap: 0.12,
    padding: 0,
    maximumMergedAreaRatio: 0.12,
  });

  assert.ok(detected.length > 1);
  assert.ok(detected.every((region) => region.width * region.height <= 0.12));
});

test('clearance blocks the image edge instead of allowing an edge-hugging bypass', () => {
  const result = planEvacuation({
    width: 31,
    height: 21,
    clearance: 1,
    obstacles: [{ id: 'divider', type: 'rect', x: 0.48, y: 0.14, width: 0.04, height: 0.72 }],
    starts: [{ id: 'west', x: 0.2, y: 0.5 }],
    exits: [{ id: 'east', x: 0.8, y: 0.5 }],
  });

  assert.equal(result.routes[0].status, 'blocked');
  assert.equal(getCell(result.grid, 0, 10), CELL_BLOCKED);
  assert.equal(getCell(result.grid, 1, 10), CELL_BLOCKED);
});

test('planning bounds make every cell outside the calibrated walkable ROI hard-blocked', () => {
  const bounds = { x: 0.15, y: 0.15, width: 0.7, height: 0.7 };
  const result = planEvacuation({
    width: 41,
    height: 31,
    clearance: 1,
    planningBounds: bounds,
    obstacles: [{ id: 'roi-divider', type: 'rect', x: 0.48, y: 0.2, width: 0.04, height: 0.6 }],
    starts: [{ id: 'west', x: 0.25, y: 0.5 }],
    exits: [{ id: 'east', x: 0.75, y: 0.5 }],
  });

  assert.equal(result.routes[0].status, 'blocked');
  assert.equal(getCell(result.grid, 2, 15), CELL_BLOCKED, 'cell left of ROI stayed traversable');
  assert.equal(getCell(result.grid, 38, 15), CELL_BLOCKED, 'cell right of ROI stayed traversable');
});

test('confirmed start and exit portals open a clearance-width channel only through overlapping automatic candidates', () => {
  const start = { id: 'door-start', x: 0.2, y: 0.5 };
  const exit = { id: 'door-exit', x: 0.8, y: 0.5 };
  const obstacles = [
    {
      id: 'start-false-positive',
      type: 'rect',
      x: 0.15,
      y: 0.38,
      width: 0.1,
      height: 0.24,
      source: 'auto-image',
      confidence: 'candidate',
    },
    {
      id: 'exit-false-positive',
      type: 'rect',
      x: 0.75,
      y: 0.38,
      width: 0.1,
      height: 0.24,
      source: 'auto-image',
      confidence: 'candidate',
    },
  ];

  const withoutPortals = buildPlanningGrid({ width: 41, height: 21, obstacles, clearance: 1 });
  const result = planEvacuation({
    width: 41,
    height: 21,
    clearance: 1,
    obstacles,
    starts: [start],
    exits: [exit],
  });
  const startCell = { x: 8, y: 10 };
  const exitCell = { x: 32, y: 10 };

  assert.equal(getCell(withoutPortals, startCell.x, startCell.y), CELL_BLOCKED);
  assert.equal(getCell(result.grid, startCell.x, startCell.y), CELL_FREE);
  assert.equal(getCell(result.grid, exitCell.x, exitCell.y), CELL_FREE);
  assert.equal(result.routes[0].status, 'safe');
  assert.equal(result.minimumPassageCells, 3);
  for (const offset of [-1, 0, 1]) {
    assert.equal(getCell(result.grid, startCell.x + offset, startCell.y), CELL_FREE, 'start portal is narrower than its clearance');
    assert.equal(getCell(result.grid, exitCell.x + offset, exitCell.y), CELL_FREE, 'exit portal is narrower than its clearance');
  }
});

test('automatic candidate portals honor a five-cell minimum passage width', () => {
  const start = { id: 'door-start', x: 0.2, y: 0.5 };
  const exit = { id: 'door-exit', x: 0.8, y: 0.5 };
  const candidate = (id, x) => ({
    id,
    type: 'rect',
    x,
    y: 0.3,
    width: 0.15,
    height: 0.4,
    source: 'auto-image',
    confidence: 'candidate',
  });
  const result = planEvacuation({
    width: 41,
    height: 21,
    minimumPassageWidth: 0.1,
    obstacles: [candidate('start-false-positive', 0.125), candidate('exit-false-positive', 0.725)],
    starts: [start],
    exits: [exit],
  });
  const startCell = { x: 8, y: 10 };
  const exitCell = { x: 32, y: 10 };

  assert.equal(result.clearance, 2);
  assert.equal(result.minimumPassageCells, 5);
  assert.equal(result.routes[0].status, 'safe');
  for (const offset of [-2, -1, 0, 1, 2]) {
    assert.equal(getCell(result.grid, startCell.x + offset, startCell.y), CELL_FREE, 'start portal failed the five-cell cross-section');
    assert.equal(getCell(result.grid, exitCell.x + offset, exitCell.y), CELL_FREE, 'exit portal failed the five-cell cross-section');
  }
});

test('confirmed portals never carve through manual or confirmed obstacles', () => {
  const protectedObstacles = [
    { source: 'manual', confidence: 'candidate', label: 'manual obstacle' },
    { source: 'auto-image', confidence: 'confirmed', label: 'confirmed obstacle' },
  ];

  for (const protectedObstacle of protectedObstacles) {
    const result = planEvacuation({
      width: 41,
      height: 21,
      clearance: 1,
      obstacles: [{
        id: protectedObstacle.label,
        type: 'rect',
        x: 0.15,
        y: 0.38,
        width: 0.1,
        height: 0.24,
        source: protectedObstacle.source,
        confidence: protectedObstacle.confidence,
      }],
      starts: [{ id: 'protected-start', x: 0.2, y: 0.5 }],
      exits: [{ id: 'east', x: 0.8, y: 0.5 }],
    });

    assert.equal(result.routes[0].status, 'blocked', `${protectedObstacle.label} was carved open`);
    assert.equal(getCell(result.grid, 8, 10), CELL_BLOCKED, `${protectedObstacle.label} lost its hard-blocked center`);
  }
});

test('portals outside planning bounds cannot rescue an out-of-bounds start or exit', () => {
  const planningBounds = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
  const outsideStart = planEvacuation({
    width: 41,
    height: 21,
    clearance: 1,
    planningBounds,
    starts: [{ id: 'outside-start', x: 0.1, y: 0.5 }],
    exits: [{ id: 'inside-exit', x: 0.7, y: 0.5 }],
  });
  const outsideExit = planEvacuation({
    width: 41,
    height: 21,
    clearance: 1,
    planningBounds,
    starts: [{ id: 'inside-start', x: 0.3, y: 0.5 }],
    exits: [{ id: 'outside-exit', x: 0.9, y: 0.5 }],
  });

  assert.equal(outsideStart.routes[0].status, 'blocked');
  assert.equal(getCell(outsideStart.grid, 4, 10), CELL_BLOCKED, 'outside start was carved into the ROI');
  assert.equal(outsideExit.routes[0].status, 'blocked');
  assert.equal(getCell(outsideExit.grid, 36, 10), CELL_BLOCKED, 'outside exit was carved into the ROI');
});

test('a confirmed portal never carves through the hard fire exclusion zone', () => {
  const result = planEvacuation({
    width: 41,
    height: 21,
    clearance: 1,
    fires: [{ x: 0.2, y: 0.5, hardRadius: 0.08, radius: 0.2, intensity: 9 }],
    starts: [{ id: 'unsafe-start', x: 0.2, y: 0.5 }],
    exits: [{ id: 'east', x: 0.8, y: 0.5 }],
  });

  assert.equal(result.routes[0].status, 'blocked');
  assert.equal(getCell(result.grid, 8, 10), CELL_BLOCKED);
});

test('a confirmed portal never carves through foam marked as unconditionally impassable', () => {
  const result = planEvacuation({
    width: 41,
    height: 21,
    clearance: 1,
    obstacles: [{ kind: 'foam', type: 'rect', x: 0.15, y: 0.38, width: 0.1, height: 0.24 }],
    starts: [{ id: 'foam-start', x: 0.2, y: 0.5 }],
    exits: [{ id: 'east', x: 0.8, y: 0.5 }],
  });

  assert.equal(result.routes[0].status, 'blocked');
  assert.equal(getCell(result.grid, 8, 10), CELL_BLOCKED);
});

test('locally uploaded obstacle samples add appearance-matched obstacle candidates', () => {
  const sample = createImageData(16, 16, [150, 135, 105, 255]);
  const scene = createImageData(72, 48, [190, 175, 145, 255]);
  paintRectangle(scene, 28, 14, 43, 33, [150, 135, 105, 255]);

  const detected = detectLearnedObstacleRegions(scene, [{
    category: 'building',
    features: extractVisualFeatures(sample),
  }], {
    tileSize: 8,
    matchThreshold: 0.1,
  });

  assert.ok(detected.length >= 1);
  assert.ok(detected.some((region) => (
    0.5 >= region.x
    && 0.5 <= region.x + region.width
    && 0.5 >= region.y
    && 0.5 <= region.y + region.height
  )));
  assert.ok(detected.every((region) => region.source === 'learned-sample'));
  assert.ok(detected.every((region) => region.kind === 'building'), 'sample category should be retained by the matcher');
});

test('learned fire samples create candidate fire markers without becoming obstacle candidates', () => {
  const sample = createImageData(12, 12, [225, 48, 20, 255]);
  const scene = createImageData(64, 48, [182, 168, 142, 255]);
  paintRectangle(scene, 24, 16, 39, 31, [225, 48, 20, 255]);
  const samples = [{ category: 'fire', features: extractVisualFeatures(sample) }];

  const fires = detectLearnedFireRegions(scene, samples, {
    tileSize: 8,
    matchThreshold: 0.05,
  });
  const obstacles = detectLearnedObstacleRegions(scene, samples, {
    tileSize: 8,
    matchThreshold: 0.05,
  });

  assert.ok(fires.length >= 1);
  assert.ok(fires.some((fire) => Math.abs(fire.x - 0.5) < 0.15 && Math.abs(fire.y - 0.5) < 0.15));
  assert.ok(fires.every((fire) => fire.source === 'learned-sample' && fire.confidence === 'candidate'));
  assert.equal(obstacles.length, 0, 'fire samples must not be converted into hard obstacles');
});

test('learned green-door samples create candidate starts without becoming obstacle candidates', () => {
  const sample = createImageData(12, 12, [102, 126, 42, 255]);
  const scene = createImageData(64, 48, [190, 172, 142, 255]);
  paintRectangle(scene, 8, 16, 23, 31, [102, 126, 42, 255]);
  const samples = [{ category: 'green-door', features: extractVisualFeatures(sample) }];

  const doors = detectLearnedGreenDoorRegions(scene, samples, {
    tileSize: 8,
    matchThreshold: 0.05,
  });
  const obstacles = detectLearnedObstacleRegions(scene, samples, {
    tileSize: 8,
    matchThreshold: 0.05,
  });

  assert.ok(doors.length >= 1);
  assert.ok(doors.some((door) => door.x > 0.15 && door.x < 0.4 && door.y > 0.3 && door.y < 0.7));
  assert.ok(doors.every((door) => door.source === 'learned-sample' && door.confidence === 'candidate'));
  assert.equal(obstacles.length, 0, 'green-door samples must not be converted into hard obstacles');
});

test('the demo uses the two corrected north exits and treats white foam as hard obstacles', () => {
  const foam = demoScene.obstacles.filter((shape) => shape.kind === 'foam');
  assert.ok(foam.length >= 3, 'visible foam segments must be represented as hard obstacles');
  assert.deepEqual(demoScene.exits.map((exit) => exit.code), ['E1', 'E2']);
  assert.ok(demoScene.exits.every((exit) => exit.y < 0.2), 'both exits must be on the north/top side');

  const result = planEvacuation({
    width: 108,
    height: 81,
    obstacles: demoScene.obstacles,
    unknowns: demoScene.unknowns,
    starts: demoScene.starts,
    exits: demoScene.exits,
    fires: demoScene.fires,
    clearance: demoScene.clearance,
    minimumPassageWidth: demoScene.minimumPassageWidth,
    congestionWeight: 1.75,
  });

  const safeRoutes = result.routes.filter((route) => route.status === 'safe');
  assert.equal(safeRoutes.length, 6);
  const northExitIds = new Set(demoScene.exits.map((exit) => exit.id));
  assert.ok(safeRoutes.every((route) => northExitIds.has(route.exitId)));
  assert.equal(new Set(safeRoutes.map((route) => route.exitId)).size, 2, 'both north exits should be usable for evacuation');
  for (const route of result.routes) {
    for (const point of route.path) {
      for (const wall of foam) {
        const inside = point.x >= wall.x && point.x <= wall.x + wall.width
          && point.y >= wall.y && point.y <= wall.y + wall.height;
        assert.equal(inside, false, `${route.personId} crossed white foam ${wall.id}`);
      }
    }
  }
});

test('the demo closes the obstructed east alley instead of routing escapee 4 through it', () => {
  const rawGrid = buildPlanningGrid({
    width: 108,
    height: 81,
    obstacles: demoScene.obstacles,
    unknowns: demoScene.unknowns,
    fires: demoScene.fires,
    clearance: 0,
  });
  const result = planEvacuation({
    width: 108,
    height: 81,
    obstacles: demoScene.obstacles,
    unknowns: demoScene.unknowns,
    starts: demoScene.starts,
    exits: demoScene.exits,
    fires: demoScene.fires,
    clearance: demoScene.clearance,
    minimumPassageWidth: demoScene.minimumPassageWidth,
    congestionWeight: 1.75,
  });

  const escapee4 = result.routes.find((route) => route.personId === 'p4');
  const escapee6 = result.routes.find((route) => route.personId === 'p6');
  for (const x of [63, 64, 65]) {
    assert.equal(getCell(rawGrid, x, 29), CELL_FREE, `expected raw east-alley cell ${x},29 to be open`);
    assert.equal(getCell(result.grid, x, 29), CELL_BLOCKED, `minimum-width rule left east-alley cell ${x},29 open`);
  }
  assert.equal(escapee4.status, 'blocked');
  assert.deepEqual(escapee4.path, []);
  assert.equal(escapee4.exitId, null);
  assert.equal(escapee6.status, 'safe');
  assert.equal(escapee6.exitId, 'northeast');
  assert.equal(result.blockedCount, 1);
  assert.equal(result.allSafe, false);
  assert.deepEqual(
    result.routes.filter((route) => route.status === 'safe').map((route) => route.personId),
    ['p1', 'p2', 'p3', 'p5', 'p6', 'p7'],
  );
});

test('a normalized passage-width rule keeps the east alley closed at higher grid resolutions', () => {
  for (const [width, height] of [[108, 81], [216, 162], [320, 240]]) {
    const result = planEvacuation({
      width,
      height,
      obstacles: demoScene.obstacles,
      unknowns: demoScene.unknowns,
      starts: demoScene.starts,
      exits: demoScene.exits,
      fires: demoScene.fires,
      minimumPassageWidth: 0.046,
      congestionWeight: 1.75,
    });

    const escapee4 = result.routes.find((route) => route.personId === 'p4');
    const escapee6 = result.routes.find((route) => route.personId === 'p6');
    const start4 = demoScene.starts.find((start) => start.id === 'p4');
    const start4Cell = {
      x: Math.round(start4.x * (width - 1)),
      y: Math.round(start4.y * (height - 1)),
    };
    assert.equal(getCell(result.grid, start4Cell.x, start4Cell.y), CELL_FREE, `${width}×${height} swallowed escapee 4's start`);
    assert.ok(demoScene.exits.some((exit) => {
      const x = Math.round(exit.x * (width - 1));
      const y = Math.round(exit.y * (height - 1));
      return getCell(result.grid, x, y) === CELL_FREE;
    }), `${width}×${height} swallowed every exit`);
    assert.equal(escapee4.status, 'blocked', `${width}×${height} reopened the east alley`);
    assert.equal(escapee6.status, 'safe', `${width}×${height} blocked the valid E2 access`);
  }
});
