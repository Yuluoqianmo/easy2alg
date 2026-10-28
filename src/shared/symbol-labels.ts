import type { NormalizedSymbolPin, NormalizedSymbolSection } from "./schemas";
import { isSymbolPinKey, parseSymbolEditKey, symbolPinKey, symbolShapeKey } from "./symbol-edit";

/**
 * Capture 画引脚名/引脚号的规则 —— 预览、避让计算、写 OLB、验收测试共用同一份。
 *
 * 规则来自实机截图的像素测量（用户 2026-10-16 截图 + 标定过的 px/单位）：
 *
 *  1. **引脚名在**本体**内侧**、沿引脚方向排：左右引脚横排，上下引脚竖排。
 *     名字首端离本体边缘约 5 单位（`SYMBOL_LABEL_OFFSET`）。
 *  2. **引脚号在本体外侧**、紧贴本体边缘，同样沿引脚方向排。
 *  3. 字宽实测 ≈ 4.9 单位/字符（height=-9 的 Arial），下行取 5；
 *     窄字符（i/l/1/./:）约 2。字高约 7~8 单位，故文字半宽取 4。
 *
 * 重叠就是这么来的：竖排名字从本体的上/下边**往本体内部**长，横排名字从
 * 左/右边**往本体内部**长，两者在**四角**必然相交 —— 立创EDA 的本体是按比
 * Capture 小得多的字宽设计的。避让算法见 shared/symbol-layout.ts。
 */

/** 文字离本体边缘的留白。 */
export const SYMBOL_LABEL_OFFSET = 5;
/** 文字半高；竖排时它就是文字在水平方向占的半宽。 */
export const SYMBOL_LABEL_HALF = 4;
/** 两组标签之间要求的最小间隙。 */
export const SYMBOL_LABEL_CLEARANCE = 4;

/**
 * 符号文本的**默认/最小字号**（符号单位，1 单位 = 10 mil）。
 *
 * 源数据给不出可用字号（缺失、太小）时兜底用这个值 —— 两条链路
 * （立创在线 easyeda-symbol / 本地库 elibz2）共用，避免各写一个魔数。
 * 用户 2026-10-16 要求：7（原先在线链路写死 6）。
 */
export const DEFAULT_SYMBOL_TEXT_HEIGHT = 7;

const NARROW_CHARACTERS = "ilI1|!.,:;'` ";
const NARROW_WIDTH = 2;
/** 实测：`PEX_NT_PERST#`(13 字符) 占 64 单位 → 4.9/字符。取 5 留余量。 */
const NORMAL_WIDTH = 5;

export const estimateLabelWidth = (text: string): number =>
  [...text].reduce(
    (total, character) => total + (NARROW_CHARACTERS.includes(character) ? NARROW_WIDTH : NORMAL_WIDTH),
    0,
  );

/**
 * 源 `fontSize`（符号单位）→ Capture 的 CommentText 字号。
 *
 * **不再打折**（2026-10-19，用户第三次反馈"生成的尺寸和预览有差异"）：原先按 0.75
 * 折算（源 12 → Capture 9），预览却按源字号画，于是 Capture 里每一条标注都比预览
 * 小一号。.olb 的字高和符号坐标是同一个单位（10 mil），直接用源字号才是所见即所得；
 * 手改样本也对得上：height=-9 的 "JTAG" 框高 14 = round(9×1.556)。
 *
 * 上下限只防退化（源数据缺失时兜底 8，超长标题不让它盖住整个符号）。
 */
export const symbolFontHeight = (sourceHeight: number): number =>
  Math.min(Math.max(Math.round(sourceHeight), 8), 40);

/**
 * CommentText 的横向占宽。
 *
 * 实机标定：源 height=12（→ Capture 9）的 "Configuration Strap pins"（23 字符）
 * 实际占 ≈97 单位 → 4.2 单位/字符；源 height=20（→ Capture 15）的 "PEX8748"
 * 明显更大。字宽随字号等比放大，取 0.55 这个中间比例（两处实测分别为 0.47 / 0.61）。
 */
const COMMENT_WIDTH_RATIO = 0.55;

export const estimateCommentWidth = (text: string, height: number): number =>
  Math.max(Math.round(text.length * height * COMMENT_WIDTH_RATIO), height);

export type SymbolBox = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

const normalize = (box: SymbolBox): SymbolBox => ({
  minX: Math.min(box.minX, box.maxX),
  minY: Math.min(box.minY, box.maxY),
  maxX: Math.max(box.minX, box.maxX),
  maxY: Math.max(box.minY, box.maxY),
});

/** 一组点的包围盒（点数组 → SymbolBox）。 */
const boxOfPoints = (points: readonly { readonly x: number; readonly y: number }[]): SymbolBox => {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
};

export const boxesOverlap = (a: SymbolBox, b: SymbolBox, slack = 0): boolean =>
  a.minX < b.maxX - slack &&
  b.minX < a.maxX - slack &&
  a.minY < b.maxY - slack &&
  b.minY < a.maxY - slack;

/**
 * 图形包围盒：只算 RECT / 折线，**不含引脚桩**，也不算文字标注。
 *
 * 三极管、MOSFET、二极管、连接器这类符号没有矩形本体，本体就是这堆折线。
 * 若拿整段 bounds（含 10 单位引脚桩）当本体，引脚名会被摆到引脚末端、脚号跑到框外
 * —— 用户 2026-10-23 截图里的 C18221391 就是这样（预览和导出的 OLB 同时错）。
 */
const drawingBoxOf = (section: NormalizedSymbolSection): SymbolBox | null => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const shape of section.shapes) {
    if (shape.kind === "rect") {
      xs.push(shape.min.x, shape.max.x);
      ys.push(shape.min.y, shape.max.y);
    } else if (shape.kind === "polyline") {
      for (const point of shape.points) {
        xs.push(point.x);
        ys.push(point.y);
      }
    }
  }
  if (xs.length === 0) {
    return null;
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
};

/**
 * 本体包围盒：优先 RECT；没有 RECT 时用**图元包围盒**（不是整段 bounds）；
 * 连图元都没有才退到整段 bounds。
 */
export const bodyBoxOf = (section: NormalizedSymbolSection): SymbolBox => {
  const rect = section.shapes.find((shape) => shape.kind === "rect");
  if (rect !== undefined && rect.kind === "rect") {
    return normalize({ minX: rect.min.x, minY: rect.min.y, maxX: rect.max.x, maxY: rect.max.y });
  }
  return normalize(drawingBoxOf(section) ?? section.bounds);
};

export type PinSide = "left" | "right" | "top" | "bottom";

/** 引脚朝向：比较连接端与本体端，取位移较大的那一轴。 */
export const pinSideOf = (pin: NormalizedSymbolPin): PinSide => {
  const dx = pin.body.x - pin.connection.x;
  const dy = pin.body.y - pin.connection.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? "left" : "right";
  }
  return dy >= 0 ? "top" : "bottom";
};

export const pinIsVertical = (pin: NormalizedSymbolPin): boolean => {
  const side = pinSideOf(pin);
  return side === "top" || side === "bottom";
};

/** 引脚名占位（本体内侧）。 */
export const pinNameBox = (pin: NormalizedSymbolPin, body: SymbolBox): SymbolBox => {
  const box = normalize(body);
  const width = estimateLabelWidth(pin.name);
  switch (pinSideOf(pin)) {
    case "left":
      return {
        minX: box.minX + SYMBOL_LABEL_OFFSET,
        maxX: box.minX + SYMBOL_LABEL_OFFSET + width,
        minY: pin.body.y - SYMBOL_LABEL_HALF,
        maxY: pin.body.y + SYMBOL_LABEL_HALF,
      };
    case "right":
      return {
        minX: box.maxX - SYMBOL_LABEL_OFFSET - width,
        maxX: box.maxX - SYMBOL_LABEL_OFFSET,
        minY: pin.body.y - SYMBOL_LABEL_HALF,
        maxY: pin.body.y + SYMBOL_LABEL_HALF,
      };
    case "top":
      // 竖排：从本体上边往下长
      return {
        minX: pin.body.x - SYMBOL_LABEL_HALF,
        maxX: pin.body.x + SYMBOL_LABEL_HALF,
        minY: box.minY + SYMBOL_LABEL_OFFSET,
        maxY: box.minY + SYMBOL_LABEL_OFFSET + width,
      };
    default:
      // 竖排：从本体下边往上长
      return {
        minX: pin.body.x - SYMBOL_LABEL_HALF,
        maxX: pin.body.x + SYMBOL_LABEL_HALF,
        minY: box.maxY - SYMBOL_LABEL_OFFSET - width,
        maxY: box.maxY - SYMBOL_LABEL_OFFSET,
      };
  }
};

/** 引脚号占位（本体外侧，紧贴本体边缘）。 */
export const pinNumberBox = (pin: NormalizedSymbolPin, body: SymbolBox): SymbolBox => {  const box = normalize(body);
  const width = estimateLabelWidth(pin.number);
  switch (pinSideOf(pin)) {
    case "left":
      return {
        minX: box.minX - SYMBOL_LABEL_OFFSET - width,
        maxX: box.minX - SYMBOL_LABEL_OFFSET,
        minY: pin.body.y - SYMBOL_LABEL_HALF,
        maxY: pin.body.y + SYMBOL_LABEL_HALF,
      };
    case "right":
      return {
        minX: box.maxX + SYMBOL_LABEL_OFFSET,
        maxX: box.maxX + SYMBOL_LABEL_OFFSET + width,
        minY: pin.body.y - SYMBOL_LABEL_HALF,
        maxY: pin.body.y + SYMBOL_LABEL_HALF,
      };
    case "top":
      return {
        minX: pin.body.x - SYMBOL_LABEL_HALF,
        maxX: pin.body.x + SYMBOL_LABEL_HALF,
        minY: box.minY - SYMBOL_LABEL_OFFSET - width,
        maxY: box.minY - SYMBOL_LABEL_OFFSET,
      };
    default:
      return {
        minX: pin.body.x - SYMBOL_LABEL_HALF,
        maxX: pin.body.x + SYMBOL_LABEL_HALF,
        minY: box.maxY + SYMBOL_LABEL_OFFSET,
        maxY: box.maxY + SYMBOL_LABEL_OFFSET + width,
      };
  }
};

/** 预览里引脚名/脚号用的字号（世界单位）。Capture 两侧同为 height≈9。 */
export const SYMBOL_PIN_FONT = 9;

/**
 * 段内引脚标签（名字 / 脚号）是否互相压住。
 *
 * 用途：Capture 的引脚字号固定 9 单位、不随符号大小变；本体只有 20 单位高的
 * 三极管/MOSFET，名字从上下两边往中间长，必然撞在一起。解析阶段据此决定
 * 要不要把整段放大（见 easyeda-symbol.ts 的 buildSection）。
 */
export const sectionLabelsCollide = (section: NormalizedSymbolSection): boolean => {
  const body = bodyBoxOf(section);
  const boxes = section.pins.flatMap((pin) => [pinNameBox(pin, body), pinNumberBox(pin, body)]);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (boxesOverlap(boxes[i], boxes[j])) {
        return true;
      }
    }
  }
  return false;
};

/** 引脚文字锚点：名字/编号各一个定位点（预览的 `placeLabel` 用）。 */
export type PinLabelAnchor = {
  readonly name: { readonly x: number; readonly y: number };
  readonly number: { readonly x: number; readonly y: number };
};

/**
 * 从当前本体盒推导出这个引脚两个文字的定位点。
 *
 * 与预览的 `placeLabel` 一一对应（左/右引脚取名字盒的内侧边，上下引脚取名字盒的外端、
 * x 用引脚自己的 x）；解析时调用一次后**冻结**到引脚上（见 schemas 里的 labelAnchor）。
 */
export const pinLabelAnchors = (pin: NormalizedSymbolPin, body: SymbolBox): PinLabelAnchor => {
  const nameBox = pinNameBox(pin, body);
  const numberBox = pinNumberBox(pin, body);
  switch (pinSideOf(pin)) {
    case "left":
      return {
        name: { x: nameBox.minX, y: pin.body.y },
        number: { x: numberBox.maxX, y: pin.body.y },
      };
    case "right":
      return {
        name: { x: nameBox.maxX, y: pin.body.y },
        number: { x: numberBox.minX, y: pin.body.y },
      };
    default:
      return {
        name: { x: pin.body.x, y: nameBox.maxY },
        number: { x: pin.body.x, y: numberBox.maxY },
      };
  }
};

/**
 * 把锚点冻结到段里每个引脚上。放在**去重与避让之后**调用：避让会挪引脚/加宽本体，
 * 锚点必须反映最终几何。
 */
export const attachPinLabelAnchors = (
  section: NormalizedSymbolSection,
): NormalizedSymbolSection => {
  const body = bodyBoxOf(section);
  return {
    ...section,
    pins: section.pins.map((pin) => ({ ...pin, labelAnchor: pinLabelAnchors(pin, body) })),
  };
};

/**
 * 文字锚点 → 占位盒（框选命中用）。
 *
 * `endAnchored` = 文字从锚点往左延伸（右侧引脚的名字、左侧引脚的脚号），
 * 竖排（rotated）= 往上方延伸。宽度按 `estimateLabelWidth`、高度按 `SYMBOL_PIN_FONT`。
 * 与预览画出来的东西对齐，不要求像素级精确 —— 框选碰到就算选中。
 */
export const anchorLabelBox = (
  anchor: { readonly x: number; readonly y: number },
  text: string,
  rotated: boolean,
  endAnchored: boolean,
): SymbolBox => {
  const width = estimateLabelWidth(text);
  const half = SYMBOL_PIN_FONT / 2;
  if (rotated) {
    return { minX: anchor.x - half, maxX: anchor.x + half, minY: anchor.y - width, maxY: anchor.y };
  }
  const baseline = SYMBOL_PIN_FONT * 0.25;
  return {
    minX: endAnchored ? anchor.x - width : anchor.x,
    maxX: endAnchored ? anchor.x : anchor.x + width,
    minY: anchor.y - (SYMBOL_PIN_FONT - baseline),
    maxY: anchor.y + baseline,
  };
};

/**
 * 注释文字（CommentText）的占位矩形。
 *
 * 说明：Capture 把它按 `locX/locY + 字号` 排，纵向基准与 x1/x2/y1/y2 的语义
 * 没有官方文档，这里取"左上角起算、高度 = 字号"的保守近似 —— 只用来判断
 * "挪一下会不会压到引脚标签"，宁大勿小。
 */
/**
 * CommentText 的占位盒（含旋转）。
 *
 * 竖排（rotation 90/270）时**不能按横排算** —— 宽 = 字高、高 = 文本长度，否则
 * 避让会拿一条横着扫过去的长条去判冲突（实测会误报"Hot Plug/Multfunction pins
 * 压在引脚名上"）。锚点约定与写库一致：`at` 是文字起点，框沿阅读方向铺开。
 */
export const commentTextBox = (shape: {
  readonly at: { readonly x: number; readonly y: number };
  readonly height: number;
  readonly text: string;
  readonly rotation?: number;
}): SymbolBox => {
  const height = symbolFontHeight(shape.height);
  const width = estimateCommentWidth(shape.text, height);
  const quarter = Math.round((shape.rotation ?? 0) / 90) % 4;
  if (quarter === 1 || quarter === 3) {
    // 90°：文字自下而上，框向上铺；270°：自上而下，框向下铺
    return quarter === 1
      ? { minX: shape.at.x, maxX: shape.at.x + height, minY: shape.at.y - width, maxY: shape.at.y }
      : { minX: shape.at.x, maxX: shape.at.x + height, minY: shape.at.y, maxY: shape.at.y + width };
  }
  return {
    minX: shape.at.x,
    minY: shape.at.y,
    maxX: shape.at.x + width,
    maxY: shape.at.y + height,
  };
};

/**
 * 预览/「适应窗口」用的包围盒：在本体包围盒上并入伸到本体外面的引脚号
 * （竖排的引脚号可以比特意加长的引脚还长），否则会被裁掉。
 */
export const sectionPreviewBounds = (section: NormalizedSymbolSection): SymbolBox => {
  const body = normalize(section.bounds);
  let { minX, minY, maxX, maxY } = body;
  // 图元（本体被拖大、折线/文字被拖出界）也要并进来 —— 只取 section.bounds 是
  // 解析阶段的静态值，"缩放到选中/适应窗口"会把编辑后的内容裁掉（用户 2026-10-20）。
  section.shapes.forEach((_shape, index) => {
    const box = symbolElementBox(section, symbolShapeKey(0, index));
    if (box === null) {
      return;
    }
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
  });
  const rect = bodyBoxOf(section);
  for (const pin of section.pins) {
    const box = pinNumberBox(pin, rect);
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
    // 引脚线本身也要算（尤其是被拖到本体外的引脚）
    minX = Math.min(minX, pin.connection.x, pin.body.x);
    minY = Math.min(minY, pin.connection.y, pin.body.y);
    maxX = Math.max(maxX, pin.connection.x, pin.body.x);
    maxY = Math.max(maxY, pin.connection.y, pin.body.y);
  }
  return { minX, minY, maxX, maxY };
};

/** 一组编辑键的并集包围盒（"缩放到选中"用）；没有可命中的元素返回 null。 */
export const selectionBox = (
  section: NormalizedSymbolSection,
  keys: readonly string[],
): SymbolBox | null => {
  let result: SymbolBox | null = null;
  for (const key of keys) {
    const box = symbolElementBox(section, key);
    if (box === null) {
      continue;
    }
    result =
      result === null
        ? box
        : {
            minX: Math.min(result.minX, box.minX),
            minY: Math.min(result.minY, box.minY),
            maxX: Math.max(result.maxX, box.maxX),
            maxY: Math.max(result.maxY, box.maxY),
          };
  }
  return result;
};

/**
 * 一个可编辑元素在符号里的**近似占位盒** —— 框选（橡皮筋选择）用它命中判断。
 *
 * 与预览画出来的东西一一对应：
 *  - rect      → 本体四边；
 *  - polyline  → 折线各点的包围盒；
 *  - text      → `commentTextBox`（与写库同一份模型）；
 *  - 引脚      → 引脚线 + 名字盒 + 号盒三者并集。
 *
 * 用近似盒而不是精确几何：框选本来就允许"框到就算选中"，
 * 而对带透明命中区的元素（引脚/文字）近似盒反而更符合手感。
 */
export const symbolElementBox = (
  section: NormalizedSymbolSection,
  key: string,
): SymbolBox | null => {
  const { index } = parseSymbolEditKey(key);
  if (isSymbolPinKey(key)) {
    const pin = section.pins[index];
    if (pin === undefined) {
      return null;
    }
    const side = pinSideOf(pin);
    const rotated = side === "top" || side === "bottom";
    // 有冻结锚点就按锚点算（跟屏幕上看到的一致）；老数据退化到本体盒推导
    const labelBoxes =
      pin.labelAnchor === undefined
        ? (() => {
            const body = bodyBoxOf(section);
            return [pinNameBox(pin, body), pinNumberBox(pin, body)];
          })()
        : [
            anchorLabelBox(pin.labelAnchor.name, pin.name, rotated, side === "right"),
            anchorLabelBox(pin.labelAnchor.number, pin.number, rotated, side === "left"),
          ];
    return [...labelBoxes, boxOfPoints([pin.connection, pin.body])].reduce(
      (acc, box) => ({
        minX: Math.min(acc.minX, box.minX),
        minY: Math.min(acc.minY, box.minY),
        maxX: Math.max(acc.maxX, box.maxX),
        maxY: Math.max(acc.maxY, box.maxY),
      }),
    );
  }
  const shape = section.shapes[index];
  if (shape === undefined) {
    return null;
  }
  switch (shape.kind) {
    case "rect":
      return normalize({ minX: shape.min.x, minY: shape.min.y, maxX: shape.max.x, maxY: shape.max.y });
    case "polyline":
      return boxOfPoints(shape.points);
    default:
      // 已删除（隐藏）的文本不参与框选/命中
      if (shape.hidden === true) {
        return null;
      }
      // 文字用**预览画出来的占位**（基线在 at.y，字形向上长），而不是写库模型的
      // commentTextBox（基线向下）—— 框选要跟着眼睛看到的走，两者差整整一个字高。
      return normalize({
        minX: shape.at.x,
        minY: shape.at.y - shape.height,
        maxX: shape.at.x + estimateLabelWidth(shape.text) * (shape.height / 9) * 1.15,
        maxY: shape.at.y + shape.height * 0.25,
      });
  }
};

/** 两个盒是否相交（框选命中判据：碰到就算选中）。 */
export const boxesIntersect = (a: SymbolBox, b: SymbolBox): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

/**
 * 框选：返回本段里落在 `box` 内的所有元素键（图形 + 引脚）。
 * 键要带上真实的段序号，才能直接喂给选中态与编辑记录。
 */
/**
 * 框选（橡皮筋）命中：返回与 `box` 相交的所有元素键。
 *
 * **本体框（rect）不参与框选** —— 用户 2026-10-19 反馈："框选引脚和引脚标签，
 * 结果本体也被带上、拖动时多出一堆东西跟着动"。框的包围盒覆盖整个符号，
 * 无论按"碰到就算"还是"越过描边"，只要框选贴着边缘就会把本体捎上，手感不可预测。
 * 所以：框选只选**内容**（引脚 / 文字 / 分隔线），本体框要用鼠标点它的线来选中
 * （选中后可用方向键移动，拖它的线则是改大小）。
 */
export const symbolKeysInBox = (
  section: NormalizedSymbolSection,
  sectionIndex: number,
  box: SymbolBox,
): readonly string[] => {
  const keys: string[] = [];
  section.shapes.forEach((shape, index) => {
    if (shape.kind === "rect") {
      return;
    }
    const key = symbolShapeKey(sectionIndex, index);
    const element = symbolElementBox(section, key);
    if (element !== null && boxesIntersect(element, box)) {
      keys.push(key);
    }
  });
  section.pins.forEach((_pin, index) => {
    const element = symbolElementBox(section, symbolPinKey(sectionIndex, index));
    if (element !== null && boxesIntersect(element, box)) {
      keys.push(symbolPinKey(sectionIndex, index));
    }
  });
  return keys;
};

/**
 * 全选（Ctrl+A）的键集合 —— **语义与框选一致**：所有引脚 + 非 rect 图形。
 *
 * 本体（rect）不参与：它的包围盒覆盖整个符号，一旦进选择集，"整体移动"就会把
 * 整个符号挪走（0.1.27 的框选也是同样取舍）。
 */
export const symbolSelectableKeys = (
  section: NormalizedSymbolSection,
  sectionIndex: number,
): readonly string[] => [
  ...section.shapes.flatMap((shape, index) =>
    shape.kind === "rect" ? [] : [symbolShapeKey(sectionIndex, index)],
  ),
  ...section.pins.map((_pin, index) => symbolPinKey(sectionIndex, index)),
];
