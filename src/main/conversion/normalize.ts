import { parseFootprintShapes } from "@jlcpcb/core";
import { z } from "zod";
import type {
  NormalizedCircle,
  NormalizedFootprint,
  NormalizedLine,
  NormalizedPad,
  PadShape,
  Point,
  ThreeDModel,
} from "../../shared/schemas";
import { NormalizedFootprintSchema } from "../../shared/schemas";
import {
  approximateSvgArc,
  computeBounds,
  normalizePoint,
  parseCoordinatePairs,
  roundMm,
  toMm,
} from "./geometry";
import { deriveTargetPackageName } from "./naming";

const NumberLikeSchema = z.union([z.string(), z.number()]);
const RawHeadSchema = z.object({
  x: NumberLikeSchema,
  y: NumberLikeSchema,
  c_para: z.record(z.string(), z.string()).optional(),
});
const RawDataStringSchema = z.object({
  head: RawHeadSchema,
  shape: z.array(z.string()),
  canvas: z.string().optional(),
});
const RawResultSchema = z.object({
  dataStr: RawDataStringSchema.optional(),
  packageDetail: z.object({
    title: z.string(),
    dataStr: RawDataStringSchema,
  }),
  lcsc: z
    .object({
      number: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  SMT: z.boolean().optional(),
  customData: z
    .object({
      jlcPara: z
        .object({
          assemblyProcess: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  description: z.string().optional(),
  title: z.string().optional(),
});
export const RawEasyEdaResponseSchema = z.object({
  success: z.boolean().optional(),
  code: z.number().optional(),
  result: RawResultSchema,
});
export type RawEasyEdaResponse = z.infer<typeof RawEasyEdaResponseSchema>;

const numeric = (value: string | number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`Expected a finite numeric value, received ${String(value)}`);
  }
  return parsed;
};

const padShape = (shape: string, width: number, height: number): PadShape => {
  const normalized = shape.toUpperCase();
  if (normalized === "ELLIPSE" && Math.abs(width - height) < 0.001) {
    return "circle";
  }
  if (normalized === "ELLIPSE" || normalized === "OVAL") {
    return "oval";
  }
  if (normalized === "POLYGON") {
    return "polygon";
  }
  return "rectangle";
};

const mapPad = (
  pad: ReturnType<typeof parseFootprintShapes>["pads"][number],
  originX: number,
  originY: number,
  fallbackNumber: number,
): NormalizedPad => {
  const width = toMm(pad.width);
  const height = toMm(pad.height);
  const holeDiameter = toMm(pad.holeRadius * 2);
  const slotLength = toMm(pad.holeLength);
  const center = normalizePoint(pad.centerX, pad.centerY, originX, originY);
  const polygon = pad.points
    ? parseCoordinatePairs(pad.points).map(([x, y]) => normalizePoint(x, y, originX, originY))
    : [];
  return {
    number: pad.number.trim() || `M${fallbackNumber}`,
    center,
    width,
    height,
    rotation: roundMm(-pad.rotation),
    shape: padShape(pad.shape, width, height),
    polygon,
    plated: holeDiameter === 0 ? true : pad.isPlated,
    holeWidth: holeDiameter,
    holeHeight: slotLength > holeDiameter ? slotLength : holeDiameter,
    sourceLayerId: pad.layerId,
  };
};

const layerFromId = (
  layerId: number,
): "silkscreen" | "assembly" | "courtyard" | "documentation" => {
  if (layerId === 3 || layerId === 4 || layerId === 101) {
    return "silkscreen";
  }
  if (layerId === 13 || layerId === 14 || layerId === 100) {
    return "assembly";
  }
  if (layerId === 99) {
    return "courtyard";
  }
  return "documentation";
};

const trackLines = (
  track: ReturnType<typeof parseFootprintShapes>["tracks"][number],
  originX: number,
  originY: number,
): readonly NormalizedLine[] => {
  const points = parseCoordinatePairs(track.points).map(([x, y]) =>
    normalizePoint(x, y, originX, originY),
  );
  return points.slice(0, -1).map((point, index) => ({
    start: point,
    end: points[index + 1],
    width: Math.max(toMm(track.strokeWidth), 0.01),
    layer: layerFromId(track.layerId),
  }));
};

const rectLinesFromRaw = (
  rawShape: string,
  originX: number,
  originY: number,
): readonly NormalizedLine[] => {
  const fields = rawShape.split("~");
  const x = numeric(fields[1] ?? "0");
  const y = numeric(fields[2] ?? "0");
  const width = numeric(fields[3] ?? "0");
  const height = numeric(fields[4] ?? "0");
  const layerId = Number.parseInt(fields[5] ?? "15", 10);
  const strokeWidth = Math.max(toMm(numeric(fields[8] ?? "0.1")), 0.01);
  const corners = [
    normalizePoint(x, y, originX, originY),
    normalizePoint(x + width, y, originX, originY),
    normalizePoint(x + width, y + height, originX, originY),
    normalizePoint(x, y + height, originX, originY),
  ];
  return corners.map((start, index) => ({
    start,
    end: corners[(index + 1) % corners.length],
    width: strokeWidth,
    layer: layerFromId(layerId),
  }));
};

const circleFromRaw = (
  rawShape: string,
  originX: number,
  originY: number,
): NormalizedCircle => {
  const fields = rawShape.split("~");
  const mappedLayer = layerFromId(Number.parseInt(fields[5] ?? "15", 10));
  return {
    center: normalizePoint(
      numeric(fields[1] ?? "0"),
      numeric(fields[2] ?? "0"),
      originX,
      originY,
    ),
    radius: toMm(numeric(fields[3] ?? "0")),
    width: Math.max(toMm(numeric(fields[4] ?? "0.1")), 0.01),
    layer: mappedLayer === "courtyard" ? "documentation" : mappedLayer,
  };
};

const arcLines = (
  rawShape: string,
  originX: number,
  originY: number,
): readonly NormalizedLine[] => {
  const fields = rawShape.split("~");
  const strokeWidth = Math.max(toMm(numeric(fields[1] ?? "0.1")), 0.01);
  const layer = layerFromId(Number.parseInt(fields[2] ?? "15", 10));
  const points = approximateSvgArc(fields[4] ?? "", originX, originY, 24);
  return points.slice(0, -1).map((start, index) => ({
    start,
    end: points[index + 1],
    width: strokeWidth,
    layer,
  }));
};

const extractModel = (
  shapes: readonly string[],
  originX: number,
  originY: number,
): ThreeDModel | null => {
  const rawNode = shapes.find((shape) => shape.startsWith("SVGNODE~"));
  if (rawNode === undefined) {
    return null;
  }
  const rawJson = rawNode.slice("SVGNODE~".length).split("~")[0];
  const NodeSchema = z.object({
    attrs: z.object({
      title: z.string(),
      uuid: z.string(),
      c_origin: z.string().optional(),
      c_rotation: z.string().optional(),
      z: NumberLikeSchema.optional(),
    }),
  });
  const node = NodeSchema.parse(JSON.parse(rawJson));
  const originParts = (node.attrs.c_origin ?? "0,0").split(",").map(Number);
  const rotationParts = (node.attrs.c_rotation ?? "0,0,0").split(",").map(Number);
  const translation = normalizePoint(
    originParts[0] ?? 0,
    originParts[1] ?? 0,
    originX,
    originY,
  );
  return {
    name: node.attrs.title,
    uuid: node.attrs.uuid,
    translation: {
      x: translation.x,
      y: translation.y,
      z: toMm(numeric(node.attrs.z ?? 0)),
    },
    rotation: {
      x: rotationParts[0] ?? 0,
      y: rotationParts[1] ?? 0,
      z: rotationParts[2] ?? 0,
    },
  };
};

const inferAssemblyProcess = (result: z.infer<typeof RawResultSchema>): "SMT" | "THT" => {
  const explicit = result.customData?.jlcPara?.assemblyProcess?.toUpperCase();
  if (explicit === "SMT" || explicit === "THT") {
    return explicit;
  }
  return result.SMT === true && !result.packageDetail.title.toUpperCase().includes("-TH_")
    ? "SMT"
    : "THT";
};

export const normalizeEasyEdaResponse = (
  rawResponse: unknown,
  requestedLcscId: string,
): NormalizedFootprint => {
  const response = RawEasyEdaResponseSchema.parse(rawResponse);
  const result = response.result;
  const data = result.packageDetail.dataStr;
  const originX = numeric(data.head.x);
  const originY = numeric(data.head.y);
  const parsed = parseFootprintShapes(data.shape);
  const pads = parsed.pads.map((pad, index) => mapPad(pad, originX, originY, index + 1));
  const holes = parsed.holes.map((hole) => ({
    center: normalizePoint(hole.centerX, hole.centerY, originX, originY),
    diameter: toMm(hole.radius * 2),
  }));
  const trackGeometry = parsed.tracks.flatMap((track) => trackLines(track, originX, originY));
  const rectangleGeometry = data.shape
    .filter((shape) => shape.startsWith("RECT~"))
    .flatMap((shape) => rectLinesFromRaw(shape, originX, originY));
  const arcGeometry = data.shape
    .filter((shape) => shape.startsWith("ARC~"))
    .flatMap((shape) => arcLines(shape, originX, originY));
  const circles = data.shape
    .filter((shape) => shape.startsWith("CIRCLE~"))
    .map((shape) => circleFromRaw(shape, originX, originY));
  const lines = [...trackGeometry, ...rectangleGeometry, ...arcGeometry];
  const extraPoints: Point[] = [
    ...lines.flatMap((line) => [line.start, line.end]),
    ...circles.flatMap((circle) => [
      { x: circle.center.x - circle.radius, y: circle.center.y - circle.radius },
      { x: circle.center.x + circle.radius, y: circle.center.y + circle.radius },
    ]),
    ...holes.map((hole) => hole.center),
  ];
  const cPara = data.head.c_para ?? {};
  const sourcePackageName =
    cPara.package ?? result.packageDetail.title ?? `EASYEDA-${requestedLcscId}`;
  const lcscId = result.lcsc?.number?.toUpperCase() ?? requestedLcscId.toUpperCase();
  const footprint: NormalizedFootprint = {
    info: {
      lcscId,
      name: result.dataStr?.head.c_para?.name ?? result.title ?? lcscId,
      manufacturer:
        cPara.Manufacturer ?? cPara.BOM_Manufacturer ?? result.dataStr?.head.c_para?.BOM_Manufacturer ?? "",
      manufacturerPartNumber:
        cPara["Manufacturer Part"] ??
        cPara["BOM_Manufacturer Part"] ??
        result.dataStr?.head.c_para?.["Manufacturer Part"] ??
        "",
      sourcePackageName,
      targetPackageName: deriveTargetPackageName(sourcePackageName, pads),
      assemblyProcess: inferAssemblyProcess(result),
      description: result.description ?? result.title ?? "",
    },
    pads,
    holes,
    lines,
    circles,
    sourceOrigin: { x: originX, y: originY },
    bounds: computeBounds(pads, extraPoints),
    model3d: extractModel(data.shape, originX, originY),
    sourceJson: JSON.stringify(response),
  };
  return NormalizedFootprintSchema.parse(footprint);
};
