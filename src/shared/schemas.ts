import { z } from "zod";
import { AllegroVersionSchema, type AllegroVersion } from "./allegro-version";

// 版本号不再是固定枚举（见 shared/allegro-version.ts）：Cadence 每年发新版，
// 写死列表会让 24.1 / 25.1 既选不到、又让手动选的 allegro.exe 被判"版本未知"。
export { AllegroVersionSchema, type AllegroVersion };

/**
 * 界面偏好 —— 与转换逻辑无关，改了只重写 settings.json、不重跑 Allegro 探测。
 * 见 ipc.saveUiSettings。
 */
export const LEFT_RAIL_DEFAULT_WIDTH = 294;
export const RIGHT_RAIL_DEFAULT_WIDTH = 322;
export const LEFT_RAIL_RANGE = { min: 220, max: 560 } as const;
export const RIGHT_RAIL_RANGE = { min: 260, max: 640 } as const;

export const UiSettingsSchema = z
  .object({
    leftRailWidth: z.number().finite().min(LEFT_RAIL_RANGE.min).max(LEFT_RAIL_RANGE.max).optional(),
    rightRailWidth: z.number().finite().min(RIGHT_RAIL_RANGE.min).max(RIGHT_RAIL_RANGE.max).optional(),
    /** 已折叠的右侧分组标题（section id） */
    collapsedSections: z.array(z.string()).optional(),
    /** 图层 id → 用户自选颜色（#rrggbb） */
    layerColors: z.record(z.string(), z.string()).optional(),
    /**
     * 上次「导入本地库」选文件所在的**目录**（记住目录而不是文件：换库文件时
     * 通常就在同一个目录里挑，不用每次从头找 —— 用户 2026-10-16 要求）。
     */
    localLibraryDir: z.string().min(1).nullable().optional(),
    /** 旧字段（0.1.20 及以前记的是文件本身），读设置时迁移成它所在的目录 */
    localLibraryPath: z.string().min(1).nullable().optional(),
    /**
     * 原理图元件预览的网格吸附（用户 2026-10-20）：
     *  - enabled：磁吸开关。关掉后拖动自由，写 .olb 也按实际坐标（仍取整成整数）
     *  - grid：档位，10 单位 = 100 mil / 5 单位 = 50 mil（默认 100 mil）
     *  - visible：背景网格显示开关（独立于吸附，可以只看不吸）
     */
    symbolSnapEnabled: z.boolean().optional(),
    symbolSnapGrid: z.union([z.literal(5), z.literal(10)]).optional(),
    symbolGridVisible: z.boolean().optional(),
    /**
     * 属性面板的位置（相对画布左上角的像素，用户 2026-10-22 要求可拖动并持久化）。
     * null = 默认位置（右上角、缩放控件下方）。
     */
    symbolPropsPosition: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .nullable()
      .optional(),
  })
  .optional();

/** 取路径里的目录部分（兼容 / 与 \），拿不到返回 null。 */
export const directoryOfPath = (filePath: string | null | undefined): string | null => {
  if (filePath === null || filePath === undefined) {
    return null;
  }
  const match = /^(.*)[\\/][^\\/]+$/.exec(filePath);
  return match === null || match[1].length === 0 ? null : match[1];
};

/** 界面偏好的一套全新默认值（每次调用都返回新对象，避免共享可变引用）。 */
export const defaultUiSettings = (): UiSettings & {
  leftRailWidth: number;
  rightRailWidth: number;
  collapsedSections: string[];
  layerColors: Record<string, string>;
  localLibraryDir: string | null;
  symbolSnapEnabled: boolean;
  symbolSnapGrid: 5 | 10;
  symbolGridVisible: boolean;
  symbolPropsPosition: { x: number; y: number } | null;
} => ({
  leftRailWidth: LEFT_RAIL_DEFAULT_WIDTH,
  rightRailWidth: RIGHT_RAIL_DEFAULT_WIDTH,
  collapsedSections: [],
  layerColors: {},
  localLibraryDir: null,
  symbolSnapEnabled: true,
  symbolSnapGrid: 10,
  symbolGridVisible: true,
  symbolPropsPosition: null,
});

export const AppSettingsSchema = z
  .object({
    allegroVersion: AllegroVersionSchema,
    libraryDirectory: z.string().min(1),
    setupCompleted: z.boolean(),
    allegroExecutablePath: z.string().min(1).nullable().optional(),
    // 原理图符号库（OrCAD Capture .olb）目标路径。null = 未指定，转换时在
    // libraryDirectory/schlib 下按源库名自动新建（见 capture-writer.autoLibraryPath）。
    olbLibraryPath: z.string().min(1).nullable().optional(),
    /**
     * 输出目录结构（用户 2026-10-19 要求"可以选择使用一个文件夹"）：
     *  false = 分 padstacks/ 与 symbols/ 两个子目录（老行为）
     *  true  = 焊盘、封装（以及未指定 olbLibraryPath 时的 .olb）全部落在 libraryDirectory 下
     */
    unifiedLibraryFolder: z.boolean().optional(),
    /** 是否把 PCB 封装名写进 .olb 的 PCB Footprint 字段（用户 2026-10-19 要求可选） */
    fillPcbFootprint: z.boolean().optional(),
    ui: UiSettingsSchema,
  })
  .transform((settings) => ({
    ...settings,
    allegroExecutablePath: settings.allegroExecutablePath ?? null,
    olbLibraryPath: settings.olbLibraryPath ?? null,
    unifiedLibraryFolder: settings.unifiedLibraryFolder ?? false,
    fillPcbFootprint: settings.fillPcbFootprint ?? true,
    ui: {
      leftRailWidth: settings.ui?.leftRailWidth ?? LEFT_RAIL_DEFAULT_WIDTH,
      rightRailWidth: settings.ui?.rightRailWidth ?? RIGHT_RAIL_DEFAULT_WIDTH,
      collapsedSections: settings.ui?.collapsedSections ?? [],
      layerColors: settings.ui?.layerColors ?? {},
      // 旧配置里存的是文件路径 → 迁移成它所在的目录
      localLibraryDir:
        settings.ui?.localLibraryDir ?? directoryOfPath(settings.ui?.localLibraryPath),
      // 必须在这里补默认值：transform 没列出的字段读一次设置就消失
      symbolSnapEnabled: settings.ui?.symbolSnapEnabled ?? true,
      symbolSnapGrid: settings.ui?.symbolSnapGrid ?? 10,
      symbolGridVisible: settings.ui?.symbolGridVisible ?? true,
      symbolPropsPosition: settings.ui?.symbolPropsPosition ?? null,
    },
  }));
export type AppSettings = z.infer<typeof AppSettingsSchema>;
export type UiSettings = AppSettings["ui"];
/** 只改其中几项（拖动侧栏 / 折叠分组 / 改某个图层颜色）时用 */
export type UiSettingsPatch = Partial<UiSettings>;


export const PointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type Point = z.infer<typeof PointSchema>;

export const PadShapeSchema = z.enum([
  "rectangle",
  "roundedRectangle",
  "oval",
  "circle",
  "polygon",
]);
export type PadShape = z.infer<typeof PadShapeSchema>;

export const NormalizedPadSchema = z.object({
  number: z.string().min(1),
  center: PointSchema,
  width: z.number().positive(),
  height: z.number().positive(),
  rotation: z.number().finite(),
  shape: PadShapeSchema,
  polygon: z.array(PointSchema),
  plated: z.boolean(),
  holeWidth: z.number().nonnegative(),
  holeHeight: z.number().nonnegative(),
  sourceLayerId: z.number().int(),
});
export type NormalizedPad = z.infer<typeof NormalizedPadSchema>;

export const NormalizedLineSchema = z.object({
  start: PointSchema,
  end: PointSchema,
  width: z.number().positive(),
  layer: z.enum(["silkscreen", "assembly", "courtyard", "documentation"]),
});
export type NormalizedLine = z.infer<typeof NormalizedLineSchema>;

export const NormalizedCircleSchema = z.object({
  center: PointSchema,
  radius: z.number().positive(),
  width: z.number().positive(),
  layer: z.enum(["silkscreen", "assembly", "documentation"]),
});
export type NormalizedCircle = z.infer<typeof NormalizedCircleSchema>;

export const ThreeDModelSchema = z.object({
  name: z.string().min(1),
  uuid: z.string().min(1),
  translation: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  }),
  rotation: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  }),
});
export type ThreeDModel = z.infer<typeof ThreeDModelSchema>;

export const ComponentInfoSchema = z.object({
  lcscId: z.string().regex(/^C\d+$/),
  name: z.string().min(1),
  manufacturer: z.string(),
  manufacturerPartNumber: z.string(),
  sourcePackageName: z.string().min(1),
  targetPackageName: z.string().min(1),
  assemblyProcess: z.enum(["SMT", "THT"]),
  description: z.string(),
});
export type ComponentInfo = z.infer<typeof ComponentInfoSchema>;

export const NormalizedFootprintSchema = z.object({
  info: ComponentInfoSchema,
  pads: z.array(NormalizedPadSchema).min(1),
  holes: z.array(
    z.object({
      center: PointSchema,
      diameter: z.number().positive(),
    }),
  ),
  lines: z.array(NormalizedLineSchema),
  circles: z.array(NormalizedCircleSchema),
  sourceOrigin: PointSchema,
  bounds: z.object({
    minX: z.number().finite(),
    minY: z.number().finite(),
    maxX: z.number().finite(),
    maxY: z.number().finite(),
  }),
  model3d: ThreeDModelSchema.nullable(),
  sourceJson: z.string(),
});
export type NormalizedFootprint = z.infer<typeof NormalizedFootprintSchema>;

/**
 * 原理图符号（OrCAD Capture .olb）模型。
 *
 * 坐标单位与 Capture 一致：1 单位 = 10 mil（0.1 英寸网格的一步）。
 * 已实测确认源库（立创EDA专业版 SYMBOL 文档）引脚间距即为 10 单位，
 * 两边同源，映射时 **不做任何缩放**。
 */
export const SymbolPinTypeSchema = z.enum([
  "input",
  "output",
  "bidirectional",
  "passive",
  "power",
  "openCollector",
  "openEmitter",
  "tristate",
  "unspecified",
]);
export type SymbolPinType = z.infer<typeof SymbolPinTypeSchema>;

export const NormalizedSymbolPinSchema = z.object({
  /** 引脚名（源 "Pin Name" 属性，可为空串） */
  name: z.string(),
  /** 引脚号（源 "Pin Number" 属性） */
  number: z.string().min(1),
  /** 电气连接端（引脚外端，Capture 的 hotpt） */
  connection: PointSchema,
  /** 本体端（Capture 的 start） */
  body: PointSchema,
  length: z.number().nonnegative(),
  type: SymbolPinTypeSchema,
  visible: z.boolean(),
  /**
   * 引脚文字的**定位锚点**（名字 / 编号各一个点），解析时从本体盒推导后**冻结在引脚上**。
   *
   * 为什么必须冻结：Capture 的画法里，引脚名从本体边缘起算，但我们的手工编辑允许单独
   * 移动引脚。若每次渲染都拿"当前本体盒"推锚点，横着拖引脚时文字不会跟（左侧引脚名字的
   * x 恒等于本体左边 +5），而拖本体时所有文字又跟着本体跑 —— 用户会看到"标签与引脚分离、
   * 间距越拖越宽"。冻结到引脚后，`applySymbolEdits` 平移引脚时把它一起平移，
   * 标签与引脚的相对位置就永远不变。
   */
  labelAnchor: z
    .object({ name: PointSchema, number: PointSchema })
    .optional(),
});
export type NormalizedSymbolPin = z.infer<typeof NormalizedSymbolPinSchema>;

export const NormalizedSymbolShapeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rect"),
    min: PointSchema,
    max: PointSchema,
    cornerRadius: z.number().nonnegative(),
    filled: z.boolean(),
  }),
  z.object({
    kind: z.literal("polyline"),
    points: z.array(PointSchema).min(2),
    closed: z.boolean(),
  }),
  z.object({
    kind: z.literal("text"),
    // 允许空串：用户可以把文本清空（显示为空），写库时该条 CommentText 也就没有内容
    text: z.string(),
    at: PointSchema,
    rotation: z.number().finite(),
    height: z.number().positive(),
    /** 用户在预览里删除了这条注释文本（用户 2026-10-22）。隐藏但保留下标，避免编辑键错位 */
    hidden: z.boolean().optional(),
  }),
]);
export type NormalizedSymbolShape = z.infer<typeof NormalizedSymbolShapeSchema>;

export const NormalizedSymbolSectionSchema = z.object({
  /** 段名（源 PART id，如 PEX8748_Station0） */
  name: z.string().min(1),
  bounds: z.object({
    minX: z.number().finite(),
    minY: z.number().finite(),
    maxX: z.number().finite(),
    maxY: z.number().finite(),
  }),
  pins: z.array(NormalizedSymbolPinSchema),
  shapes: z.array(NormalizedSymbolShapeSchema),
});
export type NormalizedSymbolSection = z.infer<typeof NormalizedSymbolSectionSchema>;

export const NormalizedSymbolSchema = z.object({
  /** OLB 内 Package 名 */
  name: z.string().min(1),
  /** 位号前缀（源 "Designator"，如 "U?" → "U"） */
  refdesPrefix: z.string().min(1),
  /** 关联的 Allegro 封装名（Capture 的 PCB Footprint 字段） */
  pcbFootprint: z.string(),
  sections: z.array(NormalizedSymbolSectionSchema).min(1),
  sourceJson: z.string(),
});
export type NormalizedSymbol = z.infer<typeof NormalizedSymbolSchema>;

/** 库里某个器件的概览（写入前探测同名器件用）。 */
export const OlbPartSummarySchema = z.object({
  sectionCount: z.number().int().positive(),
  pinCount: z.number().int().nonnegative(),
  /** 本体包围盒横向范围，用来区分"内容真的换了"和"只是名字相同" */
  bodyWidth: z.number().finite().nullable(),
});
export type OlbPartSummary = z.infer<typeof OlbPartSummarySchema>;

export const OlbWriteResultSchema = z.object({
  libraryPath: z.string().min(1),
  /** true = 本次新建了库文件（此前不存在） */
  created: z.boolean(),
  packageName: z.string().min(1),
  sectionCount: z.number().int().positive(),
  pinCount: z.number().int().nonnegative(),
  backupPath: z.string().min(1).nullable(),
  bytes: z.number().int().nonnegative(),
  /**
   * 写入时目标库被 OrCAD Capture 打开着的锁文件路径（null = 没被占用）。
   *
   * 这个锁**不阻止写入**（它只是 Capture 的标记文件，.olb 本身没有被独占），
   * 但 Capture 用的是内存里的旧副本：用户在 Capture 里保存该库时会把我们刚写的
   * 内容覆盖掉。因此写完后会登记一次"补写"，等锁消失再重放（见 olb-pending.ts）。
   */
  captureLockPath: z.string().min(1).nullable().optional(),
  /** true = 已登记自动补写（Capture 关掉该库后重放一次） */
  pendingWrite: z.boolean().optional(),
  /**
   * true = 库里同名器件的内容与本次**完全一致**（只是重写了一遍）。
   *
   * 用户 2026-10-23 的实际场景：器件早写进去了，只是 Capture 缓存着看不到，他以为失败又点
   * 一次，于是弹"已有同名器件 1段9脚 → 1段9脚"，反而更像工具没写。内容一样就不该再问。
   */
  identical: z.boolean().optional(),
  /** 写入前库里同名器件的概览（补写时用来判断"被 Capture 覆盖"还是"被用户手改"） */
  previous: OlbPartSummarySchema.nullable().optional(),
  message: z.string().min(1),
});
export type OlbWriteResult = z.infer<typeof OlbWriteResultSchema>;

/**
 * 写入 .olb 的结果。目标库里**已有同名器件**时先返回 needsConfirm，
 * 由界面做二次确认（用户 2026-10-16 反馈"同名不覆盖也没提醒，还是旧数据"）。
 */
export const OlbWriteOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("needsConfirm"),
    libraryPath: z.string().min(1),
    packageName: z.string().min(1),
    existing: OlbPartSummarySchema,
    incoming: OlbPartSummarySchema,
  }),
  z.object({
    status: z.literal("written"),
    result: OlbWriteResultSchema,
  }),
]);
export type OlbWriteOutcome = z.infer<typeof OlbWriteOutcomeSchema>;

export const CheckSeveritySchema = z.enum(["pass", "warning", "error"]);
export type CheckSeverity = z.infer<typeof CheckSeveritySchema>;

export const ConversionCheckSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().min(1),
  severity: CheckSeveritySchema,
});
export type ConversionCheck = z.infer<typeof ConversionCheckSchema>;

export const ConversionPlanSchema = z.object({
  footprint: NormalizedFootprintSchema,
  checks: z.array(ConversionCheckSchema),
  padstackCount: z.number().int().nonnegative(),
  solderMaskExpansionMm: z.number().nonnegative(),
  pasteAreaRatio: z.number().positive().max(1),
});
export type ConversionPlan = z.infer<typeof ConversionPlanSchema>;

export const GeneratedFileSchema = z.object({
  relativePath: z.string().min(1),
  status: z.enum(["generated", "verified", "planned"]),
  bytes: z.number().int().nonnegative(),
});
export type GeneratedFile = z.infer<typeof GeneratedFileSchema>;

export const GenerationStageSchema = z.enum([
  "preparing",
  "launching",
  "generating",
  "verifying",
  "copying",
  "completed",
  "failed",
]);
export type GenerationStage = z.infer<typeof GenerationStageSchema>;

export const GenerationProgressSchema = z.object({
  lcscId: z.string().regex(/^C\d+$/),
  stage: GenerationStageSchema,
  percent: z.number().int().min(0).max(100),
  message: z.string().min(1),
  diagnosticDirectory: z.string().min(1).nullable(),
  timestamp: z.string().datetime(),
});
export type GenerationProgress = z.infer<typeof GenerationProgressSchema>;

export const ConversionResultSchema = z.object({
  lcscId: z.string().regex(/^C\d+$/),
  targetPackageName: z.string().min(1),
  libraryDirectory: z.string().min(1),
  outcome: z.enum(["success", "scripts-only", "failed"]),
  files: z.array(GeneratedFileSchema),
  checks: z.array(ConversionCheckSchema),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  message: z.string().min(1),
});
export type ConversionResult = z.infer<typeof ConversionResultSchema>;

export const HistoryEntrySchema = ConversionResultSchema.extend({
  id: z.string().min(1),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/**
 * 元件搜索的一条结果（用户 2026-10-19 要求"支持输入元件名模糊搜索"）。
 * 字段取自立创商城搜索接口：number = C 编号，mpn = 厂商型号。
 */
export const ProductSearchHitSchema = z.object({
  lcscId: z.string().regex(/^C\d+$/),
  mpn: z.string(),
  package: z.string(),
  manufacturer: z.string(),
  stock: z.number().int().nonnegative(),
});
export type ProductSearchHit = z.infer<typeof ProductSearchHitSchema>;

export const ProductSearchResultSchema = z.object({
  keyword: z.string(),
  hits: z.array(ProductSearchHitSchema),
});
export type ProductSearchResult = z.infer<typeof ProductSearchResultSchema>;

export const QueueItemSchema = z.object({  id: z.string().regex(/^C\d+$/),
  state: z.enum([
    "ready",
    "loading",
    "warning",
    "error",
    "generationFailed",
    "generated",
  ]),
  footprint: NormalizedFootprintSchema.nullable(),
  message: z.string(),
  /**
   * 行内提示（显示在封装名那一行的位置）。目前只有一种来源：原理图元件已写入，
   * 但 Capture 正打开着 .olb，需要关掉该库再打开才能看到（用户 2026-10-23）。
   * 有值时列表里显示它，替代封装名 —— 否则"生成了却看不到"会被误判成失败。
   */
  notice: z.string().optional(),
  selected: z.boolean(),
  /**
   * 本地库器件的溯源信息。符号条目（symbols 表）丢了之后要靠它补拉 ——
   * C 编号器件没有这个字段，走在线 fetchSymbol。
   */
  local: z
    .object({ sourcePath: z.string().min(1), deviceUuid: z.string().min(1) })
    .optional(),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const AllegroInstallSchema = z.object({
  version: AllegroVersionSchema,
  executablePath: z.string().min(1),
  detected: z.boolean(),
});
export type AllegroInstall = z.infer<typeof AllegroInstallSchema>;

export const LocalLibraryDeviceSummarySchema = z.object({
  deviceUuid: z.string().min(1),
  lcscId: z.string().regex(/^C\d+$/),
  name: z.string().min(1),
  manufacturer: z.string(),
  manufacturerPartNumber: z.string(),
  footprintTitle: z.string(),
  padCount: z.number().int().nonnegative(),
  sourcePath: z.string().min(1),
});
export type LocalLibraryDeviceSummary = z.infer<typeof LocalLibraryDeviceSummarySchema>;

export const AppApiSchema = z.object({
  platform: z.string().min(1),
  appVersion: z.string().min(1),
});
export type AppApiInfo = z.infer<typeof AppApiSchema>;
