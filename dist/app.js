import {
  detectGreenRegions,
  detectLearnedFireRegions,
  detectLearnedGreenDoorRegions,
  detectLearnedObstacleRegions,
  detectObstacleRegions,
  extractVisualFeatures,
  filterRoutes,
  minimumPassageCellsForWidth,
  planEvacuation,
  validateSceneForPlanning,
} from './planner.mjs?v=20261002093029';
import { demoScene, ROUTE_COLORS } from './demo-scene.mjs?v=20261002093029';

const DEMO_IMAGE = './assets/demo-sandbox.jpg';
const TRAINING_STORAGE_KEY = 'xiangxing-training-samples-v1';
const SCENE_HISTORY_STORAGE_KEY = 'xiangxing-scene-history-v1';
const ACTIVE_SCENE_STORAGE_KEY = 'xiangxing-active-scene-v1';
const storageLoadWarnings = [];
let sceneLoadRequestId = 0;

function safeText(value, fallback = '', maximumLength = 80) {
  return typeof value === 'string' ? value.slice(0, maximumLength) : fallback;
}

function safeIdentifier(value, fallback) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : fallback;
}

function uniqueIdentifier(value, fallback, used) {
  const base = safeIdentifier(value, fallback);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 72)}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function safeDataImageUrl(value) {
  return typeof value === 'string'
    && value.length <= 2_500_000
    && /^data:image\/(?:jpeg|png|webp);base64,[a-zA-Z0-9+/=]+$/.test(value);
}

function normalizedNumber(value, fallback = 0) {
  return Number.isFinite(value) ? clamp(value) : fallback;
}

function sanitizeShape(shape, index, prefix = 'shape') {
  if (!shape || typeof shape !== 'object') return null;
  const type = ['rect', 'circle', 'polygon'].includes(shape.type) ? shape.type : 'rect';
  const sanitized = {
    id: safeIdentifier(shape.id, `${prefix}-${index}`),
    kind: ['building', 'object', 'foam', 'boundary'].includes(shape.kind) ? shape.kind : 'object',
    type,
    x: normalizedNumber(shape.x),
    y: normalizedNumber(shape.y),
    source: ['manual', 'auto-image', 'learned-sample'].includes(shape.source) ? shape.source : undefined,
    confidence: ['candidate', 'confirmed', 'inferred'].includes(shape.confidence) ? shape.confidence : undefined,
  };
  if (shape.label) sanitized.label = safeText(shape.label, '', 40);
  if (type === 'circle') sanitized.radius = normalizedNumber(shape.radius, 0.01);
  if (type === 'rect') {
    sanitized.width = normalizedNumber(shape.width, 0.01);
    sanitized.height = normalizedNumber(shape.height, 0.01);
  }
  if (type === 'polygon') {
    if (!Array.isArray(shape.points) || shape.points.length < 3) return null;
    sanitized.points = shape.points.slice(0, 80).map((point) => ({
      x: normalizedNumber(point?.x),
      y: normalizedNumber(point?.y),
    }));
  }
  return sanitized;
}

function sanitizePlanningBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const x = normalizedNumber(bounds.x);
  const y = normalizedNumber(bounds.y);
  const width = Math.min(1 - x, normalizedNumber(bounds.width));
  const height = Math.min(1 - y, normalizedNumber(bounds.height));
  if (width < 0.12 || height < 0.12) return null;
  return { x, y, width, height, source: bounds.source === 'manual' ? 'manual' : 'auto-image' };
}

function sanitizeStoredScene(scene, recordId) {
  if (!scene || typeof scene !== 'object') return null;
  if (!Array.isArray(scene.starts) || !Array.isArray(scene.exits)
    || !Array.isArray(scene.obstacles) || !Array.isArray(scene.unknowns) || !Array.isArray(scene.fires)) return null;
  const startIds = new Set();
  const exitIds = new Set();
  const starts = scene.starts.slice(0, 80).map((start, index) => ({
    id: uniqueIdentifier(start?.id, `p-${index}`, startIds),
    label: safeText(start?.label, `${index + 1}号逃生者`, 50),
    building: safeText(start?.building, '绿门起点', 50),
    x: normalizedNumber(start?.x),
    y: normalizedNumber(start?.y),
    color: typeof start?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(start.color)
      ? start.color
      : ROUTE_COLORS[index % ROUTE_COLORS.length],
    confidence: ['candidate', 'confirmed', 'inferred'].includes(start?.confidence) ? start.confidence : 'candidate',
    source: ['manual', 'auto-image', 'learned-sample'].includes(start?.source) ? start.source : undefined,
  }));
  const exits = scene.exits.slice(0, 40).map((exit, index) => ({
    id: uniqueIdentifier(exit?.id, `exit-${index}`, exitIds),
    code: safeText(exit?.code, `E${index + 1}`, 12),
    label: safeText(exit?.label, `安全口 ${index + 1}`, 50),
    x: normalizedNumber(exit?.x),
    y: normalizedNumber(exit?.y),
  }));
  const fires = scene.fires.slice(0, 20).map((fire, index) => ({
    id: safeIdentifier(fire?.id, `fire-${index}`),
    x: normalizedNumber(fire?.x),
    y: normalizedNumber(fire?.y),
    hardRadius: normalizedNumber(fire?.hardRadius, 0.02),
    radius: normalizedNumber(fire?.radius, 0.12),
    intensity: Number.isFinite(fire?.intensity) ? Math.max(0, Math.min(20, fire.intensity)) : 7,
    source: ['manual', 'auto-image', 'learned-sample'].includes(fire?.source) ? fire.source : undefined,
    confidence: ['candidate', 'confirmed', 'inferred'].includes(fire?.confidence) ? fire.confidence : 'candidate',
  }));
  return {
    name: safeText(scene.name, '未命名场景', 40),
    historyId: recordId,
    source: scene.source === 'photo' ? 'photo' : 'demo',
    calibrated: scene.calibrated === true,
    obstaclesReviewed: scene.obstaclesReviewed === true,
    obstacleScanCompleted: scene.obstacleScanCompleted === true,
    minimumPassageWidth: Number.isFinite(scene.minimumPassageWidth)
      ? Math.max(0.01, Math.min(0.2, scene.minimumPassageWidth))
      : 0.046,
    planningBounds: sanitizePlanningBounds(scene.planningBounds) || undefined,
    obstacles: scene.obstacles.map((shape, index) => sanitizeShape(shape, index, 'obstacle')).filter(Boolean),
    unknowns: scene.unknowns.map((shape, index) => sanitizeShape(shape, index, 'unknown')).filter(Boolean),
    starts,
    exits,
    fires,
    recognition: scene.recognition && typeof scene.recognition === 'object' ? {
      greenCandidates: Math.max(0, Math.floor(scene.recognition.greenCandidates || 0)),
      obstacleCandidates: Math.max(0, Math.floor(scene.recognition.obstacleCandidates || 0)),
      learnedCandidates: Math.max(0, Math.floor(scene.recognition.learnedCandidates || 0)),
      learnedGreenCandidates: Math.max(0, Math.floor(scene.recognition.learnedGreenCandidates || 0)),
      fireCandidates: Math.max(0, Math.floor(scene.recognition.fireCandidates || 0)),
      analyzedAt: safeText(scene.recognition.analyzedAt, '', 40),
    } : undefined,
  };
}

function readStoredArray(key, validator) {
  let raw;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    storageLoadWarnings.push(`${key}: 当前浏览器禁止本地存储`);
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new TypeError('stored value is not an array');
    const valid = parsed.map(validator).filter(Boolean);
    if (valid.length !== parsed.length) {
      storageLoadWarnings.push(`${key}: 已跳过损坏记录`);
      try { window.localStorage.setItem(`${key}-corrupt-backup`, raw); } catch {}
    }
    return valid;
  } catch {
    storageLoadWarnings.push(`${key}: 数据损坏，已保留备份`);
    try { window.localStorage.setItem(`${key}-corrupt-backup`, raw); } catch {}
    return [];
  }
}

const initialTrainingSamples = loadTrainingSamples();
const initialSceneHistory = loadSceneHistory();
let activeSceneId = '';
try {
  activeSceneId = safeIdentifier(window.localStorage.getItem(ACTIVE_SCENE_STORAGE_KEY), '');
} catch {}
const initialSceneRecord = initialSceneHistory.find((record) => record.id === activeSceneId) || null;

function loadTrainingSamples() {
  const featureKeys = ['red', 'green', 'blue', 'saturation', 'luminanceStd', 'edgeDensity'];
  const sampleIds = new Set();
  return readStoredArray(TRAINING_STORAGE_KEY, (sample, index) => {
    if (!sample || !safeDataImageUrl(sample.thumbnail) || !sample.features
      || !featureKeys.every((key) => Number.isFinite(sample.features[key]))) return null;
    return {
      id: uniqueIdentifier(sample.id, `sample-${index}`, sampleIds),
      name: safeText(sample.name, `sample-${index + 1}`, 80),
      category: ['building', 'obstacle', 'fire', 'green-door', 'foam'].includes(sample.category) ? sample.category : 'obstacle',
      thumbnail: sample.thumbnail,
      features: Object.fromEntries(featureKeys.map((key) => [key, Math.max(0, Math.min(2, sample.features[key]))])),
      createdAt: safeText(sample.createdAt, '', 40),
    };
  });
}

function loadSceneHistory() {
  const sceneIds = new Set();
  return readStoredArray(SCENE_HISTORY_STORAGE_KEY, (record, index) => {
    if (!record || !safeDataImageUrl(record.imageDataUrl)) return null;
    const id = uniqueIdentifier(record.id, `scene-${index}`, sceneIds);
    const scene = sanitizeStoredScene(record.scene, id);
    if (!scene) return null;
    const name = safeText(record.name, scene.name, 40);
    scene.name = name;
    return {
      id,
      schemaVersion: 1,
      name,
      savedAt: safeText(record.savedAt, '', 40),
      imageDataUrl: record.imageDataUrl,
      scene,
    };
  });
}

const dom = {
  canvas: document.querySelector('#mapCanvas'),
  frame: document.querySelector('#mapFrame'),
  mapTitle: document.querySelector('#mapTitle'),
  mapSubtitle: document.querySelector('#mapSubtitle'),
  mapStatus: document.querySelector('#mapStatus'),
  routeTabs: document.querySelector('#routeTabs'),
  routeList: document.querySelector('#routeList'),
  evacuationRanking: document.querySelector('#evacuationRanking'),
  rankingStatus: document.querySelector('#rankingStatus'),
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
  recognitionSummary: document.querySelector('#recognitionSummary'),
  confirmMapButton: document.querySelector('#confirmMapButton'),
  obstacleReviewCheck: document.querySelector('#obstacleReviewCheck'),
  replanButton: document.querySelector('#replanButton'),
  trainingInput: document.querySelector('#trainingInput'),
  trainingCategory: document.querySelector('#trainingCategory'),
  trainingUploadButton: document.querySelector('#trainingUploadButton'),
  trainingStatus: document.querySelector('#trainingStatus'),
  trainingGrid: document.querySelector('#trainingGrid'),
  exportTrainingButton: document.querySelector('#exportTrainingButton'),
  sceneNameInput: document.querySelector('#sceneNameInput'),
  saveSceneButton: document.querySelector('#saveSceneButton'),
  sceneHistoryStatus: document.querySelector('#sceneHistoryStatus'),
  sceneHistoryList: document.querySelector('#sceneHistoryList'),
};

const ctx = dom.canvas.getContext('2d');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  scene: structuredClone(initialSceneRecord?.scene || demoScene),
  image: null,
  imageUrl: initialSceneRecord?.imageDataUrl || DEMO_IMAGE,
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
  trainingSamples: initialTrainingSamples,
  sceneHistory: initialSceneHistory,
};
let currentSceneSavedAt = initialSceneRecord?.savedAt || '';

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

function simulatedEvacuationSeconds(route) {
  if (!route || route.status !== 'safe') return null;
  return Math.max(1, Math.ceil((pathLength(route.path) * 100) / 1.35));
}

function planningDimensions() {
  const width = 108;
  const aspectRatio = state.image?.naturalWidth && state.image?.naturalHeight
    ? state.image.naturalWidth / state.image.naturalHeight
    : 4 / 3;
  return {
    width,
    height: Math.max(48, Math.round((width - 1) / aspectRatio) + 1),
  };
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
  const validation = validateSceneForPlanning(state.scene);
  const awaitingConfirmation = !state.scene.calibrated;
  if (awaitingConfirmation || !validation.valid) {
    if (!validation.valid) state.scene.calibrated = false;
    state.routes = [];
    state.result = null;
    render();
    if (announce) showToast(!validation.valid ? validation.message : '请先完成障碍复核并确认地图');
    return;
  }
  const dimensions = planningDimensions();
  state.result = planEvacuation({
    ...dimensions,
    obstacles: state.scene.obstacles,
    unknowns: state.scene.unknowns,
    starts: state.scene.starts,
    exits: state.scene.exits,
    fires: state.scene.fires,
    planningBounds: state.scene.planningBounds,
    clearance: state.scene.clearance,
    minimumPassageWidth: state.scene.minimumPassageWidth,
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
  renderEvacuationRanking();
  renderMapMeta();
  renderTrainingSamples();
  renderSceneHistory();
  drawMap();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeRouteColor(value, index = 0) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : ROUTE_COLORS[index % ROUTE_COLORS.length];
}

function renderTrainingSamples() {
  if (!dom.trainingGrid || !dom.trainingStatus) return;
  const categoryLabels = {
    building: '建筑',
    obstacle: '杂物 / 车辆',
    fire: '火源',
    'green-door': '逃生者起点绿门',
    foam: '白色泡沫（障碍）',
  };
  dom.trainingStatus.textContent = `本机样本 ${state.trainingSamples.length} 张 · 识别时自动加载`;
  dom.trainingGrid.innerHTML = state.trainingSamples.map((sample) => `
    <article class="training-sample">
      <img src="${sample.thumbnail}" alt="" />
      <div><strong>${escapeHtml(sample.name)}</strong><span>${categoryLabels[sample.category] || '障碍'}</span></div>
      <button type="button" data-delete-sample="${escapeHtml(sample.id)}" aria-label="删除 ${escapeHtml(sample.name)}">×</button>
    </article>`).join('') || '<p class="route-meta">还没有样本。请上传主体占满画面的紧裁切图片。</p>';
}

function renderSceneHistory() {
  if (!dom.sceneHistoryList || !dom.sceneHistoryStatus) return;
  const storageWarning = storageLoadWarnings.length ? ' · 已跳过并备份损坏记录' : '';
  dom.sceneHistoryStatus.textContent = (state.sceneHistory.length
    ? `已保存 ${state.sceneHistory.length} 个场景 · 最多 10 个`
    : '当前浏览器暂无记录') + storageWarning;
  dom.sceneHistoryList.innerHTML = state.sceneHistory.map((record) => {
    const savedAt = new Date(record.savedAt);
    const dateLabel = Number.isNaN(savedAt.getTime()) ? '' : savedAt.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    return `
      <article class="scene-history-card ${state.scene.historyId === record.id ? 'active' : ''}">
        <img src="${record.imageDataUrl}" alt="" />
        <div class="scene-history-copy">
          <strong>${escapeHtml(record.name)}</strong>
          <span>${record.scene.starts?.length || 0} 个起点 · ${record.scene.exits?.length || 0} 个出口 · ${dateLabel}</span>
        </div>
        <div class="scene-history-actions">
          <button type="button" data-load-scene="${escapeHtml(record.id)}">打开</button>
          <button type="button" data-rename-scene="${escapeHtml(record.id)}">重命名</button>
          <button type="button" data-delete-scene="${escapeHtml(record.id)}">删除</button>
        </div>
      </article>`;
  }).join('') || '<p class="route-meta">保存当前场景后，会在这里显示可切换的历史记录。</p>';
}

function renderMapMeta() {
  const selected = state.scene.starts.find((start) => start.id === state.selectedRoute);
  dom.mapTitle.textContent = selected
    ? `${selected.label}·分线视角`
    : `${state.scene.name}·总逃生线路`;
  dom.mapSubtitle.textContent = `${state.scene.starts.length} 位逃生者 · ${state.scene.exits.length} 个候选安全口 · 已启用避险与拥堵惩罚`;
  dom.sceneStateText.textContent = `${state.scene.name} · ${state.scene.calibrated ? '已校准' : '待确认'}`;
  const recognition = state.scene.recognition || {};
  if (dom.recognitionSummary) {
    const greenCount = recognition.greenCandidates ?? state.scene.starts.filter((start) => start.source === 'auto-image').length;
    const obstacleCount = recognition.obstacleCandidates ?? state.scene.obstacles.filter((shape) => shape.source === 'auto-image').length;
    const fireCount = recognition.fireCandidates ?? state.scene.fires.filter((fire) => fire.source === 'learned-sample').length;
    dom.recognitionSummary.textContent = state.scene.source === 'photo'
      ? `绿门候选 ${greenCount} 个 · 火源候选 ${fireCount} 个 · 障碍候选 ${obstacleCount} 个（需复核）`
      : '演示地图已人工标定';
  }
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
    <button class="view-tab ${state.selectedRoute === start.id ? 'active' : ''}" type="button" role="tab" aria-selected="${state.selectedRoute === start.id}" data-route="${escapeHtml(start.id)}" style="--route-color:${safeRouteColor(start.color, index)}">
      <i></i>${index + 1}号
    </button>`).join('');
  dom.routeTabs.innerHTML = overview + people;
}

function renderSummary() {
  const safeCount = state.routes.filter((route) => route.status === 'safe').length;
  const total = state.scene.starts.length;
  dom.summaryTitle.textContent = total ? `${safeCount} / ${total} 可安全撤离` : '等待地图标定';
  dom.safetyRing.innerHTML = `<span>${safeCount}</span><small>/${total || '—'}</small>`;
  dom.confidenceMetric.textContent = state.scene.calibrated ? '已人工校准' : '候选点待确认';
  dom.riskMetric.textContent = state.scene.fires.length ? '火源周边禁行' : '未标记火源';
  const dimensions = planningDimensions();
  const minimumCells = state.result?.minimumPassageCells
    || (Number.isFinite(state.scene.minimumPassageWidth)
      ? minimumPassageCellsForWidth(dimensions.width, state.scene.minimumPassageWidth)
      : (Number.isFinite(state.scene.clearance) ? state.scene.clearance * 2 + 1 : 3));
  dom.clearanceMetric.textContent = `${minimumCells} 格`;
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
        <div class="focus-id"><div class="focus-number">∑</div><div><strong>总线路视角</strong><span>${state.scene.starts.length} 个起点协同规划</span></div></div>
        <span class="status-badge ${safeCount === state.routes.length && state.routes.length ? 'safe' : 'blocked'}">${safeCount === state.routes.length && state.routes.length ? '可撤离' : '需校正'}</span>
      </div>
      <p>线路按通道占用情况逐一规划，相互重叠越多，后续逃生者越倾向选择其他安全口。</p>
      <div class="focus-stats"><div><span>已规划</span><strong>${safeCount} 人</strong></div><div><span>分流出口</span><strong>${exitCount} 个</strong></div><div><span>受阻</span><strong>${state.routes.length - safeCount} 人</strong></div></div>`;
    return;
  }

  const exit = getExit(selectedRoute.exitId);
  const routeNumber = state.scene.starts.indexOf(selectedStart) + 1;
  dom.routeFocus.style.setProperty('--focus-color', safeRouteColor(selectedStart.color, routeNumber - 1));
  dom.routeFocus.innerHTML = `
    <div class="focus-top">
      <div class="focus-id"><div class="focus-number">${routeNumber}</div><div><strong>${escapeHtml(selectedStart.label)}</strong><span>${escapeHtml(selectedStart.building || '绿门候选点')}</span></div></div>
      <span class="status-badge ${selectedRoute.status === 'safe' ? 'safe' : 'blocked'}">${selectedRoute.status === 'safe' ? '路线可用' : '当前受阻'}</span>
    </div>
    <p>${selectedRoute.status === 'safe' ? `从绿色门出发，避开火源禁行区和已识别障碍，前往${escapeHtml(exit?.label || '最近安全口')}。` : '当前地图上没有符合安全余量的可用路径，请检查障碍或增加出口。'}</p>
    <div class="focus-stats"><div><span>目标</span><strong>${escapeHtml(exit?.label || '--')}</strong></div><div><span>相对距离</span><strong>${routeDistanceLabel(selectedRoute)}</strong></div><div><span>起点置信</span><strong>${selectedStart.confidence === 'confirmed' ? '已确认' : '需复核'}</strong></div></div>`;
}

function renderRouteList() {
  dom.routeList.innerHTML = state.scene.starts.map((start, index) => {
    const route = state.routes.find((item) => item.personId === start.id);
    const exit = route ? getExit(route.exitId) : null;
    return `
      <button class="route-row ${state.selectedRoute === start.id ? 'active' : ''}" type="button" data-route="${escapeHtml(start.id)}">
        <span class="route-swatch" style="--route-color:${safeRouteColor(start.color, index)}"></span>
        <span class="route-copy"><strong class="route-name">${index + 1}号 · ${escapeHtml(start.building || '候选绿门')}</strong><span class="route-meta">${route?.status === 'safe' ? `→ ${escapeHtml(exit?.label || '安全口')}` : '当前无可用路线'}</span></span>
        <span class="route-distance">${route ? routeDistanceLabel(route) : '--'}</span>
      </button>`;
  }).join('') || '<p class="route-meta">上传照片后，请复核自动识别的绿门，也可手动补标。</p>';
}

function renderEvacuationRanking() {
  if (!dom.evacuationRanking || !dom.rankingStatus) return;
  const entries = state.scene.starts.map((start, index) => {
    const route = state.routes.find((candidate) => candidate.personId === start.id);
    return { start, route, index, seconds: simulatedEvacuationSeconds(route) };
  }).sort((first, second) => {
    if (first.seconds === null && second.seconds === null) return first.index - second.index;
    if (first.seconds === null) return 1;
    if (second.seconds === null) return -1;
    return first.seconds - second.seconds || first.index - second.index;
  });
  const safeCount = entries.filter((entry) => entry.seconds !== null).length;
  dom.rankingStatus.textContent = state.routes.length
    ? (safeCount === entries.length ? '全员撤离' : `${safeCount}/${entries.length} 已撤离`)
    : '等待规划';
  let rank = 0;
  dom.evacuationRanking.innerHTML = entries.map((entry) => {
    if (entry.seconds !== null) rank += 1;
    const routeColor = safeRouteColor(entry.start.color, entry.index);
    return `
      <div class="ranking-row ${entry.seconds === null ? 'blocked' : ''}">
        <span class="ranking-place">${entry.seconds === null ? '—' : `#${rank}`}</span>
        <i style="--route-color:${routeColor}"></i>
        <span class="ranking-person"><strong>${escapeHtml(entry.start.label)}</strong><small>${entry.route?.status === 'safe' ? routeDistanceLabel(entry.route) : '未找到安全通道'}</small></span>
        <strong class="ranking-time">${entry.seconds === null ? '未撤离' : `${entry.seconds} 秒`}</strong>
      </div>`;
  }).join('') || '<p class="route-meta">完成绿门、出口、火源与障碍校准后，这里会按模拟用时排序。</p>';
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

function drawPlanningBounds(width, height) {
  const bounds = state.scene.planningBounds;
  if (!bounds) return;
  const left = bounds.x * width;
  const top = bounds.y * height;
  const boxWidth = bounds.width * width;
  const boxHeight = bounds.height * height;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.rect(left, top, boxWidth, boxHeight);
  ctx.fillStyle = 'rgba(4, 11, 10, 0.42)';
  ctx.fill('evenodd');
  ctx.strokeStyle = bounds.source === 'manual' ? '#72e9ff' : 'rgba(114, 233, 255, 0.82)';
  ctx.lineWidth = bounds.source === 'manual' ? 2.2 : 1.4;
  ctx.setLineDash([7, 5]);
  ctx.strokeRect(left, top, boxWidth, boxHeight);
  ctx.setLineDash([]);
  ctx.fillStyle = '#dffaff';
  ctx.font = '800 11px ui-sans-serif, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(bounds.source === 'manual' ? '规划区 · 已校正' : '规划区 · 自动估算', left + 8, Math.max(14, top - 5));
  ctx.restore();
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
  if (!state.drag || !['obstacle', 'bounds'].includes(state.tool)) return;
  const preview = {
    type: 'rect',
    x: Math.min(state.drag.start.x, state.drag.current.x),
    y: Math.min(state.drag.start.y, state.drag.current.y),
    width: Math.abs(state.drag.current.x - state.drag.start.x),
    height: Math.abs(state.drag.current.y - state.drag.start.y),
  };
  drawShape(preview, width, height, {
    fill: state.tool === 'bounds' ? 'rgba(114, 233, 255, 0.12)' : 'rgba(255, 101, 93, 0.23)',
    stroke: state.tool === 'bounds' ? '#72e9ff' : '#ff655d',
    lineWidth: 2,
    dash: [5, 4],
  });
}

function drawMap() {
  if (!dom.canvas.clientWidth || !dom.canvas.clientHeight) return;
  resizeCanvas();
  const { width, height } = setupDrawingContext();
  drawImageLayer(width, height);
  drawPlanningBounds(width, height);
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
    bounds: '拖动框选有效沙盘规划区，框外全部禁行',
    start: '点击照片标记一个绿色门起点',
    exit: '点击沙盘边缘标记安全出口',
    fire: '点击火源中心，再次点击可以移动',
    erase: '点击最近的标记或障碍进行删除',
  };
  dom.canvasHint.textContent = hints[tool];
  dom.canvasHint.hidden = tool === 'inspect' && state.activePanel !== 'calibrate';
  dom.canvas.style.cursor = ['obstacle', 'bounds'].includes(tool) ? 'crosshair' : (tool === 'inspect' ? 'default' : 'cell');
  dom.frame.classList.toggle('drawing', state.activePanel === 'calibrate' && tool !== 'inspect');
}

function switchPanel(panel) {
  state.activePanel = panel;
  if (panel === 'scenes' && dom.sceneNameInput && document.activeElement !== dom.sceneNameInput) {
    dom.sceneNameInput.value = state.scene.name || '';
  }
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

function addStart(point, confidence = 'confirmed', source = 'manual') {
  const index = state.scene.starts.length;
  state.scene.starts.push({
    id: `p${Date.now()}-${index}`,
    label: `${index + 1}号逃生者`,
    building: '绿门起点',
    x: point.x,
    y: point.y,
    color: ROUTE_COLORS[index % ROUTE_COLORS.length],
    confidence,
    source,
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
  if (['obstacle', 'bounds'].includes(state.tool)) {
    pushHistory();
    state.drag = { start: point, current: point, tool: state.tool };
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
    state.scene.fires = [{
      id: 'fire-user',
      ...point,
      hardRadius: 0.04,
      radius: 0.16,
      intensity: 7,
      source: 'manual',
      confidence: 'confirmed',
    }];
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
  const dragTool = state.drag.tool;
  const rectangle = {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
  state.drag = null;
  if (dragTool === 'bounds') {
    if (rectangle.width < 0.2 || rectangle.height < 0.2) {
      state.undoStack.pop();
      showToast('规划区太小，请重新框选整个沙盘');
    } else {
      state.scene.planningBounds = { ...rectangle, source: 'manual' };
      state.scene.calibrated = false;
      findSceneCandidates({ announce: false });
      showToast('已更新规划区；框外将作为不可通行区域');
    }
    try { dom.canvas.releasePointerCapture(event.pointerId); } catch {}
    drawMap();
    return;
  }
  const obstacle = {
    id: `obstacle-${Date.now()}`,
    kind: 'object',
    type: 'rect',
    source: 'manual',
    confidence: 'confirmed',
    ...rectangle,
  };
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

function getCurrentImageData() {
  if (!state.image) return;
  const maximumWidth = 480;
  const scale = Math.min(1, maximumWidth / state.image.naturalWidth);
  const width = Math.max(40, Math.round(state.image.naturalWidth * scale));
  const height = Math.max(30, Math.round(state.image.naturalHeight * scale));
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const offscreenContext = offscreen.getContext('2d', { willReadFrequently: true });
  offscreenContext.drawImage(state.image, 0, 0, width, height);
  return offscreenContext.getImageData(0, 0, width, height);
}

function overlapsSubstantially(first, second) {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const smallerArea = Math.min(first.width * first.height, second.width * second.height);
  return smallerArea > 0 && intersection / smallerArea >= 0.5;
}

function warmRowFraction(imageData, y) {
  const { data, width } = imageData;
  let warmPixels = 0;
  let sampledPixels = 0;
  for (let x = 0; x < width; x += 2) {
    const offset = (y * width + x) * 4;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const saturation = maximum ? (maximum - minimum) / maximum : 0;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    if (red >= green * 1.02 && green >= blue * 1.02 && luminance > 55 && saturation > 0.08) warmPixels += 1;
    sampledPixels += 1;
  }
  return sampledPixels ? warmPixels / sampledPixels : 0;
}

function estimatePlanningBounds(imageData, greenCandidates) {
  const { height } = imageData;
  const rowScores = [];
  for (let y = 0; y < height; y += 2) rowScores.push({ y, score: warmRowFraction(imageData, y) });
  let sustainedWarmTop = 0;
  for (let index = 0; index <= rowScores.length - 10; index += 1) {
    const window = rowScores.slice(index, index + 10);
    if (window.filter((row) => row.score >= 0.46).length >= 8) {
      sustainedWarmTop = window[0].y / Math.max(1, height - 1);
      break;
    }
  }
  if (!greenCandidates.length) {
    const top = clamp(sustainedWarmTop - 0.02, 0, 0.35);
    return { x: 0.02, y: top, width: 0.96, height: 0.98 - top, source: 'auto-image' };
  }
  const minimumX = Math.min(...greenCandidates.map((candidate) => candidate.x));
  const maximumX = Math.max(...greenCandidates.map((candidate) => candidate.x));
  const minimumY = Math.min(...greenCandidates.map((candidate) => candidate.y));
  const maximumY = Math.max(...greenCandidates.map((candidate) => candidate.y));
  const horizontalPadding = Math.max(0.18, (maximumX - minimumX) * 0.42);
  const topFromDoors = Math.max(0, minimumY - 0.18);
  const top = sustainedWarmTop > 0 && sustainedWarmTop < minimumY
    ? Math.max(topFromDoors, sustainedWarmTop - 0.015)
    : topFromDoors;
  const left = Math.max(0.01, minimumX - horizontalPadding);
  const right = Math.min(0.99, maximumX + horizontalPadding);
  const bottom = Math.min(0.99, maximumY + Math.max(0.22, (maximumY - minimumY) * 0.48));
  const heightValue = Math.min(1 - top, Math.max(0.2, bottom - top));
  return {
    x: left,
    y: top,
    width: Math.max(0.2, right - left),
    height: heightValue,
    source: 'auto-image',
  };
}

function pointInsideBounds(point, bounds, margin = 0) {
  return !bounds || (
    point.x >= bounds.x - margin
    && point.x <= bounds.x + bounds.width + margin
    && point.y >= bounds.y - margin
    && point.y <= bounds.y + bounds.height + margin
  );
}

function clipRectangleToBounds(rectangle, bounds) {
  if (!bounds || rectangle.type !== 'rect') return rectangle;
  const left = Math.max(rectangle.x, bounds.x);
  const top = Math.max(rectangle.y, bounds.y);
  const right = Math.min(rectangle.x + rectangle.width, bounds.x + bounds.width);
  const bottom = Math.min(rectangle.y + rectangle.height, bounds.y + bounds.height);
  if (right - left < 0.005 || bottom - top < 0.005) return null;
  return { ...rectangle, x: left, y: top, width: right - left, height: bottom - top };
}

function deduplicateGreenCandidates(candidates) {
  const accepted = [];
  const weight = (candidate) => candidate.pixels ?? candidate.matchedTiles ?? 0;
  for (const candidate of [...candidates].sort((first, second) => weight(second) - weight(first))) {
    const duplicate = accepted.some((existing) => {
      const distance = Math.hypot(existing.x - candidate.x, existing.y - candidate.y);
      const localScale = Math.max(0.038, Math.min(0.07, (existing.width + candidate.width + existing.height + candidate.height) / 3));
      return distance <= localScale;
    });
    if (!duplicate) accepted.push(candidate);
  }
  return accepted;
}

function findSceneCandidates({ announce = true } = {}) {
  const imageData = getCurrentImageData();
  if (!imageData) return;
  state.scene.obstacleScanCompleted = false;
  const minGreenPixels = Math.max(10, Math.round(imageData.width * imageData.height / 18000));
  const colorGreenCandidates = detectGreenRegions(imageData, {
    minPixels: minGreenPixels,
    minimumRectangularity: 0.4,
    minimumAreaRatio: 0.0004,
    maximumAreaRatio: 0.015,
    minimumGreenRedRatio: 0.98,
    maximumGreenRedRatio: 1.35,
    maximumBlueGreenRatio: 0.75,
  });
  const learnedGreenCandidates = detectLearnedGreenDoorRegions(imageData, state.trainingSamples, {
    tileSize: Math.max(10, Math.round(imageData.width / 32)),
    matchThreshold: 0.09,
    padding: 0.006,
    maximumAreaRatio: 0.04,
  });
  const detectedGreenCandidates = deduplicateGreenCandidates([
    ...colorGreenCandidates,
    ...learnedGreenCandidates,
  ]).sort((first, second) => first.y - second.y || first.x - second.x);
  const manualPlanningBounds = state.scene.planningBounds?.source === 'manual'
    ? state.scene.planningBounds
    : null;
  state.scene.planningBounds = manualPlanningBounds || estimatePlanningBounds(imageData, detectedGreenCandidates);
  const greenCandidates = detectedGreenCandidates.filter((candidate) => pointInsideBounds(candidate, state.scene.planningBounds));

  const heuristicObstacles = detectObstacleRegions(imageData, {
    minPixels: Math.max(18, Math.round(imageData.width * imageData.height / 9000)),
    morphologyRadius: 1,
    padding: 0.018,
    maximumAreaRatio: 0.1,
    maximumMergedAreaRatio: 0.12,
    mergeGap: 0.025,
  });
  const learnedObstacles = detectLearnedObstacleRegions(imageData, state.trainingSamples, {
    tileSize: Math.max(10, Math.round(imageData.width / 32)),
    matchThreshold: 0.105,
    padding: 0.012,
  });
  const learnedFires = detectLearnedFireRegions(imageData, state.trainingSamples, {
    tileSize: Math.max(10, Math.round(imageData.width / 32)),
    matchThreshold: 0.09,
    padding: 0.006,
    maximumAreaRatio: 0.04,
  }).filter((candidate) => pointInsideBounds(candidate, state.scene.planningBounds));
  const obstacleCandidates = [];
  for (const rawObstacle of [...heuristicObstacles, ...learnedObstacles]) {
    const obstacle = clipRectangleToBounds(rawObstacle, state.scene.planningBounds);
    if (obstacle && !obstacleCandidates.some((existing) => overlapsSubstantially(existing, obstacle))) {
      obstacleCandidates.push(obstacle);
    }
  }

  const manualStarts = state.scene.starts.filter((start) => start.source === 'manual');
  state.scene.starts = [...manualStarts];
  for (const candidate of greenCandidates) {
    if (manualStarts.some((start) => Math.hypot(start.x - candidate.x, start.y - candidate.y) < 0.035)) continue;
    addStart(candidate, 'candidate', candidate.source === 'learned-sample' ? 'learned-sample' : 'auto-image');
  }
  const manualObstacles = state.scene.obstacles.filter((shape) => !['auto-image', 'learned-sample'].includes(shape.source));
  state.scene.obstacles = [...manualObstacles, ...obstacleCandidates];
  const manualFires = state.scene.fires.filter((fire) => fire.source !== 'learned-sample');
  state.scene.fires = [...manualFires, ...learnedFires];
  state.scene.recognition = {
    greenCandidates: greenCandidates.length,
    obstacleCandidates: obstacleCandidates.length,
    learnedCandidates: obstacleCandidates.filter((shape) => shape.source === 'learned-sample').length,
    learnedGreenCandidates: greenCandidates.filter((candidate) => candidate.source === 'learned-sample').length,
    fireCandidates: learnedFires.length,
    planningBounds: state.scene.planningBounds.source,
    analyzedAt: new Date().toISOString(),
  };
  state.scene.obstacleScanCompleted = true;
  invalidateObstacleReview();
  state.selectedRoute = 'all';
  state.scene.calibrated = false;
  recomputePlan();
  if (announce) {
    showToast(`识别完成：绿门 ${greenCandidates.length} 个，火源 ${learnedFires.length} 个，障碍 ${obstacleCandidates.length} 个，请人工复核`);
  }
}

function handlePhotoUpload(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('请选择 JPG、PNG 或 HEIC 图片');
    return;
  }
  sceneLoadRequestId += 1;
  currentSceneSavedAt = '';
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  state.imageUrl = state.objectUrl;
  state.undoStack = [];
  state.scene = {
    name: file.name.replace(/\.[^.]+$/, '') || '新环境',
    source: 'photo',
    calibrated: false,
    obstaclesReviewed: false,
    obstacleScanCompleted: false,
    minimumPassageWidth: 0.046,
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
  loadSceneImage(state.imageUrl, { onLoad: () => findSceneCandidates() });
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

function saveTrainingSamples() {
  try {
    window.localStorage.setItem(TRAINING_STORAGE_KEY, JSON.stringify(state.trainingSamples));
    return true;
  } catch {
    showToast('样本保存空间已满，请删除一些旧样本后重试');
    return false;
  }
}

function imageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

async function createTrainingSample(file, category) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await imageFromUrl(objectUrl);
    const maximumSide = 96;
    const scale = Math.min(1, maximumSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(8, Math.round(image.naturalWidth * scale));
    const height = Math.max(8, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    return {
      id: `sample-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name || `${category}-sample`,
      category,
      thumbnail: canvas.toDataURL('image/jpeg', 0.68),
      features: extractVisualFeatures(imageData),
      createdAt: new Date().toISOString(),
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function addTrainingFiles(files) {
  const imageFiles = [...files].filter((file) => file.type.startsWith('image/'));
  if (!imageFiles.length) {
    showToast('请选择 JPG、PNG 或 HEIC 图片');
    return;
  }
  const remainingCapacity = Math.max(0, 48 - state.trainingSamples.length);
  if (!remainingCapacity) {
    showToast('本机样本上限为 48 张，请先删除旧样本');
    return;
  }
  const selectedFiles = imageFiles.slice(0, remainingCapacity);
  const category = dom.trainingCategory.value;
  const created = [];
  for (const file of selectedFiles) {
    try {
      created.push(await createTrainingSample(file, category));
    } catch {
      showToast(`${file.name} 无法读取，已跳过`);
    }
  }
  if (!created.length) return;
  const previous = state.trainingSamples;
  state.trainingSamples = [...state.trainingSamples, ...created];
  if (!saveTrainingSamples()) {
    state.trainingSamples = previous;
    return;
  }
  renderTrainingSamples();
  const reanalyzed = state.scene.source === 'photo' && state.image;
  if (reanalyzed) findSceneCandidates({ announce: false });
  showToast(reanalyzed
    ? `已加入 ${created.length} 张样本；当前照片已用新样本重新识别`
    : `已加入 ${created.length} 张样本，下次上传场景时生效`);
}

function exportTrainingDataset() {
  const payload = {
    format: 'xiangxing-local-training-set',
    version: 1,
    exportedAt: new Date().toISOString(),
    samples: state.trainingSamples,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `xiangxing-training-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function saveSceneHistory() {
  try {
    window.localStorage.setItem(SCENE_HISTORY_STORAGE_KEY, JSON.stringify(state.sceneHistory));
    return true;
  } catch {
    showToast('场景照片占用空间过大，请删除旧场景后重试');
    return false;
  }
}

function rememberActiveScene(id) {
  try {
    if (id) window.localStorage.setItem(ACTIVE_SCENE_STORAGE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_SCENE_STORAGE_KEY);
  } catch {
    showToast('场景已保存，但浏览器无法记住当前选中项');
  }
}

function currentSceneImageDataUrl() {
  if (!state.image) return null;
  const maximumWidth = 640;
  const scale = Math.min(1, maximumWidth / state.image.naturalWidth);
  const width = Math.max(80, Math.round(state.image.naturalWidth * scale));
  const height = Math.max(60, Math.round(state.image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(state.image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.68);
}

function saveCurrentScene() {
  const name = dom.sceneNameInput.value.trim();
  if (!name) {
    showToast('请先输入场景名称');
    dom.sceneNameInput.focus();
    return;
  }
  const imageDataUrl = currentSceneImageDataUrl();
  if (!imageDataUrl) {
    showToast('场景照片尚未加载完成');
    return;
  }
  const existingIndex = state.scene.historyId
    ? state.sceneHistory.findIndex((record) => record.id === state.scene.historyId)
    : -1;
  if (existingIndex >= 0 && currentSceneSavedAt
    && state.sceneHistory[existingIndex].savedAt !== currentSceneSavedAt) {
    showToast('该场景已在其他页面更新，请先重新打开后再保存');
    return;
  }
  if (existingIndex < 0 && state.sceneHistory.length >= 10) {
    showToast('最多保存 10 个场景，请先删除一条旧记录');
    return;
  }
  const id = existingIndex >= 0 ? state.sceneHistory[existingIndex].id : `scene-${Date.now()}`;
  const previousHistory = structuredClone(state.sceneHistory);
  const previousSceneName = state.scene.name;
  const previousHistoryId = state.scene.historyId;
  state.scene.name = name;
  state.scene.historyId = id;
  const record = {
    id,
    name,
    savedAt: new Date().toISOString(),
    imageDataUrl,
    scene: structuredClone(state.scene),
  };
  if (existingIndex >= 0) state.sceneHistory.splice(existingIndex, 1);
  state.sceneHistory.unshift(record);
  if (!saveSceneHistory()) {
    state.sceneHistory = previousHistory;
    state.scene.name = previousSceneName;
    if (previousHistoryId) state.scene.historyId = previousHistoryId;
    else delete state.scene.historyId;
    return;
  }
  rememberActiveScene(id);
  currentSceneSavedAt = record.savedAt;
  render();
  showToast(existingIndex >= 0 ? '已更新当前场景记录' : '已保存当前场景');
}

async function loadSavedScene(id) {
  const record = state.sceneHistory.find((item) => item.id === id);
  if (!record) return;
  const requestId = ++sceneLoadRequestId;
  try {
    await imageFromUrl(record.imageDataUrl);
  } catch {
    if (requestId !== sceneLoadRequestId) return;
    showToast('该历史场景的图片已损坏，未切换场景');
    return;
  }
  if (requestId !== sceneLoadRequestId) return;
  const latestRecord = state.sceneHistory.find((item) => item.id === id);
  if (!latestRecord || latestRecord.savedAt !== record.savedAt
    || latestRecord.imageDataUrl !== record.imageDataUrl) {
    showToast('该场景在加载期间已更新，请重新打开');
    return;
  }
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
  state.scene = structuredClone(record.scene);
  state.scene.name = record.name;
  state.scene.historyId = record.id;
  state.imageUrl = record.imageDataUrl;
  state.image = null;
  state.undoStack = [];
  state.routes = [];
  state.selectedRoute = 'all';
  rememberActiveScene(record.id);
  currentSceneSavedAt = record.savedAt;
  switchPanel('plan');
  loadSceneImage(state.imageUrl, { onLoad: () => recomputePlan() });
  showToast(`已切换到：${record.name}`);
}

function renameSavedScene(id) {
  const record = state.sceneHistory.find((item) => item.id === id);
  if (!record) return;
  const nextName = window.prompt('输入新场景名称', record.name)?.trim();
  if (!nextName) return;
  const previousName = record.name;
  const previousSavedAt = record.savedAt;
  record.name = nextName;
  record.scene.name = nextName;
  record.savedAt = new Date().toISOString();
  if (!saveSceneHistory()) {
    record.name = previousName;
    record.scene.name = previousName;
    record.savedAt = previousSavedAt;
    return;
  }
  if (state.scene.historyId === id) {
    state.scene.name = nextName;
    currentSceneSavedAt = record.savedAt;
  }
  render();
}

function deleteSavedScene(id) {
  const record = state.sceneHistory.find((item) => item.id === id);
  if (!record || !window.confirm(`删除场景“${record.name}”？此操作无法撤销。`)) return;
  const previousHistory = state.sceneHistory;
  state.sceneHistory = state.sceneHistory.filter((item) => item.id !== id);
  if (!saveSceneHistory()) {
    state.sceneHistory = previousHistory;
    return;
  }
  if (state.scene.historyId === id) {
    delete state.scene.historyId;
    currentSceneSavedAt = '';
    rememberActiveScene('');
  }
  render();
  showToast(`已删除场景：${record.name}`);
}

document.querySelectorAll('[data-upload-trigger]').forEach((button) => {
  button.addEventListener('click', () => dom.photoInput.click());
});

document.querySelectorAll('[data-open-scenes]').forEach((button) => {
  button.addEventListener('click', () => {
    switchPanel('scenes');
    document.querySelector('.side-panel')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  });
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
  findSceneCandidates();
});
dom.trainingUploadButton.addEventListener('click', () => dom.trainingInput.click());
dom.trainingInput.addEventListener('change', async (event) => {
  await addTrainingFiles(event.target.files || []);
  event.target.value = '';
});
dom.trainingGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-delete-sample]');
  if (!button) return;
  const sample = state.trainingSamples.find((item) => item.id === button.dataset.deleteSample);
  if (!sample || !window.confirm(`删除训练样本“${sample.name}”？`)) return;
  const previous = state.trainingSamples;
  state.trainingSamples = state.trainingSamples.filter((item) => item.id !== sample.id);
  if (!saveTrainingSamples()) {
    state.trainingSamples = previous;
    return;
  }
  renderTrainingSamples();
});
dom.exportTrainingButton.addEventListener('click', exportTrainingDataset);
dom.saveSceneButton.addEventListener('click', saveCurrentScene);
dom.sceneNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') saveCurrentScene();
});
dom.sceneHistoryList.addEventListener('click', (event) => {
  const loadButton = event.target.closest('[data-load-scene]');
  const renameButton = event.target.closest('[data-rename-scene]');
  const deleteButton = event.target.closest('[data-delete-scene]');
  if (loadButton) loadSavedScene(loadButton.dataset.loadScene);
  if (renameButton) renameSavedScene(renameButton.dataset.renameScene);
  if (deleteButton) deleteSavedScene(deleteButton.dataset.deleteScene);
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
window.addEventListener('storage', (event) => {
  if (event.key === TRAINING_STORAGE_KEY) {
    state.trainingSamples = loadTrainingSamples();
    renderTrainingSamples();
  }
  if (event.key === SCENE_HISTORY_STORAGE_KEY) {
    state.sceneHistory = loadSceneHistory();
    renderSceneHistory();
  }
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

loadSceneImage(state.imageUrl, {
  onLoad: () => recomputePlan(),
  onError: () => {
    if (!initialSceneRecord) return;
    state.scene = structuredClone(demoScene);
    state.imageUrl = DEMO_IMAGE;
    rememberActiveScene('');
    loadSceneImage(DEMO_IMAGE, { onLoad: () => recomputePlan() });
  },
});
recomputePlan();
switchPanel('plan');
if (!reducedMotion) window.requestAnimationFrame(animate);
