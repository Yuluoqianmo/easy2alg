import type {
  NormalizedSymbol,
  NormalizedSymbolPin,
  NormalizedSymbolSection,
  NormalizedSymbolShape,
  SymbolPinType,
} from "../../shared/schemas";
import {
  bodyBoxOf,
  estimateCommentWidth,
  pinSideOf,
  symbolFontHeight,
} from "../../shared/symbol-labels";
import { snapPinsToGrid } from "../../shared/symbol-layout";

/**
 * OrCAD Capture 库 XML（.olb 交换格式）生成器。
 *
 * 结构与取值全部来自**真实导出件**（用 XMATIC_OLB2XML 把用户现有 .olb 导出成
 * XML 反推），不是猜的。几处踩过的坑，改动前务必保留：
 *
 *  1. `<PhysicalPart>` 必须嵌在 `<LibPart>` 内、位于 `<NormalView>` 之后。
 *     挂成 `<Package>` 的子节点时 XMATIC_XML2OLB 报
 *     `ERROR(SPSMI-1): ... no declaration found for element 'PhysicalPart'`。
 *  2. `<DefaultValues>` 可选（实测有不带的可用导出件），本生成器不产出。
 *  3. 单段器件 `CellName = Package 名`、`alphabeticNumbering="2"`、
 *     `isHomogeneous="1"`；多段器件 `CellName = Package 名 + 段号字母`、
 *     `alphabeticNumbering="1"`、`isHomogeneous="0"`。均已用现网库对照确认。
 *  4. 坐标单位 1 = 10 mil，源库（立创EDA专业版 SYMBOL 文档）同单位，**不缩放**。
 */

/** Capture 引脚类型码（取自本机 OrCAD Pin Type 下拉顺序）。 */
const PIN_TYPE_CODE: Record<SymbolPinType, number> = {
  input: 0,
  bidirectional: 1,
  output: 2,
  openCollector: 3,
  passive: 4,
  tristate: 5,
  openEmitter: 6,
  power: 7,
  // Capture 只有上述 8 种，未指定的引脚落到最中性的无源。
  unspecified: 4,
};

const SHAPE_FILL_STYLE = "1";
const SHAPE_HATCH_STYLE = "-1";
const SHAPE_LINE_STYLE = "0";
const SHAPE_LINE_WIDTH = "0";

/** 真实库中 CommentText 的通用字体（本机导出件里 685/697 处均为该值）。 */
const COMMENT_FONT_NAME = "Arial";
const COMMENT_FONT_WIDTH = 4;

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const tag = (name: string, attributes: Readonly<Record<string, string | number>>): string => {
  const rendered = Object.entries(attributes)
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
    .join(" ");
  return `  <${name} ${rendered} />`;
};

const render = (value: number): string => {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/0+$/, "");
};

/**
 * 坐标必须落在 Capture 的符号网格上（1 单位 = 10 mil），**XML 里只接受整数**：
 * `x1="6.449"` 会让 XMATIC_XML2OLB 直接报
 * `value '6.5' does not match regular expression facet '[+\-]?[0-9]+'` 并整库导入失败。
 *
 * 立创的图形允许半单位坐标（椭圆按 24 边形近似后必然出小数），所以写入前统一取整。
 * 实测案例：C2866150（LMK00301ARHST）带一个半径 1.5 的极性圆点，近似后 88 个坐标
 * 带小数 → 整个符号写不进去；取整后 49 脚全部正常入库。
 */
const grid = (value: number): string => render(Math.round(value));

const sectionSuffix = (index: number): string => {
  // 0→A、1→B … 25→Z，超过 26 段用 AA/AB（Cadence 自身也只到字母段）。
  let remaining = index;
  let suffix = "";
  do {
    suffix = String.fromCharCode(65 + (remaining % 26)) + suffix;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return suffix;
};

const fontHeightFor = (sourceHeight: number): number => {
  // 源 fontSize 是符号单位（10 mil）下的字高，实测 12 对应 OrCAD 的 -9。
  // 按 0.75 折算并夹到真实库常见区间，避免出现超大字号。
  return symbolFontHeight(sourceHeight);
};

/**
 * 文本方向：源 rotation（立创的 90° 整数倍，逆时针）→ Capture 的 TextFont 两个字段。
 *
 * **关键是 `escapement`（单位：0.1°），不是 `orientation`**（用户 2026-10-19 手改样本
 * 给出的铁证）：Capture 里手动把 JTAG 转 90° 之后，导出的 TextFont 是
 * `escapement="900" orientation="90"`；而我们把 orientation 写成 90、escapement 留 0，
 * 生成的文本在 Capture 里始终是横排。两者按同一份样本照抄：escapement = 10×角度。
 */
const textOrientation = (rotation: number): number => {
  const snapped = Math.round(rotation / 90) * 90;
  return ((snapped % 360) + 360) % 360;
};

/** escapement 用 0.1° 为单位（900 = 90°）。 */
const textEscapement = (rotation: number): number => textOrientation(rotation) * 10;

/**
 * 注释文字的包围盒（x1/x2/y1/y2）。
 *
 * 竖排不是"横框加个 orientation"，而是把整个框绕锚点**刚性旋转** —— 90° 时文字
 * 向上读，框变成"窄而高"（与预览里 `rotate(-rotation)` 的效果一致）。
 *
 * **loc 必须取框的最小角**（用户 2026-10-19 手改对照得出的结论）：Capture 自己保存
 * 竖排文本时 locX/locY 就是 x1/y1。XMATIC 导入时若 loc 不在最小角，会**按横排把包围盒
 * 重算一遍**，竖排就丢了（实测：喂 loc=(x1,y2)、框 14×20，回读成了 24×14 的横框；
 * 改成 loc=(x1,y1) 后同样的框原样回读）。
 */
const commentTextBox = (
  at: { readonly x: number; readonly y: number },
  width: number,
  boxHeight: number,
  orientation: number,
): { readonly x1: number; readonly x2: number; readonly y1: number; readonly y2: number } => {
  switch (orientation) {
    case 90:
      return { x1: at.x, x2: at.x + boxHeight, y1: at.y - width, y2: at.y };
    case 180:
      return { x1: at.x - width, x2: at.x, y1: at.y - boxHeight, y2: at.y };
    case 270:
      return { x1: at.x - boxHeight, x2: at.x, y1: at.y, y2: at.y + width };
    default:
      return { x1: at.x, x2: at.x + width, y1: at.y, y2: at.y + boxHeight };
  }
};

const commentTextCommands = (shape: Extract<NormalizedSymbolShape, { kind: "text" }>): string => {
  const height = fontHeightFor(shape.height);
  const width = estimateCommentWidth(shape.text, height);
  const boxHeight = Math.round(height * 1.556);
  const orientation = textOrientation(shape.rotation);
  const box = commentTextBox(shape.at, width, boxHeight, orientation);
  const lines = [
    tag("Defn", {
      locX: grid(Math.min(box.x1, box.x2)),
      locY: grid(Math.min(box.y1, box.y2)),
      name: shape.text,
      textJustification: 0,
      x1: grid(box.x1),
      x2: grid(box.x2),
      y1: grid(box.y1),
      y2: grid(box.y2),
    }),
  ];
  return [
    "    <CommentText>",
    ...lines,
    "      <TextFont>",
    tag("Defn", {
      charset: 0,
      escapement: textEscapement(shape.rotation),
      height: -height,
      italic: 0,
      name: COMMENT_FONT_NAME,
      orientation,
      weight: 400,
      width: COMMENT_FONT_WIDTH,
    }),
    "      </TextFont>",
    "    </CommentText>",
  ].join("\n");
};

const shapeCommands = (shape: NormalizedSymbolShape): readonly string[] => {
  if (shape.kind === "rect") {
    return [
      "    <Rect>",
      tag("Defn", {
        fillStyle: SHAPE_FILL_STYLE,
        hatchStyle: SHAPE_HATCH_STYLE,
        lineStyle: SHAPE_LINE_STYLE,
        lineWidth: SHAPE_LINE_WIDTH,
        x1: grid(shape.min.x),
        x2: grid(shape.max.x),
        y1: grid(shape.min.y),
        y2: grid(shape.max.y),
      }),
      "    </Rect>",
    ];
  }
  if (shape.kind === "polyline") {
    const points = shape.closed ? [...shape.points, shape.points[0]] : shape.points;
    const commands: string[] = [];
    for (let index = 0; index + 1 < points.length; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      commands.push(
        "    <Line>",
        tag("Defn", {
          lineStyle: SHAPE_LINE_STYLE,
          lineWidth: SHAPE_LINE_WIDTH,
          x1: grid(start.x),
          x2: grid(end.x),
          y1: grid(start.y),
          y2: grid(end.y),
        }),
        "    </Line>",
      );
    }
    return commands;
  }
  return [commentTextCommands(shape)];
};

const pinCommands = (pin: NormalizedSymbolPin, position: number): readonly string[] => [
  "    <SymbolPinScalar>",
  tag("Defn", {
    hotptX: grid(pin.connection.x),
    hotptY: grid(pin.connection.y),
    name: pin.name,
    position,
    startX: grid(pin.body.x),
    startY: grid(pin.body.y),
    type: PIN_TYPE_CODE[pin.type],
    visible: pin.visible ? 1 : 0,
  }),
  ...(
    [
      ["IsLong", 0],
      ["IsClock", 0],
      ["IsDot", 0],
      ["IsLeftPointing", 0],
      ["IsRightPointing", 0],
      ["IsNetStyle", 0],
      ["IsNoConnect", 0],
      ["IsGlobal", 0],
      ["IsNumberVisible", 1],
    ] as const
  ).flatMap(([name, value]) => [
    `      <${name}>`,
    `        <Defn val="${value}" />`,
    `      </${name}>`,
  ]),
  "    </SymbolPinScalar>",
];

const displayPropCommands = (
  name: string,
  locX: number,
  locY: number,
): readonly string[] => [
  "      <SymbolDisplayProp>",
  tag("Defn", {
    locX: grid(locX),
    locY: grid(locY),
    name,
    rotation: 0,
    textJustification: 0,
  }),
  "        <PropFont>",
  tag("Defn", {
    charset: 0,
    escapement: 0,
    height: -9,
    italic: 0,
    name: "",
    orientation: 0,
    weight: 400,
    width: 4,
  }),
  "        </PropFont>",
  "        <PropColor>",
  '          <Defn val="48" />',
  "        </PropColor>",
  "        <PropDispType>",
  tag("Defn", { ValueIfValueExist: 0, val: 1 }),
  "        </PropDispType>",
  "      </SymbolDisplayProp>",
];

const hasVerticalPins = (section: NormalizedSymbolSection): boolean =>
  section.pins.some((pin) => {
    const side = pinSideOf(pin);
    return side === "top" || side === "bottom";
  });

const normalViewCommands = (
  symbol: NormalizedSymbol,
  section: NormalizedSymbolSection,
): readonly string[] => {
  const body = bodyBoxOf(section);
  // 全局旋转规则：**有上下边引脚时必须置 1**，否则它们的名字会被水平画出、
  // 和相邻竖排标签糊在一起。重叠问题由 shared/symbol-layout.ts 的几何避让解决
  // —— 逐脚 PinDisplayProp 那条路实测无效（见该文件注释）。
  const commands: string[] = ["      <NormalView>", '        <Defn suffix=".Normal" />'];
  // "Part Reference" 贴在本体上方、"Value" 贴在本体下方 —— 坐标与现网库一致
  // （y 轴在编辑器里向下，所以 minY-14 在屏幕上位于本体上侧）。
  commands.push(...displayPropCommands("Part Reference", body.minX + 7, body.minY - 14));
  commands.push(...displayPropCommands("Value", body.minX + 7, body.maxY + 4));
  commands.push(
    "        <SymbolColor>",
    '          <Defn val="48" />',
    "        </SymbolColor>",
    "        <SymbolBBox>",
    tag("Defn", {
      x1: grid(body.minX),
      x2: grid(body.maxX),
      y1: grid(body.minY),
      y2: grid(body.maxY),
    }),
    "        </SymbolBBox>",
    "        <IsPinNumbersVisible>",
    '          <Defn val="1" />',
    "        </IsPinNumbersVisible>",
    "        <IsPinNamesRotated>",
    `          <Defn val="${hasVerticalPins(section) ? 1 : 0}" />`,
    "        </IsPinNamesRotated>",
    "        <IsPinNamesVisible>",
    '          <Defn val="1" />',
    "        </IsPinNamesVisible>",
    "        <ContentsLibName>",
    '          <Defn name="" />',
    "        </ContentsLibName>",
    "        <ContentsViewName>",
    '          <Defn name="" />',
    "        </ContentsViewName>",
    "        <ContentsViewType>",
    '          <Defn type="0" />',
    "        </ContentsViewType>",
    "        <PartValue>",
    '          <Defn name="" />',
    "        </PartValue>",
    "        <Reference>",
    tag("Defn", { name: symbol.refdesPrefix }),
    "        </Reference>",
  );
  for (const shape of section.shapes) {
    // 用户在预览里删掉的注释文本：留位（下标稳定）但不写进库
    if (shape.kind === "text" && shape.hidden === true) {
      continue;
    }
    commands.push(...shapeCommands(shape));
  }
  section.pins.forEach((pin, index) => {
    commands.push(...pinCommands(pin, index));
  });
  commands.push("      </NormalView>");
  return commands;
};

/**
 * 生成可直接交给 XMATIC_XML2OLB 的 Capture 库 XML。
 *
 * `libraryPath` 会写进根 `<Defn name=...>`：实测必须与目标 .olb 的实际路径一致
 * （导入器按它定位要写入的库），务必传绝对路径。
 */
export const buildCaptureLibraryXml = (
  symbol: NormalizedSymbol,
  libraryPath: string,
  options: { readonly fillPcbFootprint?: boolean; readonly snapPins?: boolean } = {},
): string => {
  // 写库出口统一吸附：解析阶段已对齐过一次，但用户可能在预览里手动拖过元素
  // （offset 是任意小数）。不吸附的话生成出来的引脚在 Capture 里接不上线。
  // 用户 2026-10-20 定：**跟随界面吸附开关** —— 关掉后按实际坐标写（仍取整）。
  const sections =
    options.snapPins === false ? symbol.sections : symbol.sections.map(snapPinsToGrid);
  const multiSection = sections.length > 1;
  const now = Math.floor(Date.now() / 1000);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    '<Lib xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="olb.xsd">',
    "",
    tag("Defn", { name: libraryPath }),
    "",
    "  <Package>",
    tag("Defn", {
      alphabeticNumbering: multiSection ? 1 : 2,
      isHomogeneous: multiSection ? 0 : 1,
      name: symbol.name,
      // 用户 2026-10-19 要求可选：关掉时留空，Capture 里就是空字段
      pcbFootprint: options.fillPcbFootprint === false ? "" : symbol.pcbFootprint,
      pcbLib: "",
      refdesPrefix: symbol.refdesPrefix,
      timestamp: now,
      timezone: "0800",
    }),
  ];
  sections.forEach((section, index) => {
    lines.push(
      "    <LibPart>",
      tag("Defn", {
        CellName: multiSection ? `${symbol.name}${sectionSuffix(index)}` : symbol.name,
      }),
      ...normalViewCommands({ ...symbol, sections }, section),
      "      <PhysicalPart>",
      "        <Defn />",
      ...section.pins.map((pin, pinIndex) =>
        [
          "        <PinNumber>",
          tag("Defn", { number: pin.number, position: pinIndex }),
          "        </PinNumber>",
        ].join("\n"),
      ),
      "      </PhysicalPart>",
      "    </LibPart>",
    );
  });
  lines.push("  </Package>", "</Lib>", "");
  return lines.join("\n");
};
