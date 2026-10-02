import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CELL_BLOCKED,
  createGrid,
  setCell,
  getCell,
  inflateGrid,
  findPath,
  planEvacuation,
  filterRoutes,
  detectGreenRegions,
  validateSceneForPlanning,
} from '../dist/planner.mjs';
import { demoScene } from '../dist/demo-scene.mjs';

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

test('seven escapees receive routes that avoid a hard fire exclusion zone', () => {
  const starts = Array.from({ length: 7 }, (_, index) => ({
    id: `p${index + 1}`,
    label: `逃生者${index + 1}`,
    x: 0.08,
    y: 0.1 + index * 0.12,
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

  assert.equal(result.routes.length, 7);
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

test('scene validation requires seven starts, an exit, and explicit obstacle review', () => {
  const validBase = {
    starts: Array.from({ length: 7 }, (_, index) => ({ id: `p${index}` })),
    exits: [{ id: 'north' }],
    obstaclesReviewed: true,
  };

  assert.equal(validateSceneForPlanning(validBase).valid, true);
  assert.equal(validateSceneForPlanning({ ...validBase, starts: validBase.starts.slice(0, 6) }).code, 'start_count');
  assert.equal(validateSceneForPlanning({ ...validBase, exits: [] }).code, 'missing_exit');
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
    congestionWeight: 1.75,
  });

  assert.equal(result.routes.filter((route) => route.status === 'safe').length, 7);
  const northExitIds = new Set(demoScene.exits.map((exit) => exit.id));
  assert.ok(result.routes.every((route) => northExitIds.has(route.exitId)));
  assert.equal(new Set(result.routes.map((route) => route.exitId)).size, 2, 'both north exits should be usable for evacuation');
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
