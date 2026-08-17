import { contextBridge, ipcRenderer } from "electron";
import type { Easy2AlgApi } from "../shared/ipc";
import { IpcChannels } from "../shared/ipc";
import type { GenerationProgress, GenerationStage } from "../shared/schemas";

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
  chooseLibraryDirectory: () => ipcRenderer.invoke(IpcChannels.chooseLibraryDirectory),
  chooseAllegroExecutable: () => ipcRenderer.invoke(IpcChannels.chooseAllegroExecutable),
  detectAllegro: () => ipcRenderer.invoke(IpcChannels.detectAllegro),
  fetchComponent: (lcscId) => ipcRenderer.invoke(IpcChannels.fetchComponent, lcscId),
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
};

contextBridge.exposeInMainWorld("easy2alg", api);
