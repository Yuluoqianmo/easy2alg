import { z } from "zod";

/**
 * Allegro 版本号的统一处理（主进程探测、设置持久化、界面下拉共用）。
 *
 * 两条规则：
 *
 * 1. **不写死版本列表**（用户 2026-10-27）。Cadence 基本每年发一版
 *    （16.6 → 17.2 → 17.4 → 22.1 → 23.1 → 24.1 → 25.1 ...）。以前写成
 *    z.enum(["23.1", ...])，枚举一落后就有两个连锁故障：界面下拉里没有 24.1 / 25.1；
 *    手动选中 `C:\Cadence\SPB_25.1\tools\bin\allegro.exe` 会被判"无法确定版本"。
 *
 * 2. **是什么就显示什么**（用户 2026-10-27）。读到的版本号原样保留，绝不换算：
 *    程序报 `25.10.000` 就显示 `25.10.000`，不做"补零还原成 25.1"这种猜测。
 *    版本号是要拿去和用户对账的，猜错比显示得难看糟糕得多。
 */
export const ALLEGRO_VERSION_PATTERN = /^\d{1,2}(?:\.\d{1,4})+$/;

export const AllegroVersionSchema = z
  .string()
  .trim()
  .regex(ALLEGRO_VERSION_PATTERN, "Allegro 版本号应形如 25.1 或 25.10.000");
export type AllegroVersion = z.infer<typeof AllegroVersionSchema>;

/**
 * 已知版本（新 → 旧）。**只用于**自动扫描安装目录、界面下拉的默认顺序和默认值；
 * 不在这里的新版本照样能用手动选择 + 目录扫描识别出来。
 */
export const KNOWN_ALLEGRO_VERSIONS: readonly AllegroVersion[] = [
  "25.1",
  "24.1",
  "23.1",
  "22.1",
  "17.4",
  "17.2",
  "16.6",
];

const versionSegments = (version: AllegroVersion): readonly number[] =>
  version.split(".").map(Number);

/**
 * 逐段数值比较（`25.10.000` 按 25 / 10 / 0 比，不做补零换算）。
 * 升序：a 比 b 新 → 正数；界面排序时反过来用。
 */
export const compareAllegroVersions = (a: AllegroVersion, b: AllegroVersion): number => {
  const left = versionSegments(a);
  const right = versionSegments(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

export const isAllegroVersion = (value: string): value is AllegroVersion =>
  ALLEGRO_VERSION_PATTERN.test(value);

export const allegroVersionLabel = (version: AllegroVersion): string =>
  `Cadence Allegro ${version}`;

/**
 * 从任意文字里读 Allegro 版本：安装路径（`C:\Cadence\SPB_25.1\tools\bin\allegro.exe`）、
 * 安装根目录名（`Cadence_SPB_17.4-2019`）、exe 的 ProductVersion / FileVersion
 * （`25.10.000`）都走这里。
 *
 * 取到的是**原样的版本段**（只把作为分隔符的 `_` 写成 `.`），不做任何数值换算：
 * `25.10.000` 就是 `25.10.000`，`17.20.060` 就是 `17.20.060`。
 *
 * 主版本下限 16：15.x 及更早不在支持范围内，也能挡住把路径里的无关数字
 * （年份目录等）误判成版本。
 */
export const allegroVersionFromText = (value: string): AllegroVersion | null => {
  const normalized = value.replaceAll("\\", "/");
  for (const match of normalized.matchAll(/(?:^|[^0-9])(\d{1,2}(?:[._]\d{1,4})+)(?![0-9])/g)) {
    const version = match[1].replaceAll("_", ".");
    if (ALLEGRO_VERSION_PATTERN.test(version) && Number(version.split(".")[0]) >= 16) {
      return version;
    }
  }
  return null;
};
