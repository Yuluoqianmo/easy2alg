import type { AllegroInstall, AppSettings } from "../../shared/schemas";
import { writeLog } from "../logging";

type SelectionSettings = Pick<AppSettings, "allegroVersion" | "allegroExecutablePath">;

/**
 * 决定这次转换到底跑哪个 allegro.exe。
 *
 * 优先级：用户手动选过的程序 → 自动探测到的同版本程序 → 没有（生成时直接报错，
 * 绝不拿"默认版本"假装成功）。
 *
 * 手动选中的程序**不再要求**版本号和设置里的下拉值完全一致：那是用户明确指定的
 * 文件，老配置里残留的 23.1 不该让它失效（用户 2026-10-27：手动选 25.1 却报
 * "无法确定版本"，转换时又说找不到 23.1）。
 */
export const resolveAllegroInstall = async (
  settings: SelectionSettings,
  installs: readonly AllegroInstall[],
  inspectManual: (path: string) => Promise<AllegroInstall | null>,
): Promise<AllegroInstall | null> => {
  if (settings.allegroExecutablePath !== null) {
    let manualInstall: AllegroInstall | null = null;
    try {
      manualInstall = await inspectManual(settings.allegroExecutablePath);
    } catch (error) {
      // 手动路径失效（程序被卸载 / 判不出版本）时退回自动探测结果 ——
      // 一个坏路径不该让整次转换直接抛异常。
      await writeLog("warn", "allegro_manual_probe_failed", {
        executablePath: settings.allegroExecutablePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (manualInstall !== null) {
      if (manualInstall.version !== settings.allegroVersion) {
        await writeLog("warn", "allegro_manual_version_mismatch", {
          configured: settings.allegroVersion,
          actual: manualInstall.version,
          executablePath: manualInstall.executablePath,
        });
      }
      return manualInstall;
    }
  }
  return installs.find((candidate) => candidate.version === settings.allegroVersion) ?? null;
};
