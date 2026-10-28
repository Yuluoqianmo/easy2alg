import type { Point } from "./schemas";

/**
 * 多边形焊盘的几何工具（异形焊盘，2026-10-27 引入；2026-10-28 挪到 shared）。
 *
 * 放在 `shared` 是因为两端都要用：
 *  - 主进程生成 `.ssm`（焊盘局部坐标 + 阻焊外扩 + 钢网缩放）；
 *  - 渲染进程画 PCB 预览（必须画出真实轮廓，否则界面上一律是矩形，
 *    用户会以为"没有创建异形焊盘"）。
 */

export const roundMm = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

const samePoint = (left: Point, right: Point): boolean =>
  Math.abs(left.x - right.x) < 1e-6 && Math.abs(left.y - right.y) < 1e-6;

/**
 * 去掉重复点与末尾的闭合点。立创的多边形常把首点重复写在末尾，
 * 而 axlPathStart 期望的是"起点 + 后续各点"，重复点会让边长为 0、法线算不出来。
 */
export const normalizePolygon = (points: readonly Point[]): readonly Point[] => {
  const deduped: Point[] = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (last === undefined || !samePoint(last, point)) {
      deduped.push(point);
    }
  }
  while (deduped.length > 1 && samePoint(deduped[0], deduped[deduped.length - 1])) {
    deduped.pop();
  }
  return deduped;
};

/** 有符号面积：> 0 为逆时针（CCW）。用来统一法线朝外的那一侧。 */
export const polygonSignedArea = (points: readonly Point[]): number => {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += current.x * next.y - next.x * current.y;
  }
  return total / 2;
};

export const polygonBounds = (
  points: readonly Point[],
): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } => {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
};

/**
 * 沿外法线整体外扩 `distance`（毫米）。用于阻焊开窗：Allegro padstack 的
 * SOLDERMASK 层必须自己给出放大后的图形，形状符号没法在引用时缩放。
 *
 * 用标准的斜接（miter）算法：顶点沿两条邻边法线的角平分线外移 d / cos(半角)。
 * 细密圆弧上相邻边几乎平行 → cos ≈ 1 → 位移 ≈ d，正是想要的；只有极尖锐的
 * 凹角才会让位移爆掉，所以把放大倍数钳在 4 倍以内（宁可少外扩，也不生尖刺）。
 */
export const offsetPolygon = (points: readonly Point[], distance: number): readonly Point[] => {
  const ring = normalizePolygon(points);
  if (ring.length < 3 || distance === 0) {
    return ring;
  }
  // 统一成逆时针，这样「边 (a→b) 的外法线 = (dy, -dx)」恒成立。
  const ccw = polygonSignedArea(ring) < 0 ? [...ring].reverse() : [...ring];
  const normals = ccw.map((point, index) => {
    const next = ccw[(index + 1) % ccw.length];
    const dx = next.x - point.x;
    const dy = next.y - point.y;
    const length = Math.hypot(dx, dy);
    return length === 0 ? { x: 0, y: 0 } : { x: dy / length, y: -dx / length };
  });
  const maxMiter = 4;
  return ccw.map((point, index) => {
    const previous = normals[(index - 1 + normals.length) % normals.length];
    const current = normals[index];
    const bisectorX = previous.x + current.x;
    const bisectorY = previous.y + current.y;
    const bisectorLength = Math.hypot(bisectorX, bisectorY);
    if (bisectorLength < 1e-9) {
      return { ...point };
    }
    const unitX = bisectorX / bisectorLength;
    const unitY = bisectorY / bisectorLength;
    // cos(半角) = 角平分线方向与任一边法线的夹角余弦
    const cosine = unitX * current.x + unitY * current.y;
    const scale = Math.min(1 / Math.max(cosine, 1 / maxMiter), maxMiter);
    return {
      x: roundMm(point.x + unitX * distance * scale),
      y: roundMm(point.y + unitY * distance * scale),
    };
  });
};

/** 以多边形自身包围盒中心为基准整体缩放（钢网面积比 < 1 时用）。 */
export const scalePolygon = (points: readonly Point[], factor: number): readonly Point[] => {
  if (factor === 1) {
    return normalizePolygon(points);
  }
  const box = polygonBounds(points);
  const centerX = (box.minX + box.maxX) / 2;
  const centerY = (box.minY + box.maxY) / 2;
  return normalizePolygon(
    points.map((point) => ({
      x: roundMm(centerX + (point.x - centerX) * factor),
      y: roundMm(centerY + (point.y - centerY) * factor),
    })),
  );
};

/** 多边形 → SVG `points` 属性（预览画图用）。 */
export const polygonPointsAttribute = (points: readonly Point[]): string =>
  points.map((point) => `${roundMm(point.x)},${roundMm(point.y)}`).join(" ");
