import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import type {
  NormalizedSymbol,
  OlbPartSummary,
  OlbWriteOutcome,
  OlbWriteResult,
} from "../../shared/schemas";
import { buildCaptureLibraryXml } from "../conversion/capture-olb";
import { OLB_REFRESH_HINT } from "../../shared/messages";
import { writeLog } from "../logging";
import { captureLockState } from "./capture-lock";

const executeFile = promisify(execFile);

/**
 * 用 Cadence 自带的 orDb Tcl 模块把 Capture 库 XML 写进 .olb。
 *
 * 语义来自本机实测（mode 矩阵：0/1/2 三种各跑一遍再导出回读）：
 *  - mode 0 = **新建库**：目标不存在则按给定路径精确创建；目标已存在则静默
 *    改名（t.OLB → t1.OLB）。因此新建前必须确保路径不存在。
 *  - mode 1/2 = **追加**：打开已有库写入，同名器件覆盖不重复，并自动留
 *    `<名字>_0.OBK` 备份。两种 mode 在本次实测中行为一致，统一用 1。
 *
 * 只依赖 tools/bin 下的 tclsh.exe 与 orDb_Dll_Tcl64.dll，不需要拉起
 * Capture GUI（用户要求 GUI 只能由本人启动）。
 */

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Capture 的库锁文件：`<库名>lck`（实测 `EASY2ALG.OLBlck`），有的版本写成 `.lck`。
 * 判定逻辑（含"残留锁"与"Capture 是否真在跑"）见 capture-lock.ts。
 */

/** Tcl 双引号字符串转义：反斜杠、引号、$ 与 [] 都必须在字面量里失效。 */
const tclString = (value: string): string =>
  value.replace(/\\/g, "/").replace(/(["$[\]])/g, "\\$1");

const RUNNER_TEMPLATE = (
  root: string,
  dllPath: string,
  xmlPath: string,
  olbPath: string,
  logPath: string,
  statusPath: string,
  mode: number,
): string => `set root "${tclString(root)}"
set env(PATH) "$root;$env(PATH)"
set statusFh ""
proc E2A_Status {pText} {
  global statusFh
  if {$statusFh eq ""} { set statusFh [open $::e2aStatusPath "a"] }
  puts $statusFh $pText
  flush $statusFh
}
set e2aStatusPath "${tclString(statusPath)}"
if {[file exists $e2aStatusPath]} { file delete -force $e2aStatusPath }
set loadStatus [catch {load "${tclString(dllPath)}" DboTclWriteBasic} loadResult]
E2A_Status "loadStatus=$loadStatus"
if {$loadStatus != 0} {
  E2A_Status "result=error"
  E2A_Status "message=$loadResult"
  close $statusFh
  exit 0
}
set importStatus [catch {XMATIC_XML2OLB "${tclString(xmlPath)}" "${tclString(olbPath)}" ${mode} "${tclString(logPath)}" ""} importResult]
E2A_Status "catchStatus=$importStatus"
E2A_Status "importResult=$importResult"
if {$importStatus != 0} {
  E2A_Status "result=error"
  E2A_Status "message=$importResult"
} else {
  E2A_Status "result=ok"
}
close $statusFh
exit 0
`;

const EXPORT_TEMPLATE = (
  root: string,
  dllPath: string,
  olbPath: string,
  xmlPath: string,
): string => `set root "${tclString(root)}"
set env(PATH) "$root;$env(PATH)"
load "${tclString(dllPath)}" DboTclWriteBasic
catch {XMATIC_OLB2XML "${tclString(olbPath)}" "${tclString(xmlPath)}"} result
exit 0
`;

const readStatus = async (statusPath: string): Promise<Map<string, string>> => {
  const content = await readFile(statusPath, "utf8");
  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) {
      entries.set(line.slice(0, index), line.slice(index + 1));
    }
  }
  return entries;
};

export type CaptureToolchain = {
  /** tools/bin 目录（tclsh.exe 与 orDb_Dll_Tcl64.dll 都在这） */
  readonly binDirectory: string;
  readonly tclshPath: string;
  readonly dllPath: string;
};

/**
 * orDb 的 Tcl 桥接 DLL。
 *
 * 17.4 / 23.1 实测都是 `orDb_Dll_Tcl64.dll`，但 Cadence 换过 Tcl 版本号，
 * 新版本（24.1 / 25.1 及以后）可能叫 `orDb_Dll_Tcl86.dll` 之类。先找准确名字，
 * 找不到再退回同目录里任何 `orDb_Dll_Tcl<数字>.dll`（取版本号最大的一个），
 * 否则新版本一装上，写 .olb 就直接报"找不到 tclsh.exe / orDb_Dll_Tcl64.dll"。
 */
const findOrDbTclDll = async (binDirectory: string): Promise<string | null> => {
  const exact = join(binDirectory, "orDb_Dll_Tcl64.dll");
  if (await fileExists(exact)) {
    return exact;
  }
  try {
    const names = (await readdir(binDirectory))
      .filter((name) => /^orDb_Dll_Tcl\d+\.dll$/i.test(name))
      .sort((left, right) => right.localeCompare(left));
    return names.length === 0 ? null : join(binDirectory, names[0]);
  } catch {
    return null;
  }
};

/**
 * 从 allegro.exe 反推 tclsh。
 *
 * 实测 17.4 布局：`<root>/tools/bin/{allegro.exe, tclsh.exe, orDb_Dll_Tcl64.dll}`。
 * 但 Allegro 也可能从 `<root>/tools/pcb/bin/allegro.exe` 启动（allegro-runner 里
 * 有同样的分叉判断），那时 tclsh 仍在 `<root>/tools/bin`，所以两条候选都要试。
 */
export const resolveCaptureToolchain = async (
  allegroExecutablePath: string | null,
): Promise<CaptureToolchain | null> => {
  if (allegroExecutablePath === null) {
    return null;
  }
  const executableDirectory = dirname(allegroExecutablePath);
  const executableParent = dirname(executableDirectory);
  const installationRoot =
    basename(executableParent).toLowerCase() === "pcb"
      ? dirname(dirname(executableParent))
      : dirname(executableParent);
  const candidates = [
    executableDirectory,
    join(installationRoot, "tools", "bin"),
    join(installationRoot, "tools", "pcb", "bin"),
  ];
  for (const candidate of candidates) {
    const tclshPath = join(candidate, "tclsh.exe");
    if (!(await fileExists(tclshPath))) {
      continue;
    }
    const dllPath = await findOrDbTclDll(candidate);
    if (dllPath !== null) {
      return { binDirectory: candidate, tclshPath, dllPath };
    }
  }
  return null;
};

/** 未指定 OLB 时的落点：<封装库目录>/schlib/<源库名>.olb（多器件累加到同一个库）。 */
/**
 * 未指定 .olb 路径时的默认位置。
 * `unified=true`（设置里选了"所有输出放同一个文件夹"）时直接落在库目录下，
 * 不再建 schlib 子目录。
 */
export const autoLibraryPath = (
  libraryDirectory: string,
  libraryName: string,
  unified = false,
): string => {
  const safe = libraryName.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  const fileName = `${safe.length > 0 ? safe : "easy2alg"}.olb`;
  return unified ? join(libraryDirectory, fileName) : join(libraryDirectory, "schlib", fileName);
};

export const olbLibraryNameFrom = (sourcePath: string): string => {
  const base = basename(sourcePath);
  const extension = extname(base);
  return extension.length > 0 ? base.slice(0, -extension.length) : base;
};

/** 把现有 .olb 导出成 XML（用于写入前探测同名器件、写入后校验内容）。 */
const exportLibrary = async (
  toolchain: CaptureToolchain,
  libraryPath: string,
  workDirectory: string,
): Promise<string> => {
  const xmlPath = join(workDirectory, `inspect-${randomUUID()}.xml`);
  const scriptPath = join(workDirectory, `inspect-${randomUUID()}.tcl`);
  await writeFile(
    scriptPath,
    EXPORT_TEMPLATE(toolchain.binDirectory, toolchain.dllPath, libraryPath, xmlPath),
    "utf8",
  );
  await executeFile(toolchain.tclshPath, [scriptPath], {
    cwd: workDirectory,
    encoding: "utf8",
    env: { ...process.env },
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    timeout: 300_000,
  });
  return readFile(xmlPath, "utf8").catch(() => "");
};

/**
 * 把一个导出的库 XML 拆成 `<Package>` 块 —— 一个 Package = 库里一个器件。
 *
 * **不要用"扫 `<Defn name="...">`"的写法找器件**：引脚、图形元素自带 `name` 属性
 * （引脚 Defn 就带 `name="FATAL_ERR#"` 这种），按名字扫会命中第一个引脚，
 * 于是段数/脚数全读成 1/0 —— 写入后的校验因此**恒判"内容不一致"**（其实写对了），
 * 二次确认弹窗里也永远显示"库里现有 1 段 / 0 脚"（2026-10-16 实测复现）。
 */
const libraryParts = (xml: string): { readonly name: string; readonly body: string }[] => {
  const parts: { name: string; body: string }[] = [];
  for (const match of xml.matchAll(/<Package>([\s\S]*?)<\/Package>/g)) {
    const body = match[1];
    // 器件的 Defn 一定同时带 name 与 refdesPrefix（我们生成的与 Cadence 导出的都如此）；
    // 退化时退回"第一个带 name 的 Defn"。
    const defns = [...body.matchAll(/<Defn\b([^>]*?)\/>/g)].map((item) => item[1]);
    const nameOf = (attrs: string): string => / name="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const deviceDefn = defns.find((attrs) => /\brefdesPrefix="/.test(attrs) && nameOf(attrs).length > 0);
    parts.push({ name: nameOf(deviceDefn ?? defns[0] ?? ""), body });
  }
  return parts;
};

/**
 * 从导出的库 XML 里找出某个器件的内容概览。
 *
 * 返回 null = 库里没有这个器件。**注意不能只查名字**：写入后的回读校验若只看
 * `name="X"` 存不存在，旧数据也能通过（用户 2026-10-16 反馈"同名不覆盖，
 * 还是旧数据"），必须把段数/脚数/本体宽度一起比。
 */
export const inspectLibraryPart = (
  xml: string,
  packageName: string,
): OlbPartSummary | null => {
  const part = libraryParts(xml).find((item) => item.name === packageName);
  return part === undefined ? null : summarizePart(part.body);
};

/** 一个 Package 块的概览（段数 / 脚数 / 第 1 段本体宽度）。 */
const summarizePart = (packageBody: string): OlbPartSummary => ({
  sectionCount: Math.max((packageBody.match(/<LibPart>/g) ?? []).length, 1),
  pinCount: (packageBody.match(/<SymbolPinScalar>/g) ?? []).length,
  bodyWidth: firstSectionBodyWidth(packageBody),
});

/**
 * 本体宽度 = **第 1 段里第一个 `<Rect>`** 的宽度。
 *
 * 必须和生成端的 `incomingSummary`（取 `sections[0].shapes` 里第一个 rect）用同一个
 * 定义，否则校验必然误判：
 *  - 用 `<SymbolBBox>` 会带上外伸引脚（510 vs 506）；
 *  - 取"全器件面积最大的 Rect"会选到另一个更宽的段（PEX8748 实测 971 vs 506）。
 */
const firstSectionBodyWidth = (packageBody: string): number | null => {
  const firstLibPart = /<LibPart>([\s\S]*?)<\/LibPart>/.exec(packageBody)?.[1] ?? packageBody;
  const attrs = /<Rect>\s*<Defn ([^>]*?)\/>/.exec(firstLibPart)?.[1];
  if (attrs === undefined) {
    return null;
  }
  const num = (key: string): number =>
    Number(new RegExp(`\\b${key}="(-?[\\d.]+)"`).exec(attrs)?.[1] ?? "NaN");
  const [x1, x2] = [num("x1"), num("x2")];
  return Number.isNaN(x1) || Number.isNaN(x2) ? null : Math.abs(x2 - x1);
};

/**
 * 一次导出拿到整个库里所有器件的概览（补写队列用：判断这次写入有没有被 Capture 覆盖）。
 *
 * 必须整库一次读完：队列里可能压着同一个库的十来个器件，逐器件导出会把
 * XMATIC_OLB2XML 跑十来遍（每遍几秒）。导出失败（库被删/正在被改写）时返回空表。
 */
export const readLibraryParts = async (
  toolchain: CaptureToolchain,
  libraryPath: string,
): Promise<ReadonlyMap<string, OlbPartSummary>> => {
  const workDirectory = join(tmpdir(), `easy2alg-olb-${randomUUID()}`);
  await mkdir(workDirectory, { recursive: true });
  try {
    const xml = await exportLibrary(toolchain, libraryPath, workDirectory);
    const parts = new Map<string, OlbPartSummary>();
    if (xml.length === 0) {
      return parts;
    }
    for (const part of libraryParts(xml)) {
      if (part.name.length > 0) {
        parts.set(part.name, summarizePart(part.body));
      }
    }
    return parts;
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
};

export type OlbWriteOptions = {
  readonly symbol: NormalizedSymbol;
  readonly toolchain: CaptureToolchain;
  /** 目标 .olb 绝对路径；不存在时会被创建 */
  readonly libraryPath: string;
  /**
   * 目标库里已有同名器件时是否直接覆盖。
   * false（默认）= 先返回 needsConfirm，由界面做二次确认（用户要求）。
   */
  readonly confirmOverwrite?: boolean;
  /** 是否把 PCB 封装名写进器件的 PCB Footprint 字段（默认写） */
  readonly fillPcbFootprint?: boolean;
  /**
   * 写库前是否强制把引脚连接端吸附到 100 mil（用户 2026-10-20：跟随界面吸附开关）。
   * 默认 true；false 时按实际坐标写，整数仍由生成器的 grid() 保证。
   */
  readonly snapPins?: boolean;
};

/** 本次要写进去的器件概览（用来和库里的旧内容比对）。 */
export const incomingSummary = (symbol: NormalizedSymbol): OlbPartSummary => {
  const section = symbol.sections[0];
  const rect = section?.shapes.find((shape) => shape.kind === "rect");
  return {
    sectionCount: symbol.sections.length,
    pinCount: symbol.sections.reduce((total, item) => total + item.pins.length, 0),
    bodyWidth:
      rect === undefined || rect.kind !== "rect"
        ? null
        : Math.abs(rect.max.x - rect.min.x),
  };
};

/** 器件内容是否一致（段数 / 脚数 / 本体宽度）。补写判定也复用它。 */
export const samePartSummary = (a: OlbPartSummary, b: OlbPartSummary): boolean =>
  a.sectionCount === b.sectionCount && a.pinCount === b.pinCount && a.bodyWidth === b.bodyWidth;

/**
 * 从导出的库 XML 里取某个器件的引脚名（按出现顺序）。库里没有该器件返回 null。
 * 只用于"内容是否完全一致"的判定 —— 概览（段数/脚数/宽度）看不出引脚改名。
 */
const packagePinNames = (xml: string, packageName: string): string[] | null => {
  const part = libraryParts(xml).find((item) => item.name === packageName);
  if (part === undefined) {
    return null;
  }
  return [...part.body.matchAll(/<SymbolPinScalar>\s*<Defn\b([^>]*?)\/>/g)].map(
    (match) => / name="([^"]*)"/.exec(match[1])?.[1] ?? "",
  );
};

const samePinNames = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((name, index) => name === right[index]);
};

const timestamp = (): string => {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
};

export const writeCaptureLibrary = async (
  options: OlbWriteOptions,
): Promise<OlbWriteOutcome> => {
  const { symbol, toolchain, libraryPath } = options;
  // Capture 打开着库时会留一个 `<库名>lck`（实测 `EASY2ALG.OLBlck`）。但这个文件只是
  // Capture 自己的标记，**目标 .olb 并没有被独占**（2026-10-23 实测：同目录里躺着
  // EASY2ALG.OLBlck 时，对该文件 open(r+b) / rename 全部成功，XMATIC_XML2OLB 也能正常
  // 导入）。所以这里不再拒绝写入，而是"照写 + 交给调用方登记补写"：
  //  - 写完 Capture 里看不到（它用的是内存里的旧副本），关掉该库窗口再打开才有；
  //  - 用户若在 Capture 里保存了该库，会用旧内容覆盖我们的写入 → 由 olb-pending
  //    在锁消失后自动重放一次，最终结果仍然是我们生成的内容。
  const lock = await captureLockState(libraryPath);
  if (lock.blocked) {
    await writeLog("warn", "olb_locked_by_capture", {
      libraryPath,
      lockPath: lock.lockPath,
      action: "write-through",
    });
  } else if (lock.lockPath !== null) {
    // 崩溃/强杀留下的残留锁：没有 Capture 进程就没人会覆盖，直接当没锁。
    await writeLog("info", "olb_stale_lock_ignored", {
      libraryPath,
      lockPath: lock.lockPath,
    });
  }
  const existedBefore = await fileExists(libraryPath);
  const mode = existedBefore ? 1 : 0;
  await mkdir(dirname(libraryPath), { recursive: true });

  const workDirectory = join(tmpdir(), `easy2alg-olb-${randomUUID()}`);
  await mkdir(workDirectory, { recursive: true });
  const incoming = incomingSummary(symbol);

  // 写入前先看一眼目标库：已有同名器件就必须让用户确认（二次提醒）。
  // 实测 mode 1 会覆盖同名器件，但旧版校验只查名字 —— 旧数据也能通过，
  // 所以这里把"库里的旧内容"和"本次要写的内容"都摆出来给用户看。
  //
  // 例外：内容**完全一致**时不问。用户 2026-10-23 的实际情况就是——器件其实早写进去了，
  // 只是 Capture 缓存着看不到，他以为失败又点了一次，结果弹"已有同名器件，1段9脚 → 1段9脚"，
  // 更容易让人以为是工具没写。内容一样就没什么可覆盖的，直接重写一遍即可。
  let existing: OlbPartSummary | null = null;
  let identical = false;
  if (existedBefore) {
    const before = await exportLibrary(toolchain, libraryPath, workDirectory).catch(() => "");
    existing = before.length > 0 ? inspectLibraryPart(before, symbol.name) : null;
    // 概览只比段数/脚数/本体宽度，太粗：改一个引脚名它看不出来。所以再比一遍引脚名，
    // 只有"概览一致 + 引脚名一致"才算真的相同，才跳过确认。
    identical =
      existing !== null &&
      samePartSummary(existing, incoming) &&
      samePinNames(
        packagePinNames(before, symbol.name) ?? [],
        symbol.sections.flatMap((section) => section.pins.map((pin) => pin.name)),
      );
    if (identical) {
      await writeLog("info", "olb_rewrite_identical", {
        libraryPath,
        packageName: symbol.name,
        summary: JSON.stringify(incoming),
      });
    }
    if (existing !== null && options.confirmOverwrite !== true && !identical) {
      await writeLog("info", "olb_overwrite_needs_confirm", {
        libraryPath,
        packageName: symbol.name,
        existing: JSON.stringify(existing),
        incoming: JSON.stringify(incoming),
      });
      return {
        status: "needsConfirm",
        libraryPath,
        packageName: symbol.name,
        existing,
        incoming,
      };
    }
  }

  // 目标已存在时先自己留一份带时间戳的备份（工具自带的 *_0.OBK 名字不直观）。
  let backupPath: string | null = null;
  if (existedBefore) {
    backupPath = `${libraryPath}.${timestamp()}.bak`;
    await copyFile(libraryPath, backupPath);
  }

  const xmlPath = join(workDirectory, "library.xml");
  const logPath = join(workDirectory, "import.log");
  const statusPath = join(workDirectory, "import-status.txt");
  const runnerPath = join(workDirectory, "import.tcl");
  const verifyScriptPath = join(workDirectory, "verify.tcl");
  const exportPath = join(workDirectory, "verify.xml");

  // 导入器按根 <Defn name> 定位目标库，必须与实际路径一致。
  await writeFile(
    xmlPath,
    buildCaptureLibraryXml(symbol, libraryPath, {
      fillPcbFootprint: options.fillPcbFootprint,
      snapPins: options.snapPins,
    }),
    "utf8",
  );
  await writeFile(
    runnerPath,
    RUNNER_TEMPLATE(
      toolchain.binDirectory,
      toolchain.dllPath,
      xmlPath,
      libraryPath,
      logPath,
      statusPath,
      mode,
    ),
    "utf8",
  );

  // mode 1 时工具会在目标同目录留 `<_0.OBK>`；若它不是本次产生的就别碰。
  const autoBackupPath = join(
    dirname(libraryPath),
    `${basename(libraryPath, extname(libraryPath))}_0.OBK`,
  );
  const autoBackupExisted = await fileExists(autoBackupPath);

  const runTcl = async (scriptPath: string): Promise<string> => {
    const result = await executeFile(toolchain.tclshPath, [scriptPath], {
      cwd: workDirectory,
      encoding: "utf8",
      env: { ...process.env },
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      timeout: 300_000,
    });
    return `${result.stdout}\n${result.stderr}`;
  };

  let runOutput = "";
  try {
    runOutput = await runTcl(runnerPath);
  } catch (error) {
    const processError = error as Error & { stdout?: string; stderr?: string };
    await writeLog("error", "olb_import_process_failed", {
      libraryPath,
      message: processError.message,
      stderr: processError.stderr ?? "",
    });
    throw new Error(
      `调用 Cadence Tcl 写入 OLB 失败：${processError.message}${
        processError.stderr !== undefined && processError.stderr.length > 0
          ? `\n${processError.stderr}`
          : ""
      }`,
    );
  }

  const status = await readStatus(statusPath).catch(() => new Map<string, string>());
  const importLog = await readFile(logPath, "utf8").catch(() => "");
  if (status.get("result") !== "ok") {
    await writeLog("error", "olb_import_rejected", {
      libraryPath,
      status: [...status.entries()].map(([key, value]) => `${key}=${value}`).join(" "),
      runOutput,
      importLog,
    });
    throw new Error(
      `Cadence 拒绝了库 XML：${status.get("message") ?? "未知错误"}\n${importLog || runOutput}`,
    );
  }

  // 回读校验：导出成品库，比对器件**内容**（段数/脚数/本体宽度）。
  // 只查名字是不够的 —— 同名旧数据也能通过，那正是"写了却还是旧数据"的假象。
  await writeFile(
    verifyScriptPath,
    EXPORT_TEMPLATE(toolchain.binDirectory, toolchain.dllPath, libraryPath, exportPath),
    "utf8",
  );
  await runTcl(verifyScriptPath);
  const exported = await readFile(exportPath, "utf8").catch(() => "");
  const after = exported.length > 0 ? inspectLibraryPart(exported, symbol.name) : null;
  if (after === null) {
    await writeLog("error", "olb_verify_failed", { libraryPath, packageName: symbol.name });
    throw new Error(
      `OLB 已写入但回读未找到器件 ${symbol.name}，请检查 ${libraryPath}。`,
    );
  }
  if (!samePartSummary(after, incoming)) {
    await writeLog("error", "olb_verify_stale", {
      libraryPath,
      packageName: symbol.name,
      after: JSON.stringify(after),
      incoming: JSON.stringify(incoming),
    });
    throw new Error(
      `OLB 里 ${symbol.name} 的内容与本次写入不一致（库中 ${after.sectionCount} 段 / ${after.pinCount} 脚，` +
        `本次 ${incoming.sectionCount} 段 / ${incoming.pinCount} 脚）。` +
        (lock.blocked
          ? "Capture 正好在保存这个库，把旧内容写了回去；已登记补写，关掉该库后会自动重试。"
          : "请确认该库没有被其它程序（Capture 之外的）打开后重试。"),
    );
  }

  if (!autoBackupExisted) {
    await rm(autoBackupPath, { force: true }).catch(() => undefined);
  }
  await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);

  const fileSize = (await stat(libraryPath)).size;
  const pinned = symbol.sections.reduce((total, section) => total + section.pins.length, 0);
  await writeLog("info", "olb_written", {
    libraryPath,
    packageName: symbol.name,
    sections: symbol.sections.length,
    pins: pinned,
    mode,
    bytes: fileSize,
  });
  return {
    status: "written",
    result: {
      libraryPath,
      created: !existedBefore,
      packageName: symbol.name,
      sectionCount: symbol.sections.length,
      pinCount: pinned,
      backupPath,
      bytes: fileSize,
      // 锁还在 → 调用方（index.ts）据此登记补写；Capture 关掉该库后会自动重放。
      // 内容本来就一致时不登记：Capture 手里那份和我们要写的完全相同，覆盖也没损失。
      captureLockPath: lock.blocked ? lock.lockPath : null,
      pendingWrite: lock.blocked && !identical,
      identical,
      previous: existing,
      message: lock.blocked
        ? identical
          ? `${symbol.name} 在 ${basename(libraryPath)} 里已经是这个内容（${symbol.sections.length} 段 / ${pinned} 脚），本次重写了一遍。` +
            `${OLB_REFRESH_HINT}。`
          : `已写入 ${basename(libraryPath)}（${symbol.sections.length} 段 / ${pinned} 脚）。` +
            `${OLB_REFRESH_HINT}；之后会自动补写一次，保存也不会把它冲掉。`
        : identical
          ? `${basename(libraryPath)} 里已有完全相同的内容（${symbol.sections.length} 段 / ${pinned} 脚），本次按原样重写了一遍。`
          : existedBefore
            ? `已写入 ${basename(libraryPath)}（${symbol.sections.length} 段 / ${pinned} 脚，内容已核对）`
            : `已新建 ${basename(libraryPath)}（${symbol.sections.length} 段 / ${pinned} 脚）`,
    },
  };
};
