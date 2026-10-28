import { describe, expect, it } from "vitest";
import {
  canAutoUpdate,
  describeUpdate,
  humanizeUpdateError,
  initialUpdateState,
  type UpdateState,
} from "../src/shared/update";

/**
 * 自动更新（用户 2026-10-27：软件要能自己发现新版本）。
 *
 * electron-updater 本身不好在单测里跑，所以把「什么环境能更新」「按钮叫什么」
 * 「错误怎么说人话」这三块纯逻辑抽到 shared/update.ts 里锁住；
 * 主进程那层只负责把事件翻译成 UpdateState。
 */
const state = (patch: Partial<UpdateState>): UpdateState => ({
  ...initialUpdateState("0.1.63"),
  ...patch,
});

describe("canAutoUpdate", () => {
  it("only allows the installed Windows build", () => {
    expect(
      canAutoUpdate({ packaged: true, portable: false, platform: "win32" }).supported,
    ).toBe(true);
  });

  it("refuses dev mode, portable build and other platforms with a readable reason", () => {
    const dev = canAutoUpdate({ packaged: false, portable: false, platform: "win32" });
    expect(dev.supported).toBe(false);
    expect(dev.reason).toContain("开发模式");

    // 免安装版没有安装目录，NSIS 那套替换文件的做法不成立
    const portable = canAutoUpdate({ packaged: true, portable: true, platform: "win32" });
    expect(portable.supported).toBe(false);
    expect(portable.reason).toContain("免安装版");

    const mac = canAutoUpdate({ packaged: true, portable: false, platform: "darwin" });
    expect(mac.supported).toBe(false);
    expect(mac.reason).toContain("发布页");
  });
});

describe("describeUpdate", () => {
  it("offers a check button before anything happened", () => {
    const summary = describeUpdate(state({ status: "idle" }));
    expect(summary.action).toBe("check");
    expect(summary.title).toContain("v0.1.63");
    expect(summary.busy).toBe(false);
  });

  it("locks the button while checking and downloading", () => {
    expect(describeUpdate(state({ status: "checking" })).action).toBeNull();
    expect(describeUpdate(state({ status: "checking" })).busy).toBe(true);
    const downloading = describeUpdate(state({ status: "downloading", percent: 42.4 }));
    expect(downloading.action).toBeNull();
    expect(downloading.detail).toContain("42%");
  });

  it("asks for a download when a newer version exists", () => {
    const summary = describeUpdate(
      state({ status: "available", latestVersion: "0.1.64", currentVersion: "0.1.63" }),
    );
    expect(summary.title).toContain("v0.1.64");
    expect(summary.action).toBe("download");
    expect(summary.actionLabel).toBe("下载更新");
  });

  it("asks for a restart once the package is downloaded", () => {
    const summary = describeUpdate(state({ status: "downloaded", latestVersion: "0.1.64" }));
    expect(summary.action).toBe("install");
    expect(summary.actionLabel).toBe("重启并安装");
  });

  it("falls back to the release page when updates are unsupported", () => {
    const summary = describeUpdate(
      state({ status: "unsupported", supported: false, message: "免安装版不支持自动更新。" }),
    );
    expect(summary.action).toBe("open-release");
    expect(summary.detail).toBe("免安装版不支持自动更新。");
  });

  it("keeps a retry button on failure", () => {
    const summary = describeUpdate(state({ status: "error", message: "连不上 GitHub" }));
    expect(summary.action).toBe("check");
    expect(summary.actionLabel).toBe("重试");
    expect(summary.detail).toBe("连不上 GitHub");
  });

  it("clamps the progress percentage into 0–100", () => {
    expect(describeUpdate(state({ status: "downloading", percent: -5 })).detail).toContain("0%");
    expect(describeUpdate(state({ status: "downloading", percent: 480 })).detail).toContain("100%");
  });
});

describe("humanizeUpdateError", () => {
  it("explains a missing latest.yml instead of leaking the 404", () => {
    expect(humanizeUpdateError(new Error("HttpError: 404 Not Found"))).toContain("latest.yml");
  });

  it("explains network failures", () => {
    expect(humanizeUpdateError(new Error("net::ERR_INTERNET_DISCONNECTED"))).toContain("网络");
    expect(humanizeUpdateError(new Error("getaddrinfo ENOTFOUND api.github.com"))).toContain(
      "GitHub",
    );
  });

  it("explains a checksum mismatch", () => {
    expect(humanizeUpdateError(new Error("sha512 checksum mismatch"))).toContain("校验失败");
  });

  it("keeps unknown errors verbatim so they can be reported", () => {
    expect(humanizeUpdateError(new Error("something odd happened"))).toBe(
      "something odd happened",
    );
    expect(humanizeUpdateError("plain string")).toBe("plain string");
  });
});
