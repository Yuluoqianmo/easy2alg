import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

/**
 * Capture 库锁的判定。
 *
 * 实测（2026-10-23，本机 17.4）：Capture 打开某个 .olb 时，会在同目录留一个
 * `<库名>OLBlck`（如 `EASY2ALG.OLBlck`）。但这个锁**只是 Capture 自己的标记文件**，
 * 目标 .olb 本身并没有被独占 —— 同一时刻对该文件做 `open(r+b)`、`rename` 全部成功。
 * 也就是说：锁住的是"Capture 的内存副本 vs 磁盘"，不是文件句柄。
 *
 * 由此得出两条判定：
 *  - 锁文件在、Capture 也在跑 → 真的会被内存里的旧内容覆盖，需要补写；
 *  - 锁文件在、但没有 Capture 进程 → 崩溃/强杀留下的**残留锁**，可以直接忽略。
 *    这类残留不忽略的话，用户会遇到"明明没开 Capture 却一直说库被占用"。
 */

/**
 * 找 `<库名>lck` / `<库名>.lck`。只按同目录、同名（大小写不敏感）匹配，别误伤别的库。
 */
export const captureLockFile = async (libraryPath: string): Promise<string | null> => {
  const directory = dirname(libraryPath);
  const name = basename(libraryPath).toLowerCase();
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return null;
  }
  const found = entries.find((entry) => {
    const lower = entry.toLowerCase();
    return lower === `${name}lck` || lower === `${name}.lck`;
  });
  return found === undefined ? null : join(directory, found);
};

/** tasklist 有点慢（约 100~200ms），短时间内的重复询问走缓存。 */
const RUNNING_CACHE_MS = 2_000;
let runningCache: { at: number; running: boolean } | null = null;

/** Capture.exe 是否在运行。查不到时保守地当作"在跑"，宁可多补写一次。 */
export const isCaptureRunning = async (): Promise<boolean> => {
  const now = Date.now();
  if (runningCache !== null && now - runningCache.at < RUNNING_CACHE_MS) {
    return runningCache.running;
  }
  let running = true;
  try {
    const { stdout } = await executeFile(
      "tasklist",
      ["/FI", "IMAGENAME eq Capture.exe", "/NH"],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    // 没匹配时输出是本地化的提示语（中文系统是 GBK，解码后是乱码），
    // 但进程名本身是 ASCII，能稳定命中。
    running = /capture\.exe/i.test(stdout);
  } catch {
    running = true;
  }
  runningCache = { at: now, running };
  return running;
};

export type CaptureLockState = {
  /** 磁盘上的锁文件（不存在则 null） */
  readonly lockPath: string | null;
  readonly captureRunning: boolean;
  /** true = 此刻写进去会被 Capture 的旧内存副本覆盖，需要写后补写 */
  readonly blocked: boolean;
};

export const captureLockState = async (libraryPath: string): Promise<CaptureLockState> => {
  const lockPath = await captureLockFile(libraryPath);
  if (lockPath === null) {
    return { lockPath: null, captureRunning: false, blocked: false };
  }
  const captureRunning = await isCaptureRunning();
  return { lockPath, captureRunning, blocked: captureRunning };
};

/** 清空缓存（测试用）。 */
export const resetCaptureRunningCache = (): void => {
  runningCache = null;
};
