import type { NormalizedPad, Point } from "../../shared/schemas";

export const EASYEDA_UNIT_MM = 0.254;

export const roundMm = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

export const toMm = (value: number): number => roundMm(value * EASYEDA_UNIT_MM);

export const normalizePoint = (
  rawX: number,
  rawY: number,
  originX: number,
  originY: number,
): Point => ({
  x: toMm(rawX - originX),
  y: toMm(-(rawY - originY)),
});

export const parseCoordinatePairs = (value: string): readonly [number, number][] => {
  const values = value
    .trim()
    .split(/[\s,]+/)
    .filter((item) => item.length > 0)
    .map((item) => Number(item));

  if (values.some((item) => !Number.isFinite(item))) {
    throw new TypeError(`Invalid EasyEDA coordinate list: ${value}`);
  }

  const pairs: [number, number][] = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    pairs.push([values[index], values[index + 1]]);
  }
  return pairs;
};

const rotatePoint = (point: Point, center: Point, angleDegrees: number): Point => {
  const radians = (angleDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const offsetX = point.x - center.x;
  const offsetY = point.y - center.y;
  return {
    x: roundMm(center.x + offsetX * cosine - offsetY * sine),
    y: roundMm(center.y + offsetX * sine + offsetY * cosine),
  };
};

export const padCorners = (pad: NormalizedPad): readonly Point[] => {
  if (pad.shape === "polygon" && pad.polygon.length >= 3) {
    return pad.polygon;
  }
  const halfWidth = pad.width / 2;
  const halfHeight = pad.height / 2;
  return [
    { x: pad.center.x - halfWidth, y: pad.center.y - halfHeight },
    { x: pad.center.x + halfWidth, y: pad.center.y - halfHeight },
    { x: pad.center.x + halfWidth, y: pad.center.y + halfHeight },
    { x: pad.center.x - halfWidth, y: pad.center.y + halfHeight },
  ].map((point) => rotatePoint(point, pad.center, pad.rotation));
};

export const computeBounds = (
  pads: readonly NormalizedPad[],
  extraPoints: readonly Point[],
): { minX: number; minY: number; maxX: number; maxY: number } => {
  const points = [...pads.flatMap((pad) => padCorners(pad)), ...extraPoints];
  if (points.length === 0) {
    throw new RangeError("Cannot compute footprint bounds without geometry");
  }
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
};

export const uniquePositiveDeltas = (values: readonly number[]): readonly number[] => {
  const sorted = [...new Set(values.map((value) => roundMm(value)))].sort(
    (left, right) => left - right,
  );
  const deltas: number[] = [];
  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
      const delta = roundMm(sorted[rightIndex] - sorted[leftIndex]);
      if (delta > 0.05) {
        deltas.push(delta);
      }
    }
  }
  return [...new Set(deltas)].sort((left, right) => left - right);
};

const vectorAngle = (ux: number, uy: number, vx: number, vy: number): number => {
  const dot = ux * vx + uy * vy;
  const magnitude = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  const clamped = Math.min(1, Math.max(-1, dot / magnitude));
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  return sign * Math.acos(clamped);
};

export const approximateSvgArc = (
  path: string,
  originX: number,
  originY: number,
  segments: number,
): readonly Point[] => {
  const values = path
    .replace(/[A-Za-z]/g, " ")
    .replace(/,/g, " ")
    .trim()
    .split(/\s+/)
    .map((item) => Number(item));
  if (values.length < 9 || values.some((item) => !Number.isFinite(item))) {
    throw new TypeError(`Unsupported EasyEDA arc path: ${path}`);
  }

  const [startX, startY, radiusXInput, radiusYInput, rotation, largeArc, sweep, endX, endY] =
    values.slice(-9);
  const phi = (rotation * Math.PI) / 180;
  const cosine = Math.cos(phi);
  const sine = Math.sin(phi);
  const dx = (startX - endX) / 2;
  const dy = (startY - endY) / 2;
  const transformedX = cosine * dx + sine * dy;
  const transformedY = -sine * dx + cosine * dy;
  let radiusX = Math.abs(radiusXInput);
  let radiusY = Math.abs(radiusYInput);
  const radiusScale =
    (transformedX * transformedX) / (radiusX * radiusX) +
    (transformedY * transformedY) / (radiusY * radiusY);
  if (radiusScale > 1) {
    const scale = Math.sqrt(radiusScale);
    radiusX *= scale;
    radiusY *= scale;
  }

  const numerator =
    radiusX * radiusX * radiusY * radiusY -
    radiusX * radiusX * transformedY * transformedY -
    radiusY * radiusY * transformedX * transformedX;
  const denominator =
    radiusX * radiusX * transformedY * transformedY +
    radiusY * radiusY * transformedX * transformedX;
  const factorSign = largeArc === sweep ? -1 : 1;
  const factor = factorSign * Math.sqrt(Math.max(0, numerator / denominator));
  const centerTransformedX = (factor * radiusX * transformedY) / radiusY;
  const centerTransformedY = (-factor * radiusY * transformedX) / radiusX;
  const centerX =
    cosine * centerTransformedX - sine * centerTransformedY + (startX + endX) / 2;
  const centerY =
    sine * centerTransformedX + cosine * centerTransformedY + (startY + endY) / 2;

  const startVectorX = (transformedX - centerTransformedX) / radiusX;
  const startVectorY = (transformedY - centerTransformedY) / radiusY;
  const endVectorX = (-transformedX - centerTransformedX) / radiusX;
  const endVectorY = (-transformedY - centerTransformedY) / radiusY;
  const startAngle = vectorAngle(1, 0, startVectorX, startVectorY);
  let angleDelta = vectorAngle(startVectorX, startVectorY, endVectorX, endVectorY);
  if (sweep === 0 && angleDelta > 0) {
    angleDelta -= Math.PI * 2;
  }
  if (sweep === 1 && angleDelta < 0) {
    angleDelta += Math.PI * 2;
  }

  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = startAngle + (angleDelta * index) / segments;
    const rawX =
      centerX + cosine * radiusX * Math.cos(angle) - sine * radiusY * Math.sin(angle);
    const rawY =
      centerY + sine * radiusX * Math.cos(angle) + cosine * radiusY * Math.sin(angle);
    return normalizePoint(rawX, rawY, originX, originY);
  });
};
