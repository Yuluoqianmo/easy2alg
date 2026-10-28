import type {
  AllegroInstall,
  AppApiInfo,
  AppSettings,
  ConversionPlan,
  ConversionResult,
  GenerationProgress,
  HistoryEntry,
  LocalLibraryDeviceSummary,
  NormalizedFootprint,
  NormalizedSymbol,
  OlbWriteOutcome,
  ProductSearchResult,
  UiSettingsPatch,
} from "./schemas";
import type { UpdateState } from "./update";

export type OlbWriteRequest = {
  readonly symbol: NormalizedSymbol;
  /** 目标 .olb 绝对路径；null = 未指定，由主进程在封装库目录下自动新建 */
  readonly libraryPath: string | null;
  /** 未指定时的库文件名来源（一般取 .elibz2 文件名） */
  readonly libraryName: string;
  /** 库里已有同名器件时是否直接覆盖（false = 先返回 needsConfirm 让界面确认） */
  readonly confirmOverwrite?: boolean;
  /**
   * 写库前是否把引脚连接端强制吸附到 100 mil（用户 2026-10-20：跟随界面吸附开关）。
   * 省略 = true（老行为）；false 时按实际坐标写入，但仍会取整成整数（XSD 要求）。
   */
  readonly snapPins?: boolean;
  /**
   * 是否把 PCB 封装名写进器件的 PCB Footprint 字段。
   * 省略 = 跟随设置里的全局开关。用户 2026-10-23：只生成原理图元件时这个字段
   * 应该留空（封装名此时没有意义），所以调用方会传「全局开关 && 勾了 PCB」。
   */
  readonly fillPcbFootprint?: boolean;
};

/**
 * 目标 .olb 此刻是否被 OrCAD Capture 打开着。
 *
 * 用途：生成前就告诉用户"写进去也看不到，得关掉该库再打开"，避免把"Capture 没刷新"
 * 误判成"工具没写"（用户 2026-10-23 实际踩到）。
 */
export type OlbLockState = {
  readonly libraryPath: string | null;
  readonly lockPath: string | null;
  /** true = 锁文件在且 Capture 在跑（残留锁不算） */
  readonly blocked: boolean;
};

export type Easy2AlgApi = {
  getAppInfo: () => Promise<AppApiInfo>;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
  /**
   * 只更新界面偏好（侧栏宽度 / 分组折叠 / 图层配色）—— 不重跑 Allegro 探测，
   * 所以拖动侧栏时不卡。返回合并后的完整设置。
   */
  saveUiSettings: (patch: UiSettingsPatch) => Promise<AppSettings>;
  chooseLibraryDirectory: () => Promise<string | null>;
  chooseAllegroExecutable: () => Promise<AllegroInstall | null>;
  detectAllegro: () => Promise<AllegroInstall[]>;
  /** 按关键字（厂商型号 / 描述）模糊搜索立创元件；C 编号由调用方直接导入，不走这里。 */
  searchProducts: (keyword: string) => Promise<ProductSearchResult>;
  fetchComponent: (lcscId: string) => Promise<NormalizedFootprint>;
  /** 立创编号链路的原理图符号（同一份接口响应里的 dataStr）；没有符号时返回 null。 */
  fetchSymbol: (lcscId: string) => Promise<NormalizedSymbol | null>;
  /**
   * 选 .elibz2 库文件。`defaultDirectory` = 上次用过的目录（选择框直接落在那里），
   * 没有就 null。
   */
  chooseLocalLibraryFile: (defaultDirectory: string | null) => Promise<string | null>;
  readLocalLibrary: (filePath: string) => Promise<readonly LocalLibraryDeviceSummary[]>;
  fetchLocalComponent: (filePath: string, deviceUuid: string) => Promise<NormalizedFootprint>;
  fetchLocalSymbol: (filePath: string, deviceUuid: string) => Promise<NormalizedSymbol | null>;
  chooseOlbLibrary: () => Promise<string | null>;
  createOlbLibrary: (suggestedName: string) => Promise<string | null>;
  writeOlb: (request: OlbWriteRequest) => Promise<OlbWriteOutcome>;
  /** 目标 .olb 是否被 Capture 打开着（生成前提示用） */
  getOlbLock: () => Promise<OlbLockState>;
  createPlan: (footprint: NormalizedFootprint) => Promise<ConversionPlan>;
  generate: (plan: ConversionPlan) => Promise<ConversionResult>;
  onGenerationProgress: (listener: (progress: GenerationProgress) => void) => () => void;
  getHistory: () => Promise<HistoryEntry[]>;
  openPath: (absolutePath: string) => Promise<void>;
  /** 自动更新：当前状态（界面打开设置页时先拉一次） */
  getUpdateState: () => Promise<UpdateState>;
  checkForUpdates: () => Promise<UpdateState>;
  downloadUpdate: () => Promise<UpdateState>;
  installUpdate: () => Promise<void>;
  openReleasePage: () => Promise<void>;
  /** 订阅更新状态变化（检查中 / 有新版本 / 下载进度 / 下载完成 / 出错） */
  onUpdateState: (listener: (state: UpdateState) => void) => () => void;
};

export const IpcChannels = {
  getAppInfo: "app:get-info",
  getSettings: "settings:get",
  saveSettings: "settings:save",
  saveUiSettings: "settings:save-ui",
  chooseLibraryDirectory: "dialog:choose-library-directory",
  chooseAllegroExecutable: "dialog:choose-allegro-executable",
  detectAllegro: "allegro:detect",
  searchProducts: "easyeda:search-products",
  fetchComponent: "easyeda:fetch-component",
  fetchSymbol: "easyeda:fetch-symbol",
  chooseLocalLibraryFile: "dialog:choose-local-library",
  readLocalLibrary: "local-library:read",
  fetchLocalComponent: "local-library:fetch-component",
  fetchLocalSymbol: "local-library:fetch-symbol",
  chooseOlbLibrary: "dialog:choose-olb-library",
  createOlbLibrary: "dialog:create-olb-library",
  writeOlb: "olb:write",
  getOlbLock: "olb:lock-state",
  createPlan: "conversion:create-plan",
  generate: "conversion:generate",
  generationProgress: "conversion:progress",
  getHistory: "history:get",
  openPath: "shell:open-path",
  getUpdateState: "updater:get-state",
  checkForUpdates: "updater:check",
  downloadUpdate: "updater:download",
  installUpdate: "updater:install",
  openReleasePage: "updater:open-release",
  updateState: "updater:state",
} as const;
