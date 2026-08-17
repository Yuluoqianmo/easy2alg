import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { AllegroInstall, AllegroVersion } from "../../shared/schemas";
import { writeLog } from "../logging";

const executeFile = promisify(execFile);
const EXECUTABLE_NAME = process.platform === "win32" ? "allegro.exe" : "allegro";
const SUPPORTED_VERSIONS = ["23.1", "22.1", "17.4", "17.2", "16.6"] as const;
const VERSION_HINTS: Readonly<Record<AllegroVersion, readonly string[]>> = {
  "23.1": ["SPB_23.1", "Cadence_SPB_23.1"],
  "22.1": ["SPB_22.1", "Cadence_SPB_22.1"],
  "17.4": ["SPB_17.4", "Cadence_SPB_17.4-2019", "Cadence_SPB_17.4"],
  "17.2": ["SPB_17.2", "Cadence_SPB_17.2-2016", "Cadence_SPB_17.2"],
  "16.6": ["SPB_16.6", "Cadence_SPB_16.6-2015", "Cadence_SPB_16.6"],
};

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

export const allegroVersionFromText = (value: string): AllegroVersion | null => {
  const normalized = value.replaceAll("\\", "/").toUpperCase();
  if (/(?:^|[^0-9])23[._]?1(?:[^0-9]|$)|23[._]?10/.test(normalized)) {
    return "23.1";
  }
  if (/(?:^|[^0-9])22[._]?1(?:[^0-9]|$)|22[._]?10/.test(normalized)) {
    return "22.1";
  }
  if (/(?:^|[^0-9])17[._]?4(?:[^0-9]|$)|17[._]?40/.test(normalized)) {
    return "17.4";
  }
  if (/(?:^|[^0-9])17[._]?2(?:[^0-9]|$)|17[._]?20/.test(normalized)) {
    return "17.2";
  }
  if (/(?:^|[^0-9])16[._]?6(?:[^0-9]|$)|16[._]?60/.test(normalized)) {
    return "16.6";
  }
  return null;
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

const fixedInstallationRoots = (): readonly Candidate[] => {
  if (process.platform !== "win32") {
    return [];
  }
  const parentRoots = [
    "C:\\Cadence",
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Cadence"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Cadence"),
  ];
  return SUPPORTED_VERSIONS.flatMap((version) =>
    parentRoots.flatMap((parentRoot) =>
      VERSION_HINTS[version].flatMap((hint) =>
        executableCandidates(join(parentRoot, hint), version),
      ),
    ),
  );
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

const registryRoot = async (
  hive: "HKLM" | "HKCU",
  version: AllegroVersion,
  registryView: "32" | "64",
): Promise<string | null> => {
  const key = `${hive}\\SOFTWARE\\Cadence Design Systems\\SPB ${version}`;
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
    const processError = error as Error & { code?: number | string };
    if (processError.code === 1) {
      return null;
    }
    throw new Error(`Unable to query Cadence registry key ${key}: ${processError.message}`, {
      cause: processError,
    });
  }
};

const registryCandidates = async (): Promise<readonly Candidate[]> => {
  if (process.platform !== "win32") {
    return [];
  }
  const queries = SUPPORTED_VERSIONS.flatMap((version) =>
    (["HKLM", "HKCU"] as const).flatMap((hive) =>
      (["64", "32"] as const).map(async (registryView) => ({
        version,
        root: await registryRoot(hive, version, registryView),
      })),
    ),
  );
  const results = await Promise.all(queries);
  return results.flatMap((result) =>
    result.root === null ? [] : executableCandidates(result.root, result.version),
  );
};

const executableProductVersion = async (executablePath: string): Promise<AllegroVersion | null> => {
  if (process.platform !== "win32") {
    return allegroVersionFromText(executablePath);
  }
  const script =
    "& { param([string]$path) (Get-Item -LiteralPath $path).VersionInfo.ProductVersion }";
  try {
    const result = await executeFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script, executablePath],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
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
      throw new TypeError(`Selected file is not ${EXECUTABLE_NAME}: ${executablePath}`);
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
        `Unable to determine the supported Allegro version for ${executablePath}`,
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
      ...fixedInstallationRoots(),
      ...cdsRootCandidates(),
      ...pathCandidates(),
      ...(await registryCandidates()),
    ]);
    const inspected = await Promise.all(
      candidates.map((candidate) =>
        this.inspectExecutable(candidate.executablePath, candidate.version),
      ),
    );
    return inspected.filter((install): install is AllegroInstall => install !== null);
  }
}
