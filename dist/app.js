import { detectGreenRegions, filterRoutes, planEvacuation, validateSceneForPlanning } from './planner.mjs';
import { demoScene, ROUTE_COLORS } from './demo-scene.mjs';

const DEMO_IMAGE = './assets/demo-sandbox.jpg';

const dom = {
  canvas: document.querySelector('#mapCanvas'),
  frame: document.querySelector('#mapFrame'),
  mapTitle: document.querySelector('#mapTitle'),
  mapSubtitle: document.querySelector('#mapSubtitle'),
  mapStatus: document.querySelector('#mapStatus'),
  routeTabs: document.querySelector('#routeTabs'),
  routeList: document.querySelector('#routeList'),
  routeFocus: document.querySelector('#routeFocus'),
  summaryTitle: document.querySelector('#summaryTitle'),
  safetyRing: document.querySelector('#safetyRing'),
  confidenceMetric: document.querySelector('#confidenceMetric'),
  riskMetric: document.querySelector('#riskMetric'),
  clearanceMetric: document.querySelector('#clearanceMetric'),
  updatedMetric: document.querySelector('#updatedMetric'),
  sceneStateText: document.querySelector('#sceneStateText'),
  photoInput: document.querySelector('#photoInput'),
  toast: document.querySelector('#toast'),
  canvasHint: document.querySelector('#canvasHint'),
  calibrationTools: document.querySelector('#calibrationTools'),
  undoButton: document.querySelector('#undoButton'),
  detectGreenButton: document.querySelector('#detectGreenButton'),
  confirmMapButton: document.querySelector('#confirmMapButton'),
  obstacleReviewCheck: document.querySelector('#obstacleReviewCheck'),
  replanButton: document.querySelector('#replanButton'),
};

const ctx = dom.canvas.getContext('2d');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  scene: structuredClone(demoScene),
  image: null,
  imageUrl: DEMO_IMAGE,
  objectUrl: null,
  selectedRoute: 'all',
  activePanel: 'plan',
  tool: 'inspect',
  routes: [],
  result: null,
  drag: null,
  undoStack: [],
  phase: 0,
  lastPlanAt: new Date(),
};

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function getExit(exitId) {
  return state.scene.exits.find((exit) => exit.id === exitId);
}

function pathLength(path) {
  let length = 0;
  for (let index = 1; index < path.length; index += 1) {
    length += Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y);
  }
  return length;
}

function routeDistanceLabel(route) {
  if (route.status !== 'safe') return '无可用路线';
  return `${Math.round(pathLength(route.path) * 100)} 格`;
}

function pushHistory() {
  state.undoStack.push(structuredClone(state.scene));
  if (state.undoStack.length > 20) state.undoStack.shift();
}

function loadSceneImage(url, { onLoad, onError } = {}) {
  const image = new Image();
  image.onload = () => {
    if (state.imageUrl !== url) return;
    state.image = image;
    resizeCanvas();
    drawMap();
    onLoad?.(image);
  };
  image.onerror = () => {
    if (state.imageUrl !== url) return;
    state.image = null;
    showToast('图片加载失败，请改用 JPG 或 PNG 后重试');
    onError?.();
  };
  image.src = url;
}

function recomputePlan({ announce = false } = {}) {
  if (!state.scene.calibrated) {
    state.routes = [];
    state.result = null;
    render();
    if (announce) showToast('请先完成障碍复核并确认地图');
    return;
  }
  if (!state.scene.starts.length || !state.scene.exits.length) {
    state.routes = [];
    state.result = null;
    render();
    if (announce) showToast('请先标记绿门起点和至少一个安全出口');
    return;
  }
  state.result = planEvacuation({
    width: 108,
    height: 81,
    obstacles: state.scene.obstacles,
    unknowns: state.scene.unknowns,
    starts: state.scene.starts,
    exits: state.scene.exits,
    fires: state.scene.fires,
    clearance: state.scene.clearance,
    congestionWeight: 1.75,
  });
  state.routes = state.result.routes;
  state.lastPlanAt = new Date();
  if (state.selectedRoute !== 'all' && !state.scene.starts.some((start) => start.id === state.selectedRoute)) {
    state.selectedRoute = 'all';
  }
  render();
  if (announce) {
    const safeCount = state.routes.filter((route) => route.status === 'safe').length;
    showToast(`已更新路线：${safeCount} / ${state.routes.length} 人找到可用通道`);
  }
}

function render() {
  renderRouteTabs();
  renderSummary();
  renderRouteFocus();
  renderRouteList();
  renderMapMeta();
  drawMap();
}

function renderMapMeta() {
  const selected = state.scene.starts.find((start) => start.id === state.selectedRoute);
  dom.mapTitle.textContent = selected
    ? `${selected.label}·分线视角`
    : `${state.scene.name}·总逃生线路`;
  dom.mapSubtitle.textContent = `${state.scene.starts.length} 位逃生者 · ${state.scene.exits.length} 个候选安全口 · 已启用避险与拥堵惩罚`;
  dom.sceneStateText.textContent = `${state.scene.name} · ${state.scene.calibrated ? '已校准' : '待确认'}`;
  dom.obstacleReviewCheck.checked = state.scene.obstaclesReviewed === true;
  dom.mapStatus.classList.toggle('warning', !state.scene.calibrated || state.routes.some((route) => route.status !== 'safe'));
  dom.mapStatus.querySelector('strong').textContent = state.routes.length
    ? (state.routes.every((route) => route.status === 'safe') ? '路线可用' : '存在受阻路线')
    : '等待校准';
  dom.mapStatus.querySelector('span:last-child').textContent = state.scene.calibrated ? '人工校准图' : '识别候选图';
}

function renderRouteTabs() {
  const overview = `
    <button class="view-tab ${state.selectedRoute === 'all' ? 'active' : ''}" type="button" role="tab" aria-selected="${state.selectedRoute === 'all'}" data-route="all">
      <i style="--route-color: var(--lime)"></i>总线路
    </button>`;
  const people = state.scene.starts.map((start, index) => `
    <button class="view-tab ${state.selectedRoute === start.id ? 'active' : ''}" type="button" role="tab" aria-selected="${state.selectedRoute === start.id}" data-route="${start.id}" style="--route-color:${start.color}">
      <i></i>${index + 1}号
    </button>`).join('');
  dom.routeTabs.innerHTML = overview + people;
}

function renderSummary() {
  const safeCount = state.routes.filter((route) => route.status === 'safe').length;
  const total = state.scene.starts.length;
  dom.summaryTitle.textContent = total ? `${safeCount} / ${total} 可安全撤离` : '等待地图标定';
  dom.safetyRing.innerHTML = `<span>${safeCount}</span><small>/${total || 7}</small>`;
  dom.confidenceMetric.textContent = state.scene.calibrated ? '已人工校准' : '候选点待确认';
  dom.riskMetric.textContent = state.scene.fires.length ? '火源周边禁行' : '未标记火源';
  dom.clearanceMetric.textContent = `${state.scene.clearance} 格`;
  dom.updatedMetric.textContent = '刚刚';
}

function renderRouteFocus() {
  const selectedStart = state.scene.starts.find((start) => start.id === state.selectedRoute);
  const selectedRoute = state.routes.find((route) => route.personId === state.selectedRoute);
  if (!selectedStart || !selectedRoute) {
    const safeCount = state.routes.filter((route) => route.status === 'safe').length;
    const exitCount = new Set(state.routes.filter((route) => route.exitId).map((route) => route.exitId)).size;
    dom.routeFocus.style.setProperty('--focus-color', '#d7ff52');
    dom.routeFocus.innerHTML = `
      <div class="focus-top">
        <div class="focus-id"><div class="focus-number">∑</div><div><strong>总线路视角</strong><span>七人同时规划</span></div></div>
        <span class="status-badge ${safeCount === state.routes.length && state.routes.length ? 'safe' : 'blocked'}">${safeCount === state.routes.length && state.routes.length ? '可撤离' : '需校正'}</span>
      </div>
      <p>线路按通道占用情况逐一规划，相互重叠越多，后续逃生者越倾向选择其他安全口。</p>
      <div class="focus-stats"><div><span>已规划</span><strong>${safeCount} 人</strong></div><div><span>分流出口</span><strong>${exitCount} 个</strong></div><div><span>受阻</span><strong>${state.routes.length - safeCount} 人</strong></div></div>`;
    return;
  }

  const exit = getExit(selectedRoute.exitId);
  const routeNumber = state.scene.starts.indexOf(selectedStart) + 1;
  dom.routeFocus.style.setProperty('--focus-color', selectedStart.color);
  dom.routeFocus.innerHTML = `
    <div class="focus-top">
      <div class="focus-id"><div class="focus-number">${routeNumber}</div><div><strong>${selectedStart.label}</strong><span>${selectedStart.building || '绿门候选点'}</span></div></div>
      <span class="status-badge ${selectedRoute.status === 'safe' ? 'safe' : 'blocked'}">${selectedRoute.status === 'safe' ? '路线可用' : '当前受阻'}</span>
    </div>
    <p>${selectedRoute.status === 'safe' ? `从绿色门出发，避开火源禁行区和已识别障碍，前往${exit?.label || '最近安全口'}。` : '当前地图上没有符合安全余量的可用路径，请检查障碍或增加出口。'}</p>
    <div class="focus-stats"><div><span>目标</span><strong>${exit?.label || '--'}</strong></div><div><span>相对距离</span><strong>${routeDistanceLabel(selectedRoute)}</strong></div><div><span>起点置信</span><strong>${selectedStart.confidence === 'confirmed' ? '已确认' : '需复核'}</strong></div></div>`;
}

function renderRouteList() {
  dom.routeList.innerHTML = state.scene.starts.map((start, index) => {
    const route = state.routes.find((item) => item.personId === start.id);
    const exit = route ? getExit(route.exitId) : null;
    return `
      <button class="route-row ${state.selectedRoute === start.id ? 'active' : ''}" type="button" data-route="${start.id}">
        <span class="route-swatch" style="--route-color:${start.color}"></span>
        <span class="route-copy"><strong class="route-name">${index + 1}号 · ${start.building || '候选绿门'}</strong><span class="route-meta">${route?.status === 'safe' ? `→ ${exit?.label || '安全口'}` : '当前无可用路线'}</span></span>
        <span class="route-distance">${route ? routeDistanceLabel(route) : '--'}</span>
      </button>`;
  }).join('') || '<p class="route-meta">上传照片后，请标定 7 个绿色门起点。</p>';
}

function resizeCanvas() {
  const rect = dom.canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (dom.canvas.width !== width || dom.canvas.height !== height) {
    dom.canvas.width = width;
    dom.canvas.height = height;
  }
}

function setupDrawingContext() {
  const rect = dom.canvas.getBoundingClientRect();
  const scaleX = dom.canvas.width / rect.width;
  const scaleY = dom.canvas.height / rect.height;
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { width: rect.width, height: rect.height };
}

function drawImageLayer(width, height) {
  if (state.image) {
    ctx.drawImage(state.image, 0, 0, width, height);
  } else {
    ctx.fillStyle = '#24302d';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.fillStyle = 'rgba(4, 11, 10, 0.23)';
  ctx.fillRect(0, 0, width, height);
}

function drawShape(shape, width, height, style) {
  ctx.beginPath();
  if (shape.type === 'circle') {
    ctx.arc(shape.x * width, shape.y * height, shape.radius * Math.min(width, height), 0, Math.PI * 2);
  } else if (shape.type === 'polygon') {
    shape.points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x * width, point.y * height);
      else ctx.lineTo(point.x * width, point.y * height);
    });
    ctx.closePath();
  } else {
    ctx.rect(shape.x * width, shape.y * height, shape.width * width, shape.height * height);
  }
  if (style.fill) {
    ctx.fillStyle = style.fill;
    ctx.fill();
  }
  if (style.stroke) {
    ctx.lineWidth = style.lineWidth || 1;
    ctx.strokeStyle = style.stroke;
    ctx.setLineDash(style.dash || []);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawObstacles(width, height) {
  for (const obstacle of state.scene.obstacles) {
    if (obstacle.kind === 'boundary') continue;
    const building = obstacle.kind === 'building';
    const foam = obstacle.kind === 'foam';
    drawShape(obstacle, width, height, {
      fill: building ? 'rgba(12, 20, 19, 0.40)' : (foam ? 'rgba(238, 249, 255, 0.32)' : 'rgba(255, 101, 93, 0.25)'),
      stroke: building ? 'rgba(215, 255, 82, 0.34)' : (foam ? 'rgba(238, 249, 255, 0.92)' : 'rgba(255, 101, 93, 0.72)'),
      lineWidth: foam ? 2.2 : (building ? 1.2 : 1.4),
      dash: building ? [6, 5] : (foam ? [8, 4] : []),
    });
    if (building && obstacle.label) {
      const centerX = (obstacle.x + obstacle.width / 2) * width;
      const centerY = (obstacle.y + obstacle.height / 2) * height;
      ctx.fillStyle = 'rgba(240, 250, 244, 0.76)';
      ctx.font = '800 13px ui-sans-serif, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(obstacle.label, centerX, centerY);
    }
  }
  for (const unknown of state.scene.unknowns) {
    drawShape(unknown, width, height, {
      fill: 'rgba(255, 202, 100, 0.18)',
      stroke: 'rgba(255, 202, 100, 0.78)',
      lineWidth: 1.5,
      dash: [4, 4],
    });
  }
}

function drawFires(width, height) {
  for (const fire of state.scene.fires) {
    const x = fire.x * width;
    const y = fire.y * height;
    const radius = fire.radius * Math.min(width, height);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, 'rgba(255, 79, 65, 0.65)');
    gradient.addColorStop(0.28, 'rgba(255, 101, 93, 0.26)');
    gradient.addColorStop(1, 'rgba(255, 101, 93, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff655d';
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawRoutes(width, height) {
  const visibleRoutes = filterRoutes(state.routes, state.selectedRoute);
  for (const route of visibleRoutes) {
    if (route.status !== 'safe' || route.path.length < 2) continue;
    ctx.save();
    ctx.beginPath();
    route.path.forEach((point, index) => {
      const x = point.x * width;
      const y = point.y * height;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(5, 12, 11, 0.74)';
    ctx.lineWidth = state.selectedRoute === 'all' ? 7 : 10;
    ctx.stroke();
    ctx.strokeStyle = route.color || '#d7ff52';
    ctx.lineWidth = state.selectedRoute === 'all' ? 3.2 : 5;
    ctx.shadowColor = route.color || '#d7ff52';
    ctx.shadowBlur = state.selectedRoute === 'all' ? 6 : 12;
    ctx.stroke();
    ctx.restore();

    if (!reducedMotion && route.path.length > 3) {
      const phaseIndex = Math.floor((state.phase + state.scene.starts.indexOf(state.scene.starts.find((item) => item.id === route.personId)) * 7) % route.path.length);
      const marker = route.path[phaseIndex];
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(marker.x * width, marker.y * height, state.selectedRoute === 'all' ? 2.5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawMarkers(width, height) {
  state.scene.exits.forEach((exit, index) => {
    const x = exit.x * width;
    const y = exit.y * height;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#d7ff52';
    ctx.strokeStyle = 'rgba(6, 16, 13, 0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.rect(-8, -8, 16, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#101617';
    ctx.font = '900 9px ui-sans-serif, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(exit.code || `E${index + 1}`, 0, 0.5);
    ctx.restore();
  });

  state.scene.starts.forEach((start, index) => {
    const x = start.x * width;
    const y = start.y * height;
    const selected = state.selectedRoute === start.id;
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowColor = start.color;
    ctx.shadowBlur = selected ? 16 : 8;
    ctx.fillStyle = start.color;
    ctx.strokeStyle = '#0b1111';
    ctx.lineWidth = selected ? 4 : 3;
    ctx.beginPath();
    ctx.arc(0, 0, selected ? 11 : 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#0a100e';
    ctx.font = '900 10px ui-sans-serif, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(index + 1), 0, 0.5);
    if (start.confidence !== 'confirmed') {
      ctx.strokeStyle = '#ffca64';
      ctx.lineWidth = 2;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  });
}

function drawDragPreview(width, height) {
  if (!state.drag || state.tool !== 'obstacle') return;
  const preview = {
    type: 'rect',
    x: Math.min(state.drag.start.x, state.drag.current.x),
    y: Math.min(state.drag.start.y, state.drag.current.y),
    width: Math.abs(state.drag.current.x - state.drag.start.x),
    height: Math.abs(state.drag.current.y - state.drag.start.y),
  };
  drawShape(preview, width, height, {
    fill: 'rgba(255, 101, 93, 0.23)',
    stroke: '#ff655d',
    lineWidth: 2,
    dash: [5, 4],
  });
}

function drawMap() {
  if (!dom.canvas.clientWidth || !dom.canvas.clientHeight) return;
  resizeCanvas();
  const { width, height } = setupDrawingContext();
  drawImageLayer(width, height);
  drawObstacles(width, height);
  drawFires(width, height);
  drawRoutes(width, height);
  drawMarkers(width, height);
  drawDragPreview(width, height);
}

function canvasPoint(event) {
  const rect = dom.canvas.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width),
    y: clamp((event.clientY - rect.top) / rect.height),
  };
}

function setTool(tool) {
  state.tool = tool;
  dom.calibrationTools.querySelectorAll('[data-tool]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tool === tool);
  });
  const hints = {
    inspect: '点击绿门查看该逃生者路线',
    obstacle: '按住并拖动画出障碍区域',
    start: '点击照片标记一个绿色门起点',
    exit: '点击沙盘边缘标记安全出口',
    fire: '点击火源中心，再次点击可以移动',
    erase: '点击最近的标记或障碍进行删除',
  };
  dom.canvasHint.textContent = hints[tool];
  dom.canvasHint.hidden = tool === 'inspect' && state.activePanel !== 'calibrate';
  dom.canvas.style.cursor = tool === 'obstacle' ? 'crosshair' : (tool === 'inspect' ? 'default' : 'cell');
  dom.frame.classList.toggle('drawing', state.activePanel === 'calibrate' && tool !== 'inspect');
}

function switchPanel(panel) {
  state.activePanel = panel;
  document.querySelectorAll('.panel-tab').forEach((button) => {
    const active = button.dataset.panel === panel;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-panel-view]').forEach((view) => {
    const active = view.dataset.panelView === panel;
    view.hidden = !active;
    view.classList.toggle('active', active);
  });
  dom.canvasHint.hidden = panel !== 'calibrate';
  if (panel !== 'calibrate') setTool('inspect');
  else setTool(state.tool);
}

function chooseRoute(routeId) {
  state.selectedRoute = routeId;
  render();
  if (window.innerWidth <= 820) dom.routeFocus?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
}

function addStart(point, confidence = 'confirmed') {
  if (state.scene.starts.length >= 7) {
    showToast('已有 7 个起点；请先用“擦除”删除错误点位');
    return;
  }
  const index = state.scene.starts.length;
  state.scene.starts.push({
    id: `p${Date.now()}-${index}`,
    label: `${index + 1}号逃生者`,
    building: '绿门起点',
    x: point.x,
    y: point.y,
    color: ROUTE_COLORS[index],
    confidence,
  });
}

function addExit(point) {
  const index = state.scene.exits.length;
  state.scene.exits.push({ id: `exit-${Date.now()}`, label: `安全口 ${index + 1}`, x: point.x, y: point.y });
}

function eraseNearest(point) {
  const candidates = [
    ...state.scene.starts.map((item, index) => ({ type: 'start', index, distance: Math.hypot(item.x - point.x, item.y - point.y) })),
    ...state.scene.exits.map((item, index) => ({ type: 'exit', index, distance: Math.hypot(item.x - point.x, item.y - point.y) })),
    ...state.scene.fires.map((item, index) => ({ type: 'fire', index, distance: Math.hypot(item.x - point.x, item.y - point.y) })),
  ].sort((a, b) => a.distance - b.distance);
  if (candidates[0]?.distance < 0.055) {
    const collections = { start: state.scene.starts, exit: state.scene.exits, fire: state.scene.fires };
    collections[candidates[0].type].splice(candidates[0].index, 1);
    return candidates[0].type;
  }
  const obstacleIndex = state.scene.obstacles.findIndex((shape) => {
    if (shape.kind === 'building' || shape.kind === 'boundary') return false;
    if (shape.type === 'circle') return Math.hypot(shape.x - point.x, shape.y - point.y) <= shape.radius;
    return point.x >= shape.x && point.x <= shape.x + shape.width && point.y >= shape.y && point.y <= shape.y + shape.height;
  });
  if (obstacleIndex >= 0) {
    state.scene.obstacles.splice(obstacleIndex, 1);
    return 'obstacle';
  }
  return null;
}

function invalidateObstacleReview() {
  state.scene.obstaclesReviewed = false;
  dom.obstacleReviewCheck.checked = false;
}

function onCanvasPointerDown(event) {
  if (state.activePanel !== 'calibrate') return;
  const point = canvasPoint(event);
  if (state.tool === 'obstacle') {
    pushHistory();
    state.drag = { start: point, current: point };
    dom.canvas.setPointerCapture(event.pointerId);
    drawMap();
    return;
  }
  if (state.tool === 'inspect') {
    const nearest = state.scene.starts
      .map((start) => ({ start, distance: Math.hypot(start.x - point.x, start.y - point.y) }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest?.distance < 0.06) chooseRoute(nearest.start.id);
    return;
  }
  pushHistory();
  if (state.tool === 'start') addStart(point);
  if (state.tool === 'exit') addExit(point);
  if (state.tool === 'fire') {
    state.scene.fires = [{ id: 'fire-user', ...point, hardRadius: 0.04, radius: 0.16, intensity: 7 }];
  }
  if (state.tool === 'erase') {
    const erasedType = eraseNearest(point);
    if (!erasedType) {
      state.undoStack.pop();
      showToast('没有找到可删除的标记');
    } else if (erasedType === 'obstacle') {
      invalidateObstacleReview();
    }
  }
  state.scene.calibrated = false;
  recomputePlan();
}

function onCanvasPointerMove(event) {
  if (!state.drag) return;
  state.drag.current = canvasPoint(event);
  drawMap();
}

function onCanvasPointerUp(event) {
  if (!state.drag) return;
  const end = canvasPoint(event);
  const start = state.drag.start;
  const obstacle = {
    id: `obstacle-${Date.now()}`,
    kind: 'object',
    type: 'rect',
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
  state.drag = null;
  if (obstacle.width < 0.012 || obstacle.height < 0.012) {
    state.undoStack.pop();
    showToast('障碍区域太小，请拖动画出一个矩形');
  } else {
    state.scene.obstacles.push(obstacle);
    invalidateObstacleReview();
    state.scene.calibrated = false;
    recomputePlan();
  }
  try { dom.canvas.releasePointerCapture(event.pointerId); } catch {}
  drawMap();
}

function findGreenCandidates() {
  if (!state.image) return;
  const maximumWidth = 240;
  const scale = Math.min(1, maximumWidth / state.image.naturalWidth);
  const width = Math.max(40, Math.round(state.image.naturalWidth * scale));
  const height = Math.max(30, Math.round(state.image.naturalHeight * scale));
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const offscreenContext = offscreen.getContext('2d', { willReadFrequently: true });
  offscreenContext.drawImage(state.image, 0, 0, width, height);
  const imageData = offscreenContext.getImageData(0, 0, width, height);
  const candidates = detectGreenRegions(imageData, { minPixels: Math.max(7, Math.round(width * height / 9000)) })
    .filter((region) => region.width < 0.24 && region.height < 0.24)
    .slice(0, 7);
  state.scene.starts = [];
  candidates.forEach((candidate) => addStart(candidate, 'candidate'));
  state.selectedRoute = 'all';
  state.scene.calibrated = false;
  recomputePlan();
  showToast(candidates.length
    ? `找到 ${candidates.length} 个绿色候选区，请手动核对是否为门`
    : '未找到稳定的绿色区域，请用“绿门”工具手动标记');
}

function handlePhotoUpload(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('请选择 JPG、PNG 或 HEIC 图片');
    return;
  }
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  state.imageUrl = state.objectUrl;
  state.undoStack = [];
  state.scene = {
    name: file.name.replace(/\.[^.]+$/, '') || '新环境',
    calibrated: false,
    obstaclesReviewed: false,
    clearance: 2,
    obstacles: [],
    unknowns: [],
    starts: [],
    exits: [],
    fires: [],
  };
  state.selectedRoute = 'all';
  state.routes = [];
  state.image = null;
  switchPanel('calibrate');
  loadSceneImage(state.imageUrl, { onLoad: findGreenCandidates });
}

function confirmMap() {
  state.scene.obstaclesReviewed = dom.obstacleReviewCheck.checked;
  const validation = validateSceneForPlanning(state.scene);
  if (!validation.valid) {
    showToast(validation.message);
    return;
  }
  pushHistory();
  state.scene.calibrated = true;
  state.scene.starts.forEach((start) => { start.confidence = 'confirmed'; });
  recomputePlan({ announce: true });
  switchPanel('plan');
}

let toastTimer;
function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => dom.toast.classList.remove('show'), 3200);
}

document.querySelectorAll('[data-upload-trigger]').forEach((button) => {
  button.addEventListener('click', () => dom.photoInput.click());
});

document.querySelectorAll('.panel-tab').forEach((button) => {
  button.addEventListener('click', () => switchPanel(button.dataset.panel));
});

dom.routeTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-route]');
  if (button) chooseRoute(button.dataset.route);
});

dom.routeList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-route]');
  if (button) chooseRoute(button.dataset.route);
});

dom.calibrationTools.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tool]');
  if (button) setTool(button.dataset.tool);
});

dom.photoInput.addEventListener('change', (event) => {
  handlePhotoUpload(event.target.files?.[0]);
  event.target.value = '';
});

dom.undoButton.addEventListener('click', () => {
  const previous = state.undoStack.pop();
  if (!previous) {
    showToast('没有可撤销的校准操作');
    return;
  }
  state.scene = previous;
  recomputePlan();
});

dom.detectGreenButton.addEventListener('click', () => {
  pushHistory();
  findGreenCandidates();
});
dom.obstacleReviewCheck.addEventListener('change', () => {
  state.scene.obstaclesReviewed = dom.obstacleReviewCheck.checked;
  state.scene.calibrated = false;
  recomputePlan();
});
dom.confirmMapButton.addEventListener('click', confirmMap);
dom.replanButton.addEventListener('click', () => recomputePlan({ announce: true }));
dom.canvas.addEventListener('pointerdown', onCanvasPointerDown);
dom.canvas.addEventListener('pointermove', onCanvasPointerMove);
dom.canvas.addEventListener('pointerup', onCanvasPointerUp);
dom.canvas.addEventListener('pointercancel', onCanvasPointerUp);
window.addEventListener('resize', () => {
  resizeCanvas();
  drawMap();
});

if (window.ResizeObserver) {
  new ResizeObserver(() => {
    resizeCanvas();
    drawMap();
  }).observe(dom.frame);
}

function animate() {
  state.phase = (state.phase + 0.14) % 10000;
  drawMap();
  window.requestAnimationFrame(animate);
}

loadSceneImage(DEMO_IMAGE);
recomputePlan();
switchPanel('plan');
if (!reducedMotion) window.requestAnimationFrame(animate);
