import { getDemoFootprint } from "../../shared/demo-fixtures";
import type { Easy2AlgApi } from "../../shared/ipc";
import type { ProductSearchHit } from "../../shared/schemas";
import {
  defaultUiSettings,
  type AppSettings,
  type GenerationProgress,
  type HistoryEntry,
} from "../../shared/schemas";
import { RELEASE_PAGE_URL, initialUpdateState, type UpdateState } from "../../shared/update";

const SettingsKey = "easy2alg.settings";
const HistoryKey = "easy2alg.history";

const mockUpdateState: UpdateState = {
  ...initialUpdateState("0.1.0"),
  status: "unsupported",
  supported: false,
  message: "网页预览不支持自动更新，请到发布页下载安装版。",
};

const readSettings = (): AppSettings => {
  const saved = window.localStorage.getItem(SettingsKey);
  if (saved === null) {
    return {
      allegroVersion: "17.2",
      libraryDirectory: "D:\\AllegroLibrary",
      setupCompleted: true,
      allegroExecutablePath: null,
      olbLibraryPath: null,
      unifiedLibraryFolder: false,
      fillPcbFootprint: true,
      ui: defaultUiSettings(),
    };
  }
  const parsed = JSON.parse(saved) as AppSettings;
  return {
    ...parsed,
    allegroExecutablePath: parsed.allegroExecutablePath ?? null,
    unifiedLibraryFolder: parsed.unifiedLibraryFolder ?? false,
    fillPcbFootprint: parsed.fillPcbFootprint ?? true,
    ui: { ...defaultUiSettings(), ...parsed.ui },
  };
};

const readHistory = (): HistoryEntry[] => {
  const saved = window.localStorage.getItem(HistoryKey);
  return saved === null ? [] : (JSON.parse(saved) as HistoryEntry[]);
};

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
};

export const createMockApi = (): Easy2AlgApi => {
  const progressListeners = new Set<(progress: GenerationProgress) => void>();
  const retryScenarios = new Set<string>();
  const emitProgress = (progress: Omit<GenerationProgress, "timestamp">): void => {
    const value: GenerationProgress = { ...progress, timestamp: new Date().toISOString() };
    progressListeners.forEach((listener) => listener(value));
  };
  return {
    getAppInfo: async () => ({ platform: "browser-preview", appVersion: "0.1.4" }),
    getSettings: async () => readSettings(),
    saveSettings: async (settings) => {
      window.localStorage.setItem(SettingsKey, JSON.stringify(settings));
      return settings;
    },
    chooseLibraryDirectory: async () => "D:\\AllegroLibrary",
    chooseAllegroExecutable: async () => ({
      version: "25.1",
      executablePath: "C:\\Cadence\\SPB_25.1\\tools\\bin\\allegro.exe",
      detected: true,
    }),
    detectAllegro: async () => [
      {
        version: "25.1",
        executablePath: "C:\\Cadence\\SPB_25.1\\tools\\bin\\allegro.exe",
        detected: true,
      },
      {
        version: "17.2",
        executablePath: "C:\\Cadence\\SPB_17.2\\tools\\bin\\allegro.exe",
        detected: true,
      },
    ],
    saveUiSettings: async (patch) => {
      const merged: AppSettings = { ...readSettings(), ui: { ...readSettings().ui, ...patch } };
      window.localStorage.setItem(SettingsKey, JSON.stringify(merged));
      return merged;
    },
    fetchSymbol: async () => null,
    // 浏览器预览用的搜索桩：模拟真实接口"型号 → C 编号"的命中
    searchProducts: async (keyword) => {
      const normalized = keyword.trim().toUpperCase();
      const table: readonly ProductSearchHit[] = [
        { lcscId: "C2866150", mpn: "LMK00301ARHST", package: "WQFN-48-EP(7x7)", manufacturer: "TI", stock: 0 },
        { lcscId: "C2040", mpn: "RP2040", package: "LQFN-56", manufacturer: "Raspberry Pi", stock: 1200 },
        { lcscId: "C7955", mpn: "LM393DR", package: "SOIC-8", manufacturer: "TI", stock: 800 },
      ];
      return {
        keyword,
        hits:
          normalized.length === 0
            ? []
            : table.filter(
                (hit) =>
                  hit.mpn.toUpperCase().includes(normalized) ||
                  hit.lcscId.toUpperCase().includes(normalized),
              ),
      };
    },
    fetchComponent: async (lcscId) => {
      await wait(300);
      // 搜索结果里只有 C2040 有演示封装；C2866150 借用同一份数据，方便预览里点通整条链路
      const alias = lcscId.toUpperCase() === "C2866150" ? "C2040" : lcscId;
      const footprint = getDemoFootprint(alias);
      if (footprint === null) {
        throw new Error(`演示数据中没有 ${lcscId}，可使用 C2040、C20197 或 C163691。`);
      }
      return { ...footprint, lcscId };
    },
    chooseLocalLibraryFile: async () => null,
    readLocalLibrary: async () => [],
    fetchLocalComponent: async () => {
      throw new Error("浏览器预览不支持本地库导入，请使用桌面版。");
    },
    fetchLocalSymbol: async () => null,
    chooseOlbLibrary: async () => null,
    createOlbLibrary: async () => null,
    writeOlb: async () => {
      throw new Error("浏览器预览不支持写入 OLB，请使用桌面版。");
    },
    getOlbLock: async () => ({ libraryPath: null, lockPath: null, blocked: false }),
    createPlan: async (footprint) => {
      const largePad = footprint.pads.some((pad) => pad.width * pad.height > 16);
      return {
        footprint,
        padstackCount: new Set(
          footprint.pads.map((pad) => `${pad.shape}-${pad.width}-${pad.height}-${pad.holeWidth}`),
        ).size,
        solderMaskExpansionMm: 0.05,
        pasteAreaRatio: largePad ? 0.7 : 1,
        checks: [
          {
            id: "pins",
            label: `${footprint.pads.length} 个引脚`,
            detail: "引脚编号和位置已读取",
            severity: "pass",
          },
          {
            id: "mask",
            label: "阻焊开窗有效",
            detail: "按铜焊盘外扩 0.05 mm",
            severity: "pass",
          },
          {
            id: "paste",
            label: "钢网开口有效",
            detail: largePad ? "大焊盘采用 70% 开口率" : "普通焊盘采用 100% 开口率",
            severity: largePad ? "warning" : "pass",
          },
        ],
      };
    },
    generate: async (plan) => {
      const lcscId = plan.footprint.info.lcscId;
      const settings = readSettings();
      const steps: readonly Omit<GenerationProgress, "timestamp">[] = [
        {
          lcscId,
          stage: "preparing",
          percent: 8,
          message: "正在准备封装数据和输出目录",
          diagnosticDirectory: null,
        },
        {
          lcscId,
          stage: "launching",
          percent: 28,
          message: `正在启动 Allegro ${settings.allegroVersion}`,
          diagnosticDirectory: null,
        },
        {
          lcscId,
          stage: "generating",
          percent: 52,
          message: "Allegro 正在生成焊盘和封装",
          diagnosticDirectory: null,
        },
        {
          lcscId,
          stage: "verifying",
          percent: 74,
          message: "正在回读封装并检查引脚",
          diagnosticDirectory: null,
        },
        {
          lcscId,
          stage: "copying",
          percent: 91,
          message: "检查通过，正在写入封装库目录",
          diagnosticDirectory: null,
        },
      ];
      for (const step of steps) {
        emitProgress(step);
        await wait(260);
        if (
          lcscId === "C20197" &&
          step.stage === "verifying" &&
          !retryScenarios.has(lcscId)
        ) {
          retryScenarios.add(lcscId);
          emitProgress({
            lcscId,
            stage: "failed",
            percent: 74,
            message: "首次检查失败，用于验证关闭后可以直接重试。",
            diagnosticDirectory: "C:\\Users\\Demo\\AppData\\Local\\Temp\\easy2alg-demo",
          });
          throw new Error("首次检查失败，用于验证关闭后可以直接重试。");
        }
      }
      const now = new Date().toISOString();
      const result: HistoryEntry = {
        id: `${lcscId}-${now}`,
        lcscId,
        targetPackageName: plan.footprint.info.targetPackageName,
        libraryDirectory: settings.libraryDirectory,
        outcome: "success",
        files: [
          {
            relativePath: `symbols/${plan.footprint.info.targetPackageName}.dra`,
            status: "verified",
            bytes: 18432,
          },
          {
            relativePath: `symbols/${plan.footprint.info.targetPackageName}.psm`,
            status: "verified",
            bytes: 12672,
          },
        ],
        checks: plan.checks,
        startedAt: now,
        completedAt: now,
        message: "封装已生成并通过 Allegro 回读检查。",
      };
      window.localStorage.setItem(HistoryKey, JSON.stringify([result, ...readHistory()]));
      emitProgress({
        lcscId,
        stage: "completed",
        percent: 100,
        message: "封装已生成并通过检查",
        diagnosticDirectory: null,
      });
      return result;
    },
    onGenerationProgress: (listener) => {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
    getHistory: async () => readHistory(),
    openPath: async () => undefined,
    // 网页预览没有 electron-updater，固定报"不支持"，界面显示"打开发布页"那条分支
    getUpdateState: async () => mockUpdateState,
    checkForUpdates: async () => mockUpdateState,
    downloadUpdate: async () => mockUpdateState,
    installUpdate: async () => undefined,
    openReleasePage: async () => {
      window.open(RELEASE_PAGE_URL, "_blank", "noopener");
    },
    onUpdateState: () => () => undefined,
  };
};
