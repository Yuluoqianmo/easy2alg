import { contextBridge, ipcRenderer } from "electron";
import type { Easy2AlgApi } from "../shared/ipc";
import { IpcChannels } from "../shared/ipc";
import type { GenerationProgress, GenerationStage } from "../shared/schemas";
import type { UpdateState, UpdateStatus } from "../shared/update";

const UpdateStatuses = new Set<UpdateStatus>([
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
  "unsupported",
]);

const parseUpdateState = (rawState: unknown): UpdateState => {
  if (typeof rawState !== "object" || rawState === null) {
    throw new TypeError("Update state must be an object");
  }
  const value = rawState as Readonly<Record<string, unknown>>;
  if (
    typeof value.status !== "string" ||
    !UpdateStatuses.has(value.status as UpdateStatus) ||
    typeof value.currentVersion !== "string" ||
    !(value.latestVersion === null || typeof value.latestVersion === "string") ||
    typeof value.percent !== "number" ||
    !(value.message === null || typeof value.message === "string") ||
    typeof value.releaseUrl !== "string" ||
    typeof value.supported !== "boolean"
  ) {
    throw new TypeError("Update state contains invalid fields");
  }
  return {
    status: value.status as UpdateStatus,
    currentVersion: value.currentVersion,
    latestVersion: value.latestVersion as string | null,
    percent: value.percent,
    message: value.message as string | null,
    releaseUrl: value.releaseUrl,
    supported: value.supported,
  };
};

const GenerationStages = new Set<GenerationStage>([
  "preparing",
  "launching",
  "generating",
  "verifying",
  "copying",
  "completed",
  "failed",
]);

const parseGenerationProgress = (rawProgress: unknown): GenerationProgress => {
  if (typeof rawProgress !== "object" || rawProgress === null) {
    throw new TypeError("Generation progress must be an object");
  }
  const value = rawProgress as Readonly<Record<string, unknown>>;
  if (
    typeof value.lcscId !== "string" ||
    !/^C\d+$/.test(value.lcscId) ||
    typeof value.stage !== "string" ||
    !GenerationStages.has(value.stage as GenerationStage) ||
    typeof value.percent !== "number" ||
    !Number.isInteger(value.percent) ||
    value.percent < 0 ||
    value.percent > 100 ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    !(
      value.diagnosticDirectory === null ||
      (typeof value.diagnosticDirectory === "string" &&
        value.diagnosticDirectory.length > 0)
    ) ||
    typeof value.timestamp !== "string" ||
    Number.isNaN(Date.parse(value.timestamp))
  ) {
    throw new TypeError("Generation progress contains invalid fields");
  }
  return {
    lcscId: value.lcscId,
    stage: value.stage as GenerationStage,
    percent: value.percent,
    message: value.message,
    diagnosticDirectory: value.diagnosticDirectory as string | null,
    timestamp: value.timestamp,
  };
};

const api: Easy2AlgApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannels.getAppInfo),
  getSettings: () => ipcRenderer.invoke(IpcChannels.getSettings),
  saveSettings: (settings) => ipcRenderer.invoke(IpcChannels.saveSettings, settings),
  saveUiSettings: (patch) => ipcRenderer.invoke(IpcChannels.saveUiSettings, patch),
  chooseLibraryDirectory: () => ipcRenderer.invoke(IpcChannels.chooseLibraryDirectory),
  chooseAllegroExecutable: () => ipcRenderer.invoke(IpcChannels.chooseAllegroExecutable),
  detectAllegro: () => ipcRenderer.invoke(IpcChannels.detectAllegro),
  searchProducts: (keyword) => ipcRenderer.invoke(IpcChannels.searchProducts, keyword),
  fetchComponent: (lcscId) => ipcRenderer.invoke(IpcChannels.fetchComponent, lcscId),
  fetchSymbol: (lcscId) => ipcRenderer.invoke(IpcChannels.fetchSymbol, lcscId),
  chooseLocalLibraryFile: (defaultDirectory) => ipcRenderer.invoke(IpcChannels.chooseLocalLibraryFile, defaultDirectory),
  readLocalLibrary: (filePath) => ipcRenderer.invoke(IpcChannels.readLocalLibrary, filePath),
  fetchLocalComponent: (filePath, deviceUuid) =>
    ipcRenderer.invoke(IpcChannels.fetchLocalComponent, filePath, deviceUuid),
  fetchLocalSymbol: (filePath, deviceUuid) =>
    ipcRenderer.invoke(IpcChannels.fetchLocalSymbol, filePath, deviceUuid),
  chooseOlbLibrary: () => ipcRenderer.invoke(IpcChannels.chooseOlbLibrary),
  createOlbLibrary: (suggestedName) =>
    ipcRenderer.invoke(IpcChannels.createOlbLibrary, suggestedName),
  writeOlb: (request) => ipcRenderer.invoke(IpcChannels.writeOlb, request),
  getOlbLock: () => ipcRenderer.invoke(IpcChannels.getOlbLock),
  createPlan: (footprint) => ipcRenderer.invoke(IpcChannels.createPlan, footprint),
  generate: (plan) => ipcRenderer.invoke(IpcChannels.generate, plan),
  onGenerationProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawProgress: unknown): void => {
      listener(parseGenerationProgress(rawProgress));
    };
    ipcRenderer.on(IpcChannels.generationProgress, handler);
    return () => ipcRenderer.removeListener(IpcChannels.generationProgress, handler);
  },
  getHistory: () => ipcRenderer.invoke(IpcChannels.getHistory),
  openPath: (absolutePath) => ipcRenderer.invoke(IpcChannels.openPath, absolutePath),
  getUpdateState: async () =>
    parseUpdateState(await ipcRenderer.invoke(IpcChannels.getUpdateState)),
  checkForUpdates: async () =>
    parseUpdateState(await ipcRenderer.invoke(IpcChannels.checkForUpdates)),
  downloadUpdate: async () =>
    parseUpdateState(await ipcRenderer.invoke(IpcChannels.downloadUpdate)),
  installUpdate: () => ipcRenderer.invoke(IpcChannels.installUpdate),
  openReleasePage: () => ipcRenderer.invoke(IpcChannels.openReleasePage),
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawState: unknown): void => {
      listener(parseUpdateState(rawState));
    };
    ipcRenderer.on(IpcChannels.updateState, handler);
    return () => ipcRenderer.removeListener(IpcChannels.updateState, handler);
  },
};

contextBridge.exposeInMainWorld("easy2alg", api);
