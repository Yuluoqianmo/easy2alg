import { app, shell } from "electron";
import updaterPackage from "electron-updater";
import {
  RELEASE_PAGE_URL,
  canAutoUpdate,
  humanizeUpdateError,
  initialUpdateState,
  type UpdateState,
} from "../shared/update";
import { writeLog } from "./logging";

const { autoUpdater } = updaterPackage;

type UpdateInfo = updaterPackage.UpdateInfo;
type ProgressInfo = updaterPackage.ProgressInfo;

export type UpdaterController = {
  readonly getState: () => UpdateState;
  /** 检查是否有新版本；已是最新时状态会变成 up-to-date */
  readonly check: () => Promise<UpdateState>;
  /** 下载新版本（只有 available 状态才真的下） */
  readonly download: () => Promise<UpdateState>;
  /** 退出并安装（只有 downloaded 状态才真的装） */
  readonly install: () => void;
  readonly openReleasePage: () => Promise<void>;
  readonly dispose: () => void;
};

type Options = {
  readonly currentVersion: string;
  /** 状态变化时推给界面（主进程往所有窗口广播） */
  readonly notify: (state: UpdateState) => void;
};

/**
 * 自动更新（Windows 安装版）。
 *
 * 设计上只做三件事：检查 → 下载 → 重启安装，每一步都要用户点一下，
 * 不做静默下载（用户可能正在转换，流量和磁盘都不该偷偷用掉）。
 *
 * 免安装版 / 开发模式不接 electron-updater：前者没有安装目录可替换，
 * 后者没有打包时生成的 `app-update.yml`，接了只会抛错。这两种情况界面显示
 * "打开发布页"，让用户手动下载。
 */
export const createUpdaterController = ({
  currentVersion,
  notify,
}: Options): UpdaterController => {
  const support = canAutoUpdate({
    packaged: app.isPackaged,
    portable:
      process.env.PORTABLE_EXECUTABLE_DIR !== undefined ||
      process.env.PORTABLE_EXECUTABLE_FILE !== undefined,
    platform: process.platform,
  });

  let state: UpdateState = {
    ...initialUpdateState(currentVersion),
    supported: support.supported,
    status: support.supported ? "idle" : "unsupported",
    message: support.reason,
  };

  const publish = (patch: Partial<UpdateState>): UpdateState => {
    state = { ...state, ...patch };
    notify(state);
    return state;
  };

  const openReleasePage = async (): Promise<void> => {
    await shell.openExternal(RELEASE_PAGE_URL);
  };

  if (!support.supported) {
    void writeLog("info", "update_disabled", { reason: support.reason });
    return {
      getState: () => state,
      check: async () => state,
      download: async () => state,
      install: () => undefined,
      openReleasePage,
      dispose: () => undefined,
    };
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (message?: unknown) => void writeLog("info", "updater", { message: String(message) }),
    warn: (message?: unknown) => void writeLog("warn", "updater", { message: String(message) }),
    error: (message?: unknown) => void writeLog("error", "updater", { message: String(message) }),
    debug: (message: string) => void writeLog("debug", "updater", { message }),
  };

  /**
   * 测试/内网镜像用：把更新源指到别处（默认读打包时写进 app-update.yml 的 GitHub 仓库）。
   * 只在设置了环境变量时生效，正常安装的用户不会碰到。
   */
  const feedOverride = process.env.EASY2ALG_UPDATE_FEED;
  if (feedOverride !== undefined && feedOverride.trim() !== "") {
    autoUpdater.setFeedURL({ provider: "generic", url: feedOverride.trim() });
    void writeLog("warn", "update_feed_override", { url: feedOverride.trim() });
  }

  const handleCheckingForUpdate = (): void => {
    publish({ status: "checking", message: null });
    void writeLog("info", "update_check_started", { current: state.currentVersion });
  };
  const handleUpdateAvailable = (info: UpdateInfo): void => {
    publish({ status: "available", latestVersion: info.version, percent: 0, message: null });
    void writeLog("info", "update_available", {
      current: state.currentVersion,
      latest: info.version,
    });
  };
  const handleUpdateNotAvailable = (info: UpdateInfo): void => {
    publish({ status: "up-to-date", latestVersion: info.version, percent: 0, message: null });
    void writeLog("info", "update_not_available", {
      current: state.currentVersion,
      latest: info.version,
    });
  };
  const handleDownloadProgress = (progress: ProgressInfo): void => {
    publish({ status: "downloading", percent: progress.percent });
  };
  const handleUpdateDownloaded = (info: UpdateInfo): void => {
    publish({ status: "downloaded", latestVersion: info.version, percent: 100, message: null });
    void writeLog("info", "update_downloaded", { latest: info.version });
  };
  const handleError = (error: Error): void => {
    const message = humanizeUpdateError(error);
    publish({ status: "error", message });
    void writeLog("error", "update_failed", { message, raw: error.message });
  };

  autoUpdater.on("checking-for-update", handleCheckingForUpdate);
  autoUpdater.on("update-available", handleUpdateAvailable);
  autoUpdater.on("update-not-available", handleUpdateNotAvailable);
  autoUpdater.on("download-progress", handleDownloadProgress);
  autoUpdater.on("update-downloaded", handleUpdateDownloaded);
  autoUpdater.on("error", handleError);

  let checking = false;
  const check = async (): Promise<UpdateState> => {
    if (checking) {
      return state;
    }
    checking = true;
    void writeLog("info", "update_check_requested", { current: state.currentVersion });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // 事件里也会报一次；这里兜住 checkForUpdates 直接抛的情况（比如元数据 404）
      const message = humanizeUpdateError(error);
      publish({ status: "error", message });
      void writeLog("error", "update_check_failed", { message });
    } finally {
      checking = false;
    }
    return state;
  };

  let downloading = false;
  const download = async (): Promise<UpdateState> => {
    if (downloading || state.status !== "available") {
      return state;
    }
    downloading = true;
    void writeLog("info", "update_download_requested", { latest: state.latestVersion });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      const message = humanizeUpdateError(error);
      publish({ status: "error", message });
      void writeLog("error", "update_download_failed", { message });
    } finally {
      downloading = false;
    }
    return state;
  };

  const install = (): void => {
    if (state.status !== "downloaded") {
      return;
    }
    void writeLog("info", "update_install_requested", {
      latest: state.latestVersion,
    });
    // isSilent=false：让用户看到安装界面；isForceRunAfter=true：装完自动重开
    autoUpdater.quitAndInstall(false, true);
  };

  const dispose = (): void => {
    autoUpdater.removeListener("checking-for-update", handleCheckingForUpdate);
    autoUpdater.removeListener("update-available", handleUpdateAvailable);
    autoUpdater.removeListener("update-not-available", handleUpdateNotAvailable);
    autoUpdater.removeListener("download-progress", handleDownloadProgress);
    autoUpdater.removeListener("update-downloaded", handleUpdateDownloaded);
    autoUpdater.removeListener("error", handleError);
  };

  return { getState: () => state, check, download, install, openReleasePage, dispose };
};
