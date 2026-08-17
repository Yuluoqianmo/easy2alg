import { createHash } from "node:crypto";
import type { NormalizedPad } from "../../shared/schemas";
import { uniquePositiveDeltas } from "./geometry";

const IPC_MAX_NAME_LENGTH = 31;

const toHundredthMillimeter = (value: number): number => Math.max(1, Math.round(value * 100));

const sanitizeName = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");

const compactFallbackName = (sourceName: string): string => {
  const sanitized = sanitizeName(sourceName) || "EASYEDA-FOOTPRINT";
  if (sanitized.length <= IPC_MAX_NAME_LENGTH) {
    return sanitized;
  }
  const digest = createHash("sha256").update(sourceName).digest("hex").slice(0, 6).toUpperCase();
  return `${sanitized.slice(0, IPC_MAX_NAME_LENGTH - digest.length - 1)}-${digest}`;
};

const minimumPitch = (pads: readonly NormalizedPad[]): number | null => {
  const coordinateGroups = [
    ...new Map(
      pads.map((pad) => [Math.round(pad.center.x * 100), [] as number[]]),
    ).keys(),
  ].flatMap((xKey) => {
    const values = pads
      .filter((pad) => Math.round(pad.center.x * 100) === xKey)
      .map((pad) => pad.center.y);
    return uniquePositiveDeltas(values);
  });
  const rowGroups = [
    ...new Map(
      pads.map((pad) => [Math.round(pad.center.y * 100), [] as number[]]),
    ).keys(),
  ].flatMap((yKey) => {
    const values = pads
      .filter((pad) => Math.round(pad.center.y * 100) === yKey)
      .map((pad) => pad.center.x);
    return uniquePositiveDeltas(values);
  });
  const candidates = [...coordinateGroups, ...rowGroups].filter((value) => value >= 0.2);
  return candidates.length > 0 ? Math.min(...candidates) : null;
};

const bodyDimensionsFromName = (sourceName: string): readonly [number, number] | null => {
  const match = sourceName.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(?:MM)?/i);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2])];
};

const padSpan = (pads: readonly NormalizedPad[]): number => {
  const minX = Math.min(...pads.map((pad) => pad.center.x - pad.width / 2));
  const maxX = Math.max(...pads.map((pad) => pad.center.x + pad.width / 2));
  const minY = Math.min(...pads.map((pad) => pad.center.y - pad.height / 2));
  const maxY = Math.max(...pads.map((pad) => pad.center.y + pad.height / 2));
  return Math.max(maxX - minX, maxY - minY);
};

const nominalLeadSpan = (family: "SOIC" | "SSOP" | "TSSOP", bodyWidth: number): number => {
  const knownSpans: Readonly<Record<typeof family, readonly [number, number][]>> = {
    SOIC: [
      [3.9, 6],
      [5.3, 7.8],
      [7.5, 10.3],
    ],
    SSOP: [
      [3.9, 6],
      [5.3, 7.8],
      [7.5, 10.3],
    ],
    TSSOP: [
      [4.4, 6.4],
      [6.1, 8.1],
    ],
  };
  const nearest = knownSpans[family]
    .map(([knownWidth, span]) => ({ distance: Math.abs(knownWidth - bodyWidth), span }))
    .sort((left, right) => left.distance - right.distance)[0];
  return nearest !== undefined && nearest.distance <= 0.35 ? nearest.span : bodyWidth + 2.1;
};

export const deriveTargetPackageName = (
  sourceName: string,
  pads: readonly NormalizedPad[],
): string => {
  const upper = sourceName.toUpperCase();
  const numberedPads = pads.filter((pad) => /^\d+$/.test(pad.number));
  const pinCount = numberedPads.length > 0 ? numberedPads.length : pads.length;
  const pitch = minimumPitch(numberedPads);
  const bodyDimensions = bodyDimensionsFromName(sourceName);
  const span = padSpan(pads);

  if (/(?:SOIC|SOP|SSOP|TSSOP)/.test(upper) && pitch !== null) {
    const family = upper.includes("TSSOP")
      ? "TSSOP"
      : upper.includes("SSOP")
        ? "SSOP"
        : "SOIC";
    const nominalHeight = family === "TSSOP" ? 1.2 : 1.75;
    const bodyWidth = bodyDimensions?.[0];
    const leadSpan =
      bodyWidth === undefined ? span : nominalLeadSpan(family, bodyWidth);
    return `${family}${toHundredthMillimeter(pitch)}P${toHundredthMillimeter(leadSpan)}X${toHundredthMillimeter(nominalHeight)}-${pinCount}N`;
  }

  if (/(?:QFN|DFN)/.test(upper) && pitch !== null && bodyDimensions !== null) {
    const family = upper.includes("DFN") ? "DFN" : "QFN";
    const [bodyX, bodyY] = bodyDimensions;
    const nominalHeight = 1;
    return `${family}${toHundredthMillimeter(pitch)}P${toHundredthMillimeter(bodyX)}X${toHundredthMillimeter(bodyY)}X${toHundredthMillimeter(nominalHeight)}-${pinCount}N`;
  }

  if (/(?:LQFP|TQFP|QFP)/.test(upper) && pitch !== null && bodyDimensions !== null) {
    const family = upper.includes("LQFP") ? "LQFP" : upper.includes("TQFP") ? "TQFP" : "QFP";
    const [bodyX, bodyY] = bodyDimensions;
    return `${family}${toHundredthMillimeter(pitch)}P${toHundredthMillimeter(bodyX)}X${toHundredthMillimeter(bodyY)}-${pinCount}N`;
  }

  if (upper.includes("BGA") && pitch !== null && bodyDimensions !== null) {
    const [bodyX, bodyY] = bodyDimensions;
    return `BGA${toHundredthMillimeter(pitch)}P${toHundredthMillimeter(bodyX)}X${toHundredthMillimeter(bodyY)}-${pinCount}N`;
  }

  return compactFallbackName(sourceName);
};

export const derivePadstackName = (pad: NormalizedPad): string => {
  const shapeCode =
    pad.shape === "circle"
      ? "C"
      : pad.shape === "oval"
        ? "O"
        : pad.shape === "polygon"
          ? "P"
          : pad.shape === "roundedRectangle"
            ? "RR"
            : "R";
  const width = toHundredthMillimeter(pad.width);
  const height = toHundredthMillimeter(pad.height);
  if (pad.holeWidth > 0) {
    const holeWidth = toHundredthMillimeter(pad.holeWidth);
    const holeHeight = toHundredthMillimeter(Math.max(pad.holeHeight, pad.holeWidth));
    return `${shapeCode}${width}X${height}_H${holeWidth}X${holeHeight}`;
  }
  return `${shapeCode}${width}X${height}`;
};
