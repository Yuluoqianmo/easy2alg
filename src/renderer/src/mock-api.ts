import { getDemoFootprint } from "../../shared/demo-fixtures";
import type { EasyEda2AllegroApi } from "../../shared/ipc";
import type { AppSettings, GenerationProgress, HistoryEntry } from "../../shared/schemas";

const SettingsKey = "easyeda2allegro.settings";
const HistoryKey = "easyeda2allegro.history";

const readSettings = (): AppSettings => {
  const saved = window.localStorage.getItem(SettingsKey);
  if (saved === null) {
    return {
      allegroVersion: "17.2",
      libraryDirectory: "D:\\AllegroLibrary",
      setupCompleted: true,
      allegroExecutablePath: null,
    };
  }
  const parsed = JSON.parse(saved) as AppSettings;
  return {
    ...parsed,
    allegroExecutablePath: parsed.allegroExecutablePath ?? null,
  };
};

const readHistory = (): HistoryEntry[] => {
  const saved = window.localStorage.getItem(HistoryKey);
  return saved === null ? [] : (JSON.parse(saved) as HistoryEntry[]);
};

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
};

export const createMockApi = (): EasyEda2AllegroApi => {
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
      version: "16.6",
      executablePath: "C:\\Cadence\\SPB_16.6\\tools\\pcb\\bin\\allegro.exe",
      detected: true,
    }),
    detectAllegro: async () => [
      {
        version: "17.2",
        executablePath: "C:\\Cadence\\SPB_17.2\\tools\\bin\\allegro.exe",
        detected: true,
      },
      {
        version: "16.6",
        executablePath: "C:\\Cadence\\SPB_16.6\\tools\\pcb\\bin\\allegro.exe",
        detected: true,
      },
    ],
    fetchComponent: async (lcscId) => {
      await wait(300);
      const footprint = getDemoFootprint(lcscId);
      if (footprint === null) {
        throw new Error(`演示数据中没有 ${lcscId}，可使用 C2040、C20197 或 C163691。`);
      }
      return footprint;
    },
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
            diagnosticDirectory: "C:\\Users\\Demo\\AppData\\Local\\Temp\\easyeda2allegro-demo",
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
  };
};
