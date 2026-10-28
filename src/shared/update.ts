/**
 * 自动更新的状态模型。
 *
 * 主进程把 electron-updater 的事件翻译成 `UpdateState` 推给界面，界面只按状态渲染；
 * 「能不能自动更新」「按钮该叫什么」这些判断都放在这里 —— 主进程和界面共用一份，
 * 也方便用单元测试锁住文案，避免两处写法慢慢跑偏。
 */

export type UpdateStatus =
  /** 还没查过 */
  | "idle"
  | "checking"
  | "up-to-date"
  /** 有新版，等用户点下载 */
  | "available"
  | "downloading"
  /** 下载完成，等用户重启安装 */
  | "downloaded"
  | "error"
  /** 开发模式 / 免安装版 / 非 Windows：不提供自动更新 */
  | "unsupported";

export type UpdateState = {
  readonly status: UpdateStatus;
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  /** 下载进度 0–100，只在 downloading 时有意义 */
  readonly percent: number;
  readonly message: string | null;
  readonly releaseUrl: string;
  readonly supported: boolean;
};

/** 发布页：拿不到更新元数据时让用户手动下载的兜底出口。 */
export const RELEASE_PAGE_URL = "https://github.com/15artis/easy2alg/releases/latest";

export const initialUpdateState = (currentVersion: string): UpdateState => ({
  status: "idle",
  currentVersion,
  latestVersion: null,
  percent: 0,
  message: null,
  releaseUrl: RELEASE_PAGE_URL,
  supported: true,
});

/**
 * 这次运行到底能不能走自动更新。
 *
 * - 开发模式（`app.isPackaged === false`）没有 `app-update.yml`，electron-updater 会直接抛错；
 * - 免安装版（portable）没有安装目录，NSIS 那套"就地替换文件"不成立；
 * - 目前只发布 Windows 包，其它平台没有对应的更新包。
 */
export const canAutoUpdate = (input: {
  readonly packaged: boolean;
  readonly portable: boolean;
  readonly platform: string;
}): { readonly supported: boolean; readonly reason: string | null } => {
  if (!input.packaged) {
    return { supported: false, reason: "开发模式下不检查更新。" };
  }
  if (input.portable) {
    return { supported: false, reason: "免安装版不支持自动更新，请到发布页下载新版本。" };
  }
  if (input.platform !== "win32") {
    return { supported: false, reason: "当前系统暂不支持自动更新，请到发布页下载新版本。" };
  }
  return { supported: true, reason: null };
};

export type UpdateAction = "check" | "download" | "install" | "open-release";

export type UpdateSummary = {
  readonly title: string;
  readonly detail: string;
  /** 主按钮要触发的动作；null = 没有可点的动作（正在忙） */
  readonly action: UpdateAction | null;
  readonly actionLabel: string | null;
  readonly busy: boolean;
};

/**
 * 把状态翻译成界面上那一行字和主按钮。
 * 文案集中在这里，改一次全站一致。
 */
export const describeUpdate = (state: UpdateState): UpdateSummary => {
  const current = `v${state.currentVersion}`;
  const latest = state.latestVersion === null ? "" : `v${state.latestVersion}`;
  switch (state.status) {
    case "unsupported":
      return {
        title: `当前版本 ${current}`,
        detail: state.message ?? "当前环境不支持自动更新。",
        action: "open-release",
        actionLabel: "打开发布页",
        busy: false,
      };
    case "checking":
      return {
        title: "正在检查更新…",
        detail: `当前版本 ${current}`,
        action: null,
        actionLabel: null,
        busy: true,
      };
    case "up-to-date":
      return {
        title: "已是最新版本",
        detail: `当前版本 ${current}，发布页上还没有更新的版本。`,
        action: "check",
        actionLabel: "重新检查",
        busy: false,
      };
    case "available":
      return {
        title: `发现新版本 ${latest}`,
        detail: `当前版本 ${current}，下载完成后重启软件即可完成安装。`,
        action: "download",
        actionLabel: "下载更新",
        busy: false,
      };
    case "downloading":
      return {
        title: `正在下载 ${latest}`,
        detail: `已完成 ${Math.max(0, Math.min(100, Math.round(state.percent)))}%，请保持网络畅通。`,
        action: null,
        actionLabel: null,
        busy: true,
      };
    case "downloaded":
      return {
        title: `${latest} 已下载完成`,
        detail: "重启软件即可完成安装；正在进行的转换请先保存。",
        action: "install",
        actionLabel: "重启并安装",
        busy: false,
      };
    case "error":
      return {
        title: "检查更新失败",
        detail: state.message ?? "请稍后重试，或到发布页手动下载新版本。",
        action: "check",
        actionLabel: "重试",
        busy: false,
      };
    case "idle":
    default:
      return {
        title: `当前版本 ${current}`,
        detail: "启动时会自动检查一次，也可以手动检查。",
        action: "check",
        actionLabel: "检查更新",
        busy: false,
      };
  }
};

/**
 * electron-updater 的原始报错对用户没意义（`HttpError: 404 ...`、`net::ERR_...`），
 * 这里翻成人话；认不出来的原样返回，方便用户复制给我们排查。
 */
export const humanizeUpdateError = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  if (/404/.test(raw)) {
    return "发布页上还没有可用的更新信息（latest.yml），请到发布页手动下载新版本。";
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|net::/i.test(raw)) {
    return "连不上 GitHub，请检查网络后重试，或到发布页手动下载。";
  }
  if (/sha512|checksum|integrity/i.test(raw)) {
    return "更新包校验失败，已放弃本次更新，请到发布页手动下载。";
  }
  return raw;
};
