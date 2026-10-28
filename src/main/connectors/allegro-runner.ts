import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { AllegroExecutionError } from "../../shared/errors";
import type {
  AllegroInstall,
  AppSettings,
  ConversionPlan,
  ConversionResult,
  GeneratedFile,
  GenerationProgress,
} from "../../shared/schemas";
import { ConversionResultSchema } from "../../shared/schemas";
import { createAllegroSourceBundle } from "../conversion/allegro-skill";
import { writeLog } from "../logging";

const executeFile = promisify(execFile);

const fileExists = async (path: string): Promise<boolean> => {
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

const generatedFile = async (
  absolutePath: string,
  relativePath: string,
  status: GeneratedFile["status"],
): Promise<GeneratedFile> => ({
  relativePath,
  status,
  bytes: (await stat(absolutePath)).size,
});

const executeAllegro = async (
  executablePath: string,
  argumentsList: readonly string[],
  workingDirectory: string,
  processLogName: string,
): Promise<void> => {
  const executableDirectory = dirname(executablePath);
  const executableParent = dirname(executableDirectory);
  const installationRoot =
    basename(executableParent).toLowerCase() === "pcb"
      ? dirname(dirname(executableParent))
      : dirname(executableParent);
  const cadencePaths = [
    executableDirectory,
    join(installationRoot, "tools", "bin"),
    join(installationRoot, "tools", "pcb", "bin"),
  ];
  // 异形焊盘的 shape symbol（.ssm）由作业目录里的 shape.scr 现场生成，
  // 主 build 用 ?figure "<名字>" 引用它。**Allegro 17.4 不读系统环境变量里的
  // padpath**（2026-10-27 实测：设了 OS env 后 axlGetVariableList("padpath") 仍是
  // env 文件的默认值，运行时 axlSetVariable 也不影响符号查找），真正生效的是
  // 「cwd 在 padpath 里」—— Cadence 默认 padpath 首项就是 "."，而我们的 cwd
  // 正是作业目录，所以 .ssm 放作业目录就能被找到。这里仍然把作业目录塞进 OS env
  // padpath，是给可能读它的其它版本留的兜底，不影响 17.4。
  const padPath = [
    workingDirectory,
    ".",
    process.env.padpath ?? process.env.PADPATH ?? "",
  ]
    .filter((entry) => entry.length > 0)
    .join(";");
  try {
    const result = await executeFile(executablePath, [...argumentsList], {
      cwd: workingDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        CDSROOT: installationRoot,
        PATH: [...cadencePaths, process.env.PATH ?? ""].join(";"),
        padpath: padPath,
        psmpath: padPath,
        // 2026-10-15 实测（S2-S14 实验链）：用户 pcbenv/allegro.ilinit 会按
        // $EDA365_SKILL 拼接加载 EDA365_Skill_Load.il，该 SKILL 包使 Allegro 17.4
        // 在 -nograph 批处理回放 newdrawfillin 时直接段错误（交互模式不受影响）。
        // 把 EDA365_SKILL 指向一个确定不存在的子目录，ilinit 里 errset(loadi(...))
        // 静默跳过即可；不动任何用户文件，GUI 侧 EDA365 工具完全不受影响。
        EDA365_SKILL: `${join(workingDirectory, "__e2a_no_eda365__")}${sep}`,
      },
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      timeout: 300_000,
    });
    await writeFile(
      join(workingDirectory, processLogName),
      `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}\n`,
      "utf8",
    );
    await writeLog("info", "allegro_process_completed", {
      executablePath,
      workingDirectory,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
    });
  } catch (error) {
    const processError = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    await writeFile(
      join(workingDirectory, processLogName),
      `stdout:\n${processError.stdout ?? ""}\n\nstderr:\n${processError.stderr ?? ""}\n`,
      "utf8",
    );
    throw new AllegroExecutionError(
      `Allegro failed in ${workingDirectory}: ${processError.message}`,
      {
        executablePath,
        workingDirectory,
        exitCode: typeof processError.code === "number" ? processError.code : null,
        stdout: processError.stdout ?? "",
        stderr: processError.stderr ?? "",
      },
      processError,
    );
  }
};

const snapshotFile = async (
  sourcePath: string,
  destinationPath: string,
): Promise<void> => {
  if (await fileExists(sourcePath)) {
    await copyFile(sourcePath, destinationPath);
  }
};

const verifyBuildStatus = async (
  jobDirectory: string,
  expectedOutputs: readonly string[],
): Promise<void> => {
  const statusPath = join(jobDirectory, "build-status.txt");
  if (!(await fileExists(statusPath))) {
    throw new AllegroExecutionError(
      "Allegro stopped before completing the footprint",
      {
        executablePath: "",
        workingDirectory: jobDirectory,
        exitCode: 0,
        stdout: "",
        stderr: `Missing build status report: ${statusPath}`,
      },
      null,
    );
  }
  const status = await readFile(statusPath, "utf8");
  if (!/^status=ok\r?$/m.test(status)) {
    throw new AllegroExecutionError(
      "Allegro reported an invalid footprint build status",
      {
        executablePath: "",
        workingDirectory: jobDirectory,
        exitCode: 0,
        stdout: status,
        stderr: `Invalid build status report: ${statusPath}`,
      },
      null,
    );
  }
  for (const relativeOutput of expectedOutputs) {
    const outputPath = join(jobDirectory, relativeOutput);
    if (!(await fileExists(outputPath))) {
      throw new AllegroExecutionError(
        `Allegro did not create the expected file ${relativeOutput}`,
        {
          executablePath: "",
          workingDirectory: jobDirectory,
          exitCode: 0,
          stdout: status,
          stderr: `Missing output: ${outputPath}`,
        },
        null,
      );
    }
    if ((await stat(outputPath)).size === 0) {
      throw new AllegroExecutionError(
        `Allegro created an empty file ${relativeOutput}`,
        {
          executablePath: "",
          workingDirectory: jobDirectory,
          exitCode: 0,
          stdout: status,
          stderr: `Empty output: ${outputPath}`,
        },
        null,
      );
    }
  }
};

const writeSources = async (
  jobDirectory: string,
  sources: readonly { readonly relativePath: string; readonly content: string }[],
): Promise<void> => {
  await Promise.all(
    sources.map(async (source) => {
      const outputPath = join(jobDirectory, source.relativePath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, source.content, "utf8");
    }),
  );
};

/**
 * 输出目录布局（用户 2026-10-19 要求"可以选择使用一个文件夹"）：
 *  - 默认：库目录下分 padstacks/ 与 symbols/ 两个子目录；
 *  - unified：两个都直接放库目录，Allegro 的库路径指到库目录即可。
 */
const padstackDirectoryFor = (unified: boolean, libraryDirectory: string): string =>
  unified ? libraryDirectory : join(libraryDirectory, "padstacks");
const symbolDirectoryFor = (unified: boolean, libraryDirectory: string): string =>
  unified ? libraryDirectory : join(libraryDirectory, "symbols");

const copyVerifiedOutputs = async (
  jobDirectory: string,
  libraryDirectory: string,
  unifiedLibraryFolder: boolean,
  expectedOutputs: readonly string[],
): Promise<readonly GeneratedFile[]> => {
  const files: GeneratedFile[] = [];
  for (const relativeOutput of expectedOutputs) {
    const sourcePath = join(jobDirectory, relativeOutput);
    if (!(await fileExists(sourcePath))) {
      throw new AllegroExecutionError(
        `Allegro did not create the expected file ${relativeOutput}`,
        {
          executablePath: "",
          workingDirectory: jobDirectory,
          exitCode: 0,
          stdout: "",
          stderr: `Missing output: ${sourcePath}`,
        },
        null,
      );
    }
    const sourceStats = await stat(sourcePath);
    if (sourceStats.size === 0) {
      throw new AllegroExecutionError(
        `Allegro created an empty file ${relativeOutput}`,
        {
          executablePath: "",
          workingDirectory: jobDirectory,
          exitCode: 0,
          stdout: "",
          stderr: `Empty output: ${sourcePath}`,
        },
        null,
      );
    }
    const outputDirectory =
      relativeOutput.endsWith(".pad") || relativeOutput.endsWith(".ssm")
        ? padstackDirectoryFor(unifiedLibraryFolder, libraryDirectory)
        : symbolDirectoryFor(unifiedLibraryFolder, libraryDirectory);
    const destinationPath = join(outputDirectory, basename(relativeOutput));
    await mkdir(outputDirectory, { recursive: true });
    await copyFile(sourcePath, destinationPath);
    files.push(
      await generatedFile(
        destinationPath,
        `${basename(outputDirectory)}/${basename(relativeOutput)}`,
        "verified",
      ),
    );
  }
  return files;
};

export const verifyPinReport = async (
  verificationPath: string,
  expectedPinCount: number,
): Promise<void> => {
  const content = await readFile(verificationPath, "utf8");
  const match = content.match(/^pins=(\d+)\r?$/m);
  if (match === null) {
    throw new AllegroExecutionError(
      "Allegro verification report does not contain a valid pin count",
      {
        executablePath: "",
        workingDirectory: dirname(verificationPath),
        exitCode: 0,
        stdout: content,
        stderr: `Expected a pins=<number> line for ${expectedPinCount} pins`,
      },
      null,
    );
  }
  const actualPinCount = Number(match[1]);
  if (actualPinCount !== expectedPinCount) {
    throw new AllegroExecutionError(
      `Allegro verification expected ${expectedPinCount} pins but reported ${actualPinCount}`,
      {
        executablePath: "",
        workingDirectory: dirname(verificationPath),
        exitCode: 0,
        stdout: content,
        stderr: `Expected ${expectedPinCount} pins, reported ${actualPinCount}`,
      },
      null,
    );
  }
};

export class AllegroRunner {
  async generate(
    plan: ConversionPlan,
    settings: AppSettings,
    install: AllegroInstall | null,
    reportProgress: (progress: GenerationProgress) => void,
  ): Promise<ConversionResult> {
    const startedAt = new Date().toISOString();
    const progress = (
      stage: GenerationProgress["stage"],
      percent: number,
      message: string,
    ): void => {
      reportProgress({
        lcscId: plan.footprint.info.lcscId,
        stage,
        percent,
        message,
        diagnosticDirectory: null,
        timestamp: new Date().toISOString(),
      });
    };
    progress("preparing", 5, "正在准备封装数据和输出目录");
    const jobDirectory = await mkdtemp(join(tmpdir(), "easy2alg-"));
    await mkdir(join(jobDirectory, "padstacks"), { recursive: true });
    const bundle = createAllegroSourceBundle(plan, jobDirectory);
    await writeSources(jobDirectory, bundle.sources);
    progress("preparing", 20, "封装数据已准备完成");
    await writeLog("info", "conversion_job_created", {
      jobId: randomUUID(),
      lcscId: plan.footprint.info.lcscId,
      jobDirectory,
      allegroVersion: settings.allegroVersion,
    });

    if (install === null) {
      throw new AllegroExecutionError(
        `Cadence Allegro ${settings.allegroVersion} was not found`,
        {
          executablePath: "",
          workingDirectory: jobDirectory,
          exitCode: null,
          stdout: "",
          stderr: `Install Allegro ${settings.allegroVersion} or select another installed version`,
        },
        null,
      );
    }

    await Promise.all([
      mkdir(padstackDirectoryFor(settings.unifiedLibraryFolder, settings.libraryDirectory), {
        recursive: true,
      }),
      mkdir(symbolDirectoryFor(settings.unifiedLibraryFolder, settings.libraryDirectory), {
        recursive: true,
      }),
    ]);
    progress("launching", 30, `正在启动 Allegro ${settings.allegroVersion}`);
    // 异形焊盘：先把 shape symbol（.ssm）画出来，主 build 才能引用。
    // 必须单独跑一趟 —— 同一趟里刚写出的 .ssm 还没进 Allegro 的符号缓存。
    if (bundle.shapeScript !== null) {
      progress("generating", 36, "Allegro 正在生成异形焊盘的形状符号");
      await executeAllegro(
        install.executablePath,
        ["-s", bundle.shapeScript, "-nograph"],
        jobDirectory,
        "shape-process.log",
      );
      await snapshotFile(
        join(jobDirectory, "allegro.jrl"),
        join(jobDirectory, "shape.jrl"),
      );
      for (const shapeOutput of bundle.shapeOutputs) {
        const shapePath = join(jobDirectory, shapeOutput);
        if (!(await fileExists(shapePath)) || (await stat(shapePath)).size === 0) {
          throw new AllegroExecutionError(
            `Allegro did not create the shape symbol ${shapeOutput}`,
            {
              executablePath: install.executablePath,
              workingDirectory: jobDirectory,
              exitCode: 0,
              stdout: "",
              stderr: `Missing shape symbol: ${shapePath}（异形焊盘需要 .ssm 才能生成 padstack）`,
            },
            null,
          );
        }
      }
    }
    progress("generating", 42, "Allegro 正在生成焊盘和封装");
    await executeAllegro(
      install.executablePath,
      ["-s", "build.scr", "-nograph"],
      jobDirectory,
      "build-process.log",
    );
    await snapshotFile(
      join(jobDirectory, "allegro.jrl"),
      join(jobDirectory, "build.jrl"),
    );
    await verifyBuildStatus(jobDirectory, bundle.expectedOutputs);
    progress("generating", 65, "封装文件已经生成");
    const draPath = join(jobDirectory, `${bundle.symbolName}.dra`);
    if (!(await fileExists(draPath))) {
      throw new AllegroExecutionError(
        `Allegro did not create ${bundle.symbolName}.dra`,
        {
          executablePath: install.executablePath,
          workingDirectory: jobDirectory,
          exitCode: 0,
          stdout: "",
          stderr: "The build script completed without the expected drawing database",
        },
        null,
      );
    }
    progress("verifying", 72, "正在回读封装并检查引脚");
    await executeAllegro(
      install.executablePath,
      ["-s", "verify.scr", "-nograph", draPath],
      jobDirectory,
      "verification-process.log",
    );
    await snapshotFile(
      join(jobDirectory, "allegro.jrl"),
      join(jobDirectory, "verification.jrl"),
    );
    await verifyPinReport(
      join(jobDirectory, "verification.txt"),
      plan.footprint.pads.length + plan.footprint.holes.length,
    );
    progress("copying", 90, "检查通过，正在写入封装库目录");
    const files = await copyVerifiedOutputs(
      jobDirectory,
      settings.libraryDirectory,
      settings.unifiedLibraryFolder,
      bundle.expectedOutputs,
    );
    if (files.length !== bundle.expectedOutputs.length) {
      throw new AllegroExecutionError(
        "The generated Allegro file set is incomplete",
        {
          executablePath: install.executablePath,
          workingDirectory: jobDirectory,
          exitCode: 0,
          stdout: "",
          stderr: `Expected ${bundle.expectedOutputs.length} files, copied ${files.length}`,
        },
        null,
      );
    }
    progress("completed", 100, "封装已生成并通过检查");
    return ConversionResultSchema.parse({
      lcscId: plan.footprint.info.lcscId,
      targetPackageName: bundle.symbolName,
      libraryDirectory: settings.libraryDirectory,
      outcome: "success",
      files,
      checks: plan.checks,
      startedAt,
      completedAt: new Date().toISOString(),
      message: "封装已生成并通过 Allegro 回读检查。",
    });
  }
}
