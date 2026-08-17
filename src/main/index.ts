import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { electronApp, is } from "@electron-toolkit/utils";
import { z } from "zod";
import { AllegroDetector } from "./connectors/allegro-detector";
import { EasyEdaConnector } from "./connectors/easyeda-connector";
import { JsonStore } from "./connectors/json-store";
import { AllegroRunner } from "./connectors/allegro-runner";
import { createConversionPlan } from "./conversion/validate";
import { configureLogging, writeLog } from "./logging";
import { lastWindowCloseAction } from "./lifecycle";
import { IpcChannels } from "../shared/ipc";
import { AllegroExecutionError } from "../shared/errors";
import {
  AppSettingsSchema,
  ConversionPlanSchema,
  HistoryEntrySchema,
  NormalizedFootprintSchema,
  type AppSettings,
  type GenerationProgress,
  type HistoryEntry,
} from "../shared/schemas";

const HistorySchema = z.array(HistoryEntrySchema);
const defaultSettings = (): AppSettings => ({
  allegroVersion: "23.1",
  libraryDirectory: join(app.getPath("documents"), "AllegroLibrary"),
  setupCompleted: false,
  allegroExecutablePath: null,
});

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: "#f4f5f7",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
    },
  });
  window.on("ready-to-show", () => window.show());
  if (is.dev && process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
  return window;
};

const registerHandlers = (): void => {
  const dataDirectory = app.getPath("userData");
  configureLogging(join(dataDirectory, "logs", "application.jsonl"));
  const settingsStore = new JsonStore(
    join(dataDirectory, "settings.json"),
    AppSettingsSchema,
    defaultSettings(),
  );
  const historyStore = new JsonStore<HistoryEntry[]>(
    join(dataDirectory, "history.json"),
    HistorySchema,
    [],
  );
  const easyEda = new EasyEdaConnector(join(dataDirectory, "cache", "footprints"));
  const detector = new AllegroDetector();
  const runner = new AllegroRunner();

  ipcMain.handle(IpcChannels.getAppInfo, () => ({
    platform: process.platform,
    appVersion: app.getVersion(),
  }));
  ipcMain.handle(IpcChannels.getSettings, () => settingsStore.read());
  ipcMain.handle(IpcChannels.saveSettings, (_event, rawSettings: unknown) =>
    settingsStore.write(AppSettingsSchema.parse(rawSettings)),
  );
  ipcMain.handle(IpcChannels.chooseLibraryDirectory, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择 Allegro 库目录",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IpcChannels.detectAllegro, async () => {
    const settings = await settingsStore.read();
    const detected = await detector.detect();
    if (settings.allegroExecutablePath === null) {
      return detected;
    }
    const manualInstall = await detector.inspectExecutable(
      settings.allegroExecutablePath,
      null,
    );
    return manualInstall === null
      ? detected
      : [
          manualInstall,
          ...detected.filter(
            (install) =>
              install.executablePath.toLowerCase() !==
              manualInstall.executablePath.toLowerCase(),
          ),
        ];
  });
  ipcMain.handle(IpcChannels.chooseAllegroExecutable, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择 Allegro 程序",
      properties: ["openFile"],
      filters:
        process.platform === "win32"
          ? [{ name: "Allegro", extensions: ["exe"] }]
          : [{ name: "Allegro", extensions: ["*"] }],
    });
    if (result.canceled || result.filePaths[0] === undefined) {
      return null;
    }
    return detector.inspectExecutable(result.filePaths[0], null);
  });
  ipcMain.handle(IpcChannels.fetchComponent, (_event, lcscId: unknown) =>
    easyEda.fetchFootprint(z.string().parse(lcscId)),
  );
  ipcMain.handle(IpcChannels.createPlan, (_event, rawFootprint: unknown) =>
    createConversionPlan(NormalizedFootprintSchema.parse(rawFootprint)),
  );
  ipcMain.handle(IpcChannels.generate, async (event, rawPlan: unknown) => {
    const plan = ConversionPlanSchema.parse(rawPlan);
    const settings = await settingsStore.read();
    const installs = await detector.detect();
    const manualInstall =
      settings.allegroExecutablePath === null
        ? null
        : await detector.inspectExecutable(
            settings.allegroExecutablePath,
            null,
          );
    const install =
      (manualInstall?.version === settings.allegroVersion ? manualInstall : null) ??
      installs.find((candidate) => candidate.version === settings.allegroVersion) ??
      null;
    const progressState: { last: GenerationProgress | null } = { last: null };
    try {
      const result = await runner.generate(
        plan,
        settings,
        install,
        (progress) => {
          progressState.last = progress;
          event.sender.send(IpcChannels.generationProgress, progress);
        },
      );
      const history = await historyStore.read();
      await historyStore.write([
        { ...result, id: `${result.lcscId}-${result.completedAt}` },
        ...history,
      ].slice(0, 200));
      return result;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      const diagnosticDirectory =
        error instanceof AllegroExecutionError
          ? error.details.workingDirectory
          : null;
      await writeLog("error", "conversion_failed", {
        lcscId: plan.footprint.info.lcscId,
        message: cause.message,
        diagnosticDirectory,
      });
      event.sender.send(IpcChannels.generationProgress, {
        lcscId: plan.footprint.info.lcscId,
        stage: "failed",
        percent: Math.min(progressState.last?.percent ?? 1, 99),
        message: cause.message,
        diagnosticDirectory,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  });
  ipcMain.handle(IpcChannels.getHistory, () => historyStore.read());
  ipcMain.handle(IpcChannels.openPath, async (_event, absolutePath: unknown) => {
    const parsedPath = z.string().min(1).parse(absolutePath);
    const errorMessage = await shell.openPath(parsedPath);
    if (errorMessage.length > 0) {
      throw new Error(`Unable to open ${parsedPath}: ${errorMessage}`);
    }
  });
};

app.whenReady().then(() => {
  electronApp.setAppUserModelId("cn.easy2alg.app");
  registerHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch(async (error: unknown) => {
  const cause = error instanceof Error ? error : new Error(String(error));
  await writeLog("error", "application_start_failed", { message: cause.message });
  app.quit();
});

app.on("window-all-closed", () => {
  const action = lastWindowCloseAction(process.platform);
  if (action === "exit") {
    app.exit(0);
  } else if (action === "quit") {
    app.quit();
  }
});
