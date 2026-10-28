import { z } from "zod";
import type {
  NormalizedSymbol,
  NormalizedSymbolPin,
  NormalizedSymbolSection,
  NormalizedSymbolShape,
  Point,
  SymbolPinType,
} from "../../shared/schemas";
import { NormalizedSymbolSchema } from "../../shared/schemas";
import { avoidLabelOverlapInSection } from "../../shared/symbol-layout";
import {
  attachPinLabelAnchors,
  bodyBoxOf,
  DEFAULT_SYMBOL_TEXT_HEIGHT,
  sectionLabelsCollide,
} from "../../shared/symbol-labels";
import { alignPinsToGrid } from "../../shared/symbol-layout";
import { dedupePinNames } from "../../shared/symbol-normalize";
import { cleanSymbolName, refdesPrefixFrom, sanitizeSymbolName } from "./naming";

/**
 * 立创编号（在线 EasyEDA **标准版**）链路里的原理图符号解析。
 *
 * 数据就在 `result.dataStr` 里 —— 和 PCB 封装同一次接口响应（`packageDetail.dataStr`
 * 是封装），所以**不需要额外请求**，只是过去没用它（用户 2026-10-16 反馈
 * "搜索的器件没出现原理图符号，实际是有符号的"）。
 *
 * 行式格式（用 C2040/RP2040、C7955/LM393 两个真实响应逐字段核对过）：
 *
 *   引脚 P~show~<电气类型>~<脚号>~<x>~<y>~<旋转>~<id>~<locked>
 *        ^^ <x>~<y>
 *        ^^ <SVG 路径>~<颜色>                    ← 从自由端往本体画，如 `M 525 230 h -10`
 *        ^^ 1~<x>~<y>~<旋转>~<引脚名>~...        ← 名字文字（下标 4 才是文本）
 *        ^^ 1~<x>~<y>~<旋转>~<脚号>~...          ← 脚号文字
 *        ^^ 0~<x>~<y>
 *        ^^ 0~<时钟/箭头路径>
 *
 *   矩形 R~<x>~<y>~<圆角x>~<圆角y>~<宽>~<高>~<描边色>~<描边宽>~<填充>~<id>~<locked>
 *   椭圆 E~<cx>~<cy>~<rx>~<ry>~<描边色>~<描边宽>~<填充>~<填充色>~<id>~<locked>
 *   文本 T~<对齐>~<x>~<y>~<旋转>~<色>~<字体>~<字号>~...~<类型>~<文本>~...
 *
 * 坐标约定（重要）：
 *  - **单位不换算**：源符号单位就是 Capture 符号单位（1 单位 = 10 mil），
 *    引脚间距 10、引脚长 10，与 Capture 库一致，和封装通道的 mil→mm 无关。
 *  - **y 轴不翻转**：EasyEDA 画布 y 向下，Capture 符号编辑器 y 也向下（见
 *    symbol-labels.ts 的说明），两边一致。
 *  - 本体锚点同样归零：本体 RECT 的 min 角平移到 (0,0)（现网库 201/211 个器件如此）。
 */

const ELECTRIC_PIN_TYPE: Readonly<Record<string, SymbolPinType>> = {
  // 实测：C2040 的 RUN/XIN = 1、QSPI_SCLK/SWCLK = 2、GPIO 与电源 = 3、
  // LM393 全部 = 0。按 EasyEDA 电气类型下拉顺序映射，未定义/缺省落 unspecified。
  "0": "unspecified",
  "1": "input",
  "2": "output",
  "3": "bidirectional",
  "4": "passive",
  "5": "openCollector",
  "6": "openEmitter",
  "7": "tristate",
};

/** 引脚自由端在哪个方向：旋转角 → 外向法线。实测 0=右侧 90=上 180=左 270=下。 */
const outwardOf = (rotation: number): Point => {
  const radians = (rotation * Math.PI) / 180;
  return { x: Math.round(Math.cos(radians)), y: Math.round(-Math.sin(radians)) };
};

const PIN_LENGTH_PATTERN = /^\s*M\s*[-\d.]+\s+[-\d.]+\s*([hv])\s*(-?[\d.]+)/i;

/** 引脚长度：直接量 `M x y h ±len` / `v ±len`，拿不到就退化成 10（EasyEDA 默认）。 */
const pinLengthFrom = (path: string): number => {
  const match = PIN_LENGTH_PATTERN.exec(path);
  if (match === null) {
    return 10;
  }
  const length = Math.abs(Number(match[2]));
  return Number.isFinite(length) && length > 0 ? length : 10;
};

const numberOr = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const ellipsePoints = (cx: number, cy: number, rx: number, ry: number): Point[] =>
  Array.from({ length: 24 }, (_, index) => {
    const angle = (index / 24) * Math.PI * 2;
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  });

/** `PL~x1 y1 x2 y2 …~色~宽~…` 折线 */
const polylinePoints = (raw: string): Point[] =>
  raw
    .split("~")[1]
    ?.trim()
    .split(/\s+/)
    .reduce<Point[]>((points, token, index, all) => {
      if (index % 2 === 0) {
        const x = Number(token);
        const y = Number(all[index + 1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          points.push({ x, y });
        }
      }
      return points;
    }, []) ?? [];

type ParsedSymbolShapes = {
  readonly pins: NormalizedSymbolPin[];
  readonly shapes: NormalizedSymbolShape[];
};

const parseShapes = (shape: readonly string[]): ParsedSymbolShapes => {
  const pins: NormalizedSymbolPin[] = [];
  const shapes: NormalizedSymbolShape[] = [];

  for (const line of shape) {
    const head = line.split("^^")[0] ?? "";
    const fields = head.split("~");
    switch (fields[0]) {
      case "P": {
        const connection = { x: numberOr(fields[4], 0), y: numberOr(fields[5], 0) };
        const rotation = numberOr(fields[6], 0);
        const outward = outwardOf(rotation);
        const length = pinLengthFrom(line.split("^^")[2] ?? "");
        const nameParts = (line.split("^^")[3] ?? "").split("~");
        const numberParts = (line.split("^^")[4] ?? "").split("~");
        pins.push({
          name: (nameParts[4] ?? "").trim(),
          // 极少数引脚不给脚号：用脚号字段兜底，避免 .olb 里出现空脚号。
          number: (numberParts[4] ?? fields[3] ?? "").trim() || `PIN_${pins.length + 1}`,
          connection,
          body: {
            x: connection.x - outward.x * length,
            y: connection.y - outward.y * length,
          },
          length,
          type: ELECTRIC_PIN_TYPE[fields[2] ?? "0"] ?? "unspecified",
          visible: (fields[1] ?? "show") !== "hide",
        });
        break;
      }
      case "R":
      case "PG": {
        if (fields[0] === "PG") {
          const points = polylinePoints(head);
          if (points.length >= 3) {
            shapes.push({ kind: "polyline", points, closed: true });
          }
          break;
        }
        const x = numberOr(fields[1], 0);
        const y = numberOr(fields[2], 0);
        const width = numberOr(fields[5], 0);
        const height = numberOr(fields[6], 0);
        if (width === 0 || height === 0) {
          break;
        }
        shapes.push({
          kind: "rect",
          min: { x, y },
          max: { x: x + width, y: y + height },
          cornerRadius: Math.max(numberOr(fields[3], 0), 0),
          filled: (fields[9] ?? "none") !== "none",
        });
        break;
      }
      case "E":
      case "C": {
        const cx = numberOr(fields[1], 0);
        const cy = numberOr(fields[2], 0);
        // C~cx~cy~r~… ；E~cx~cy~rx~ry~…
        const rx = fields[0] === "C" ? numberOr(fields[3], 0) : numberOr(fields[3], 0);
        const ry = fields[0] === "C" ? rx : numberOr(fields[4], 0);
        if (rx <= 0 || ry <= 0) {
          break;
        }
        // 符号图元只支持矩形/折线/文本 → 圆与椭圆用 24 边形近似。
        shapes.push({ kind: "polyline", points: ellipsePoints(cx, cy, rx, ry), closed: true });
        break;
      }
      case "PL": {
        const points = polylinePoints(head);
        if (points.length >= 2) {
          shapes.push({ kind: "polyline", points, closed: false });
        }
        break;
      }
      case "T": {
        const value = (fields[12] ?? "").trim();
        if (value.length === 0) {
          break;
        }
        shapes.push({
          kind: "text",
          text: value,
          at: { x: numberOr(fields[2], 0), y: numberOr(fields[3], 0) },
          rotation: numberOr(fields[4], 0),
          // 源字号形如 "11.5pt"；符号单位下 1pt ≈ 1.33 单位。
          // 下限 = 符号文本的默认字号（用户 2026-10-16 要求 7，原先是 6）：
          // 源数据给的字号过小时兜底用这个值，免得画出一行看不见的小字。
          height: Math.max(
            Number.parseFloat(fields[7] ?? "12") * 1.33 || 12,
            DEFAULT_SYMBOL_TEXT_HEIGHT,
          ),
        });
        break;
      }
      default:
        break;
    }
  }

  return { pins, shapes };
};

const boundsOf = (
  pins: readonly NormalizedSymbolPin[],
  shapes: readonly NormalizedSymbolShape[],
  bbox: { x: number; y: number; width: number; height: number } | undefined,
): { minX: number; minY: number; maxX: number; maxY: number } => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const pin of pins) {
    xs.push(pin.connection.x, pin.body.x);
    ys.push(pin.connection.y, pin.body.y);
  }
  for (const shape of shapes) {
    if (shape.kind === "rect") {
      xs.push(shape.min.x, shape.max.x);
      ys.push(shape.min.y, shape.max.y);
    } else if (shape.kind === "polyline") {
      for (const point of shape.points) {
        xs.push(point.x);
        ys.push(point.y);
      }
    } else {
      xs.push(shape.at.x);
      ys.push(shape.at.y);
    }
  }
  if (bbox !== undefined) {
    xs.push(bbox.x, bbox.x + bbox.width);
    ys.push(bbox.y, bbox.y + bbox.height);
  }
  if (xs.length === 0 || ys.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
};

const RawSymbolSchema = z.object({
  head: z
    .object({
      x: z.union([z.string(), z.number()]).optional(),
      y: z.union([z.string(), z.number()]).optional(),
      c_para: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  shape: z.array(z.string()).optional(),
  BBox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
});

/**
 * 多子部件器件（双运放 / 双 MOSFET / 四门逻辑 …）的一段符号。
 *
 * 实测（C18221391 = AGM609MNA 双 MOSFET、C55807314 = LM358）：
 * 这类器件 `result.dataStr.shape` 是**空数组**，真实图形逐段放在
 * `result.subparts[]` 里，每段自带 head.c_para（`pre` 形如 `U?.1`）与 BBox。
 * 只读 dataStr 的旧逻辑会把它们当成"没有原理图符号"。
 */
export type EasyEdaSubpart = {
  readonly title?: string;
  readonly dataStr?: unknown;
};

type ParsedPart = {
  readonly name: string;
  readonly refdesPrefix: string;
  readonly pins: readonly NormalizedSymbolPin[];
  readonly shapes: readonly NormalizedSymbolShape[];
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

/** 解析一段符号（单段器件的 dataStr，或多子部件器件的一段 subpart）。 */
const parsePart = (
  rawDataStr: unknown,
  options: {
    readonly fallbackName: string;
    readonly fallbackSymbol: string;
    readonly lcscId: string;
  },
): ParsedPart | null => {
  const parsed = RawSymbolSchema.safeParse(rawDataStr);
  if (!parsed.success) {
    return null;
  }
  const data = parsed.data;
  const rawShapes = data.shape ?? [];
  if (rawShapes.length === 0) {
    return null;
  }
  const { pins, shapes } = parseShapes(rawShapes);
  if (pins.length === 0 && shapes.length === 0) {
    return null;
  }
  const cPara = data.head?.c_para ?? {};
  return {
    // 官方库的 c_para.name 形如 `HT7533-1-TD(24V)` / `HT7533-1_C3011202`，
    // 括号说明和立创编号都是供应商元数据，原理图元件名只留型号（见 cleanSymbolName）。
    name: sanitizeSymbolName(
      cleanSymbolName(cPara.name ?? options.fallbackName, options.lcscId),
      options.fallbackSymbol,
    ),
    refdesPrefix: refdesPrefixFrom(cPara.pre),
    pins,
    shapes,
    bounds: boundsOf(pins, shapes, data.BBox),
  };
};

/** 引脚标签塞不进本体时，整段最多放大到几倍（1 = 不放大）。 */
const MAX_LABEL_FIT_SCALE = 4;
/** 只有小于这个尺寸（单位 = 10 mil）的本体才考虑放大：9 单位字高塞不下 40 单位见方的本体。 */
const LABEL_FIT_MIN_BODY = 40;

/** 单段几何 → NormalizedSymbolSection（锚点归零 + 去重 + 吸附 + 标签避让）。 */
const buildSection = (part: ParsedPart, name: string): NormalizedSymbolSection => {
  const { pins, shapes, bounds } = part;
  // 本体锚点归零：取本体 RECT 的 min 角（不是整体 bounds —— 左右引脚伸到 x<0 是正常的）。
  const bodyRect = shapes.find((shape) => shape.kind === "rect");
  const anchorX = bodyRect === undefined ? bounds.minX : Math.min(bodyRect.min.x, bodyRect.max.x);
  const anchorY = bodyRect === undefined ? bounds.minY : Math.min(bodyRect.min.y, bodyRect.max.y);
  const dx = -anchorX;
  const dy = -anchorY;

  const assemble = (scale: number): NormalizedSymbolSection => {
    const movePoint = (point: Point): Point => ({
      x: (point.x + dx) * scale,
      y: (point.y + dy) * scale,
    });
    const moveShape = (shape: NormalizedSymbolShape): NormalizedSymbolShape => {
      if (shape.kind === "rect") {
        return { ...shape, min: movePoint(shape.min), max: movePoint(shape.max) };
      }
      if (shape.kind === "polyline") {
        return { ...shape, points: shape.points.map(movePoint) };
      }
      return { ...shape, at: movePoint(shape.at) };
    };

    // ① 引脚名去重（Cadence 不接受重复引脚文本）→ ② 引脚标签避让。
    // 顺序不能反：避让按引脚名的字宽算竖带深度，必须用**最终名字**（GND_18 比 GND 宽）。
    // 都在解析阶段做，预览与写库看到的是同一份结果。
    return attachPinLabelAnchors(
      avoidLabelOverlapInSection(
        alignPinsToGrid(
          dedupePinNames({
            name,
            bounds: {
              minX: (bounds.minX + dx) * scale,
              minY: (bounds.minY + dy) * scale,
              maxX: (bounds.maxX + dx) * scale,
              maxY: (bounds.maxY + dy) * scale,
            },
            pins: pins.map((pin) => ({
              ...pin,
              connection: movePoint(pin.connection),
              body: movePoint(pin.body),
            })),
            shapes: shapes.map(moveShape),
          }),
        ),
      ),
    );
  };

  /**
   * Capture 的引脚字号固定 9 单位，不随符号大小变。MOSFET / 三极管这类本体只有
   * 20 单位高的符号，名字从上下两边往中间长必然压在一起 —— 这时把**整段按整数倍
   * 放大**（引脚与图元一起放大、字号不变），直到标签互不重叠。
   *
   * 只对**小本体**放大：大符号（RP2048 这类几百单位的）标签本来就排得开，
   * 万一避让没解干净也不能把整个符号放大 4 倍。
   */
  const natural = assemble(1);
  const naturalBody = bodyBoxOf(natural);
  const tooSmall =
    Math.min(naturalBody.maxX - naturalBody.minX, naturalBody.maxY - naturalBody.minY) <
    LABEL_FIT_MIN_BODY;
  if (!tooSmall || !sectionLabelsCollide(natural)) {
    return natural;
  }
  for (let scale = 2; scale <= MAX_LABEL_FIT_SCALE; scale += 1) {
    const section = assemble(scale);
    if (!sectionLabelsCollide(section)) {
      return section;
    }
  }
  return assemble(MAX_LABEL_FIT_SCALE);
};

/**
 * 把一次器件响应的符号数据解析成 NormalizedSymbol。
 *
 * - 单段器件：图形在 `dataStr` 里（RP2040 / LM393 等绝大多数器件）。
 * - 多子部件器件：`dataStr.shape` 为空，图形逐段在 `subparts[].dataStr` 里，
 *   每段对应 OLB 里的一个 LibPart（A/B/C…），用户 2026-10-23 报的 C18221391 就是这种。
 *
 * 没有符号数据（老器件 / 只有封装）时返回 null，调用方跳过 .olb 写入。
 */
export const parseEasyEdaSymbol = (
  rawDataStr: unknown,
  options: {
    readonly lcscId: string;
    readonly fallbackName: string;
    readonly pcbFootprint: string;
    /** 多子部件器件的各段（`result.subparts`），dataStr 为空时才会用到 */
    readonly subparts?: readonly EasyEdaSubpart[];
  },
): NormalizedSymbol | null => {
  const fallbackSymbol = `SYM_${options.lcscId}`;
  const partOptions = {
    fallbackName: options.fallbackName,
    fallbackSymbol,
    lcscId: options.lcscId,
  };

  const candidates: { readonly part: ParsedPart; readonly title: string | undefined }[] = [];
  const primary = parsePart(rawDataStr, partOptions);
  if (primary !== null) {
    candidates.push({ part: primary, title: undefined });
  } else {
    // 多子部件：dataStr 只是空壳，逐段取 subparts。空段（只有电源脚/无图形）直接跳过。
    for (const subpart of options.subparts ?? []) {
      const part = parsePart(subpart.dataStr, partOptions);
      if (part !== null) {
        candidates.push({ part, title: subpart.title });
      }
    }
  }
  if (candidates.length === 0) {
    return null;
  }

  const symbolName = candidates[0].part.name;
  const multiSection = candidates.length > 1;
  const sections = candidates.map(({ part, title }, index) =>
    buildSection(
      part,
      // 段名只用于界面标签 / React key，必须唯一：优先用源 subpart 标题（AGM609MNA.1）。
      multiSection ? title?.trim() || `${symbolName}.${index + 1}` : symbolName,
    ),
  );

  const symbol: NormalizedSymbol = {
    name: symbolName,
    refdesPrefix: candidates[0].part.refdesPrefix,
    pcbFootprint: options.pcbFootprint,
    sections,
    sourceJson: JSON.stringify({
      source: "easyeda-standard-symbol",
      lcscId: options.lcscId,
      pinCount: sections.reduce((total, section) => total + section.pins.length, 0),
      shapeCount: sections.reduce((total, section) => total + section.shapes.length, 0),
      sectionNames: sections.map((section) => section.name),
    }),
  };
  return NormalizedSymbolSchema.parse(symbol);
};
