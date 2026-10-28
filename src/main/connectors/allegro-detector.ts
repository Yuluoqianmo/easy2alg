import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { AllegroInstall, AllegroVersion } from "../../shared/schemas";
import {
  KNOWN_ALLEGRO_VERSIONS,
  allegroVersionFromText,
  compareAllegroVersions,
} from "../../shared/allegro-version";
import { writeLog } from "../logging";

const executeFile = promisify(execFile);
const EXECUTABLE_NAME = process.platform === "win32" ? "allegro.exe" : "allegro";

// 版本解析规则放在 shared 里（界面排序要用同一套），这里转出去方便调用方与测试。
export { allegroVersionFromText };

type Candidate = {
  readonly executablePath: string;
  readonly version: AllegroVersion | null;
};

const isFile = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const subdirectories = async (parent: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    // 没装 Cadence 的机器上 C:\Cadence 根本不存在；权限不足也只是"扫不到"，不该让探测整体失败
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR") {
      return [];
    }
    throw error;
  }
};

/**
 * 安装根目录的命名候选。版本号从目录名读（`SPB_25.1` / `Cadence_SPB_25.1`），
 * 所以 Cadence 以后继续按这个习惯命名的新版本也能扫到；老版本额外带年份后缀。
 */
const versionHints = (version: AllegroVersion): readonly string[] => {
  const legacyNames: Readonly<Record<string, readonly string[]>> = {
    "17.4": ["Cadence_SPB_17.4-2019"],
    "17.2": ["Cadence_SPB_17.2-2016"],
    "16.6": ["Cadence_SPB_16.6-2015"],
  };
  return [`SPB_${version}`, `Cadence_SPB_${version}`, ...(legacyNames[version] ?? [])];
};

const executableCandidates = (
  installationRoot: string,
  version: AllegroVersion,
): readonly Candidate[] => [
  {
    executablePath: join(installationRoot, "tools", "bin", EXECUTABLE_NAME),
    version,
  },
  {
    executablePath: join(installationRoot, "tools", "pcb", "bin", EXECUTABLE_NAME),
    version,
  },
];

const cadenceParentRoots = (): readonly string[] => [
  "C:\\Cadence",
  join(process.env.ProgramFiles ?? "C:\\Program Files", "Cadence"),
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Cadence"),
];

/**
 * 固定安装位置扫描：先按已知版本的目录名拼候选，再**扫一遍父目录里实际的子目录**，
 * 从目录名反读版本 —— 这样 26.1、27.1 这种还没写进代码的版本也能自动发现。
 */
const fixedInstallationRoots = async (): Promise<readonly Candidate[]> => {
  if (process.platform !== "win32") {
    return [];
  }
  const candidates: Candidate[] = [];
  for (const parentRoot of cadenceParentRoots()) {
    for (const version of KNOWN_ALLEGRO_VERSIONS) {
      for (const hint of versionHints(version)) {
        candidates.push(...executableCandidates(join(parentRoot, hint), version));
      }
    }
    for (const directoryName of await subdirectories(parentRoot)) {
      const version = allegroVersionFromText(directoryName);
      if (version !== null) {
        candidates.push(...executableCandidates(join(parentRoot, directoryName), version));
      }
    }
  }
  return candidates;
};

const pathCandidates = (): readonly Candidate[] =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const executablePath = join(entry, EXECUTABLE_NAME);
      return {
        executablePath,
        version: allegroVersionFromText(executablePath),
      };
    });

const cdsRootCandidates = (): readonly Candidate[] => {
  const cdsRoot = process.env.CDSROOT;
  if (cdsRoot === undefined || cdsRoot.length === 0) {
    return [];
  }
  const version = allegroVersionFromText(cdsRoot);
  return version === null ? [] : executableCandidates(cdsRoot, version);
};

/**
 * 注册表里的安装记录：`HKLM\SOFTWARE\Cadence Design Systems\SPB 25.1` 的 `TargetDir`。
 *
 * 子键名是**枚举**出来的（不是按已知版本逐个查），所以装了 25.1 而代码里只认识 23.1
 * 时依然能找到 —— 这正是不写死版本的最后一环。
 */
const registrySubKeys = async (
  hive: "HKLM" | "HKCU",
  registryView: "32" | "64",
): Promise<readonly string[]> => {
  const key = `${hive}\\SOFTWARE\\Cadence Design Systems`;
  try {
    const result = await executeFile("reg.exe", ["query", key, `/reg:${registryView}`], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.split("\\").at(-1) ?? "")
      .filter((name) => /^SPB\s+\d{1,2}\.\d/.test(name));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === 1 || code === "ENOENT") {
      return [];
    }
    await writeLog("warn", "allegro_registry_scan_failed", {
      hive,
      registryView,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
};

const registryTargetDir = async (
  hive: "HKLM" | "HKCU",
  subKey: string,
  registryView: "32" | "64",
): Promise<string | null> => {
  const key = `${hive}\\SOFTWARE\\Cadence Design Systems\\${subKey}`;
  try {
    const result = await executeFile(
      "reg.exe",
      ["query", key, "/v", "TargetDir", `/reg:${registryView}`],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      },
    );
    const match = result.stdout.match(/TargetDir\s+REG_\w+\s+(.+)\s*$/im);
    return match?.[1]?.trim() ?? null;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === 1) {
      return null;
    }
    await writeLog("warn", "allegro_registry_read_failed", {
      key,
      registryView,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const registryCandidates = async (): Promise<readonly Candidate[]> => {
  if (process.platform !== "win32") {
    return [];
  }
  const views = (["HKLM", "HKCU"] as const).flatMap((hive) =>
    (["64", "32"] as const).map((registryView) => ({ hive, registryView })),
  );
  const discovered = await Promise.all(
    views.map(async ({ hive, registryView }) => {
      const candidates: Candidate[] = [];
      for (const subKey of await registrySubKeys(hive, registryView)) {
        const root = await registryTargetDir(hive, subKey, registryView);
        if (root === null) {
          continue;
        }
        const version = allegroVersionFromText(root) ?? allegroVersionFromText(subKey);
        if (version !== null) {
          candidates.push(...executableCandidates(root, version));
        }
      }
      return candidates;
    }),
  );
  return discovered.flat();
};

/**
 * 读 exe 自己的 ProductVersion / FileVersion（形如 `25.10.000`）。
 * 安装路径里没有版本号（用户把程序拷到别处）时的兜底。
 */
const executableProductVersion = async (
  executablePath: string,
): Promise<AllegroVersion | null> => {
  if (process.platform !== "win32") {
    return null;
  }
  // 路径用 PowerShell 单引号字面量嵌进脚本（单引号自身的转义就是写两遍）。
  // 以前写成 `& { param($path) ... }` 再把路径当尾随参数传：参数落进 $args，
  // 脚本里的 $path 永远是空的，这条兜底等于没生效。
  const literal = `'${executablePath.replaceAll("'", "''")}'`;
  const script =
    `$info = (Get-Item -LiteralPath ${literal}).VersionInfo; ` +
    "$info.ProductVersion; $info.FileVersion";
  try {
    const result = await executeFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 20_000,
      },
    );
    return allegroVersionFromText(result.stdout);
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    await writeLog("warn", "allegro_version_read_failed", {
      executablePath,
      message: cause.message,
    });
    return null;
  }
};

const uniqueCandidates = (candidates: readonly Candidate[]): readonly Candidate[] => [
  ...new Map(
    candidates.map((candidate) => [candidate.executablePath.toLowerCase(), candidate]),
  ).values(),
];

export class AllegroDetector {
  async inspectExecutable(
    executablePath: string,
    hintedVersion: AllegroVersion | null,
  ): Promise<AllegroInstall | null> {
    if (basename(executablePath).toLowerCase() !== EXECUTABLE_NAME.toLowerCase()) {
      throw new TypeError(`所选文件不是 ${EXECUTABLE_NAME}：${executablePath}`);
    }
    if (!(await isFile(executablePath))) {
      return null;
    }
    const version =
      hintedVersion ??
      allegroVersionFromText(executablePath) ??
      (await executableProductVersion(executablePath));
    if (version === null) {
      throw new TypeError(
        `无法判断 ${executablePath} 的 Allegro 版本：请选择安装目录下的 ` +
          `tools\\bin\\allegro.exe（例如 C:\\Cadence\\SPB_25.1\\tools\\bin\\allegro.exe）。`,
      );
    }
    return {
      version,
      executablePath,
      detected: true,
    };
  }

  async detect(): Promise<readonly AllegroInstall[]> {
    const candidates = uniqueCandidates([
      ...(await fixedInstallationRoots()),
      ...cdsRootCandidates(),
      ...pathCandidates(),
      ...(await registryCandidates()),
    ]);
    const inspected = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          return await this.inspectExecutable(candidate.executablePath, candidate.version);
        } catch (error) {
          // 单个候选不合法（PATH 里某个同名 exe 判不出版本等）不能拖垮整次探测，
          // 否则界面会直接弹"启动失败"，连已经装好的版本都看不到。
          await writeLog("warn", "allegro_candidate_skipped", {
            executablePath: candidate.executablePath,
            message: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      }),
    );
    const found = inspected.filter((install): install is AllegroInstall => install !== null);
    // 同一路径可能被目录扫描 / 注册表 / PATH 重复命中：去重后按版本从新到旧排，
    // 界面默认就落在机器上装的最新版本上。
    return [...new Map(found.map((install) => [install.executablePath.toLowerCase(), install])).values()].sort(
      (left, right) => compareAllegroVersions(right.version, left.version),
    );
  }
}
