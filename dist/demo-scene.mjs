export const ROUTE_COLORS = ['#d7ff52', '#53c7ff', '#ff8b7f', '#b79cff', '#ffca64', '#4ee0bc', '#f37cff'];

export const demoScene = {
  name: '沙盘 A',
  calibrated: true,
  obstaclesReviewed: true,
  // 有效人员宽度约占沙盘图宽 4.6%；108 列网格下对应至少 5 格净宽。
  minimumPassageWidth: 0.046,
  obstacles: [
    { id: 'b1', kind: 'building', label: '1', type: 'rect', x: 0.036, y: 0.134, width: 0.232, height: 0.296 },
    { id: 'b2', kind: 'building', label: '2', type: 'rect', x: 0.0, y: 0.612, width: 0.243, height: 0.268 },
    { id: 'b3', kind: 'building', label: '3', type: 'rect', x: 0.373, y: 0.053, width: 0.147, height: 0.294 },
    { id: 'b4', kind: 'building', label: '4', type: 'rect', x: 0.365, y: 0.385, width: 0.165, height: 0.270 },
    { id: 'b5', kind: 'building', label: '5', type: 'rect', x: 0.335, y: 0.815, width: 0.201, height: 0.185 },
    { id: 'b6', kind: 'building', label: '6', type: 'rect', x: 0.620, y: 0.144, width: 0.170, height: 0.286 },
    { id: 'b7', kind: 'building', label: '7', type: 'rect', x: 0.575, y: 0.532, width: 0.260, height: 0.238 },
    { id: 'box-1', kind: 'object', type: 'rect', x: 0.217, y: 0.414, width: 0.041, height: 0.081 },
    { id: 'box-2', kind: 'object', type: 'rect', x: 0.390, y: 0.322, width: 0.044, height: 0.073 },
    { id: 'box-3', kind: 'object', type: 'rect', x: 0.546, y: 0.323, width: 0.038, height: 0.059 },
    { id: 'bike-1', kind: 'object', type: 'circle', x: 0.204, y: 0.530, radius: 0.025 },
    { id: 'bike-2', kind: 'object', type: 'circle', x: 0.343, y: 0.524, radius: 0.023 },
    { id: 'bike-3', kind: 'object', type: 'circle', x: 0.360, y: 0.636, radius: 0.026 },
    { id: 'bike-4', kind: 'object', type: 'circle', x: 0.306, y: 0.863, radius: 0.026 },
    { id: 'bike-5', kind: 'object', type: 'circle', x: 0.553, y: 0.818, radius: 0.026 },
    { id: 'bike-6', kind: 'object', type: 'circle', x: 0.510, y: 0.368, radius: 0.022 },
    { id: 'bike-7', kind: 'object', type: 'circle', x: 0.551, y: 0.394, radius: 0.023 },

    // 用户确认：白色泡沫围住的区域不可通行，始终作为硬障碍处理。
    { id: 'foam-left', kind: 'foam', type: 'rect', x: 0.035, y: 0.380, width: 0.045, height: 0.245 },
    { id: 'foam-right', kind: 'foam', type: 'rect', x: 0.765, y: 0.390, width: 0.080, height: 0.590 },
    { id: 'foam-bottom-west', kind: 'foam', type: 'rect', x: 0.0, y: 0.945, width: 0.235, height: 0.055 },
    { id: 'foam-bottom-mid', kind: 'foam', type: 'rect', x: 0.340, y: 0.945, width: 0.220, height: 0.055 },
    { id: 'foam-bottom-east', kind: 'foam', type: 'rect', x: 0.680, y: 0.945, width: 0.165, height: 0.055 },
    { id: 'edge-top', kind: 'boundary', type: 'rect', x: 0.0, y: 0.0, width: 0.845, height: 0.018 },
    { id: 'outside-left', kind: 'boundary', type: 'rect', x: 0.0, y: 0.0, width: 0.035, height: 1.0 },
    { id: 'outside-right', kind: 'boundary', type: 'rect', x: 0.845, y: 0.0, width: 0.155, height: 1.0 },
  ],
  unknowns: [],
  starts: [
    { id: 'p1', label: '1号逃生者', building: '1号楼', x: 0.299, y: 0.325, color: ROUTE_COLORS[0], confidence: 'confirmed' },
    { id: 'p2', label: '2号逃生者', building: '2号楼', x: 0.271, y: 0.763, color: ROUTE_COLORS[1], confidence: 'inferred' },
    { id: 'p3', label: '3号逃生者', building: '3号楼', x: 0.346, y: 0.263, color: ROUTE_COLORS[2], confidence: 'confirmed' },
    { id: 'p4', label: '4号逃生者', building: '4号楼', x: 0.561, y: 0.475, color: ROUTE_COLORS[3], confidence: 'confirmed' },
    { id: 'p5', label: '5号逃生者', building: '5号楼', x: 0.430, y: 0.775, color: ROUTE_COLORS[4], confidence: 'inferred' },
    { id: 'p6', label: '6号逃生者', building: '6号楼', x: 0.589, y: 0.288, color: ROUTE_COLORS[5], confidence: 'confirmed' },
    { id: 'p7', label: '7号逃生者', building: '7号楼', x: 0.551, y: 0.663, color: ROUTE_COLORS[6], confidence: 'inferred' },
  ],
  exits: [
    // 最新照片标注：安全出口位于图片上方两条开放巷口。
    { id: 'northwest', code: 'E1', label: 'E1 北侧安全口', x: 0.315, y: 0.115 },
    { id: 'northeast', code: 'E2', label: 'E2 北侧安全口', x: 0.570, y: 0.115 },
  ],
  fires: [{ id: 'fire-1', x: 0.520, y: 0.385, hardRadius: 0.020, radius: 0.130, intensity: 7 }],
};
