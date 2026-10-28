import { describe, expect, it } from "vitest";
import { createAllegroSourceBundle } from "../src/main/conversion/allegro-skill";
import { createConversionPlan } from "../src/main/conversion/validate";
import { getDemoFootprint } from "../src/shared/demo-fixtures";
import type { NormalizedFootprint, NormalizedPad, Point } from "../src/shared/schemas";

/**
 * SKILL 源码的**语法自检**。
 *
 * 背景（2026-10-28 真机定位）：异形焊盘那段报错文案里放了真实换行，而且
 * `error(...)` 少一个右括号。SKILL reader 不会因此报错退出，它只在日志里写
 * 一行 `a '(' at line N was still unclosed on EOF, ')' added`，然后**把后面整段
 * 代码当成上一条语句的 body 吞掉** —— 表现为 padstack 建了但 `.pad` 没落盘、
 * 引脚/丝印/refdes 全没创建，最后 `create symbol` 报 `Symbol is missing a refdes`。
 * 全程没有任何"语法错误"提示，只有跑到 Allegro 才暴露，所以必须在这里锁死。
 */

type ScanResult = {
  /** 文件结束时的括号深度，必须为 0 */
  readonly depth: number;
  /** 有没有字符串字面量跨行（真实换行会吞掉后续代码） */
  readonly unterminatedLines: readonly number[];
  /** 括号提前闭合（深度变负）的行 */
  readonly negativeLines: readonly number[];
};

const scanSkill = (source: string): ScanResult => {
  let depth = 0;
  let inString = false;
  const unterminatedLines: number[] = [];
  const negativeLines: number[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    let inComment = false;
    for (let cursor = 0; cursor < line.length; cursor += 1) {
      const character = line[cursor];
      if (inString) {
        if (character === "\\") {
          cursor += 1;
          continue;
        }
        if (character === "\"") {
          inString = false;
        }
        continue;
      }
      if (inComment) {
        continue;
      }
      if (character === ";") {
        inComment = true;
        continue;
      }
      if (character === "\"") {
        inString = true;
        continue;
      }
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth < 0) {
          negativeLines.push(index + 1);
        }
      }
    }
    if (inString) {
      unterminatedLines.push(index + 1);
    }
  });
  return { depth, unterminatedLines, negativeLines };
};

const polygonPad = (center: Point): NormalizedPad => ({
  number: "2",
  center,
  width: 1.9,
  height: 5.38,
  rotation: 0,
  shape: "polygon",
  polygon: [
    { x: center.x - 0.95, y: center.y - 1.9 },
    { x: center.x + 0.95, y: center.y - 1.9 },
    { x: center.x + 0.95, y: center.y + 0.9 },
    { x: center.x + 0.33, y: center.y + 0.9 },
    { x: center.x + 0.33, y: center.y + 3.48 },
    { x: center.x - 0.33, y: center.y + 3.48 },
    { x: center.x - 0.33, y: center.y + 0.9 },
    { x: center.x - 0.95, y: center.y + 0.9 },
  ],
  plated: true,
  holeWidth: 0,
  holeHeight: 0,
  sourceLayerId: 1,
});

const withPolygonPad = (footprint: NormalizedFootprint): NormalizedFootprint => ({
  ...footprint,
  // 复用 2 号焊盘的位置，避免与夹具里已有的引脚号冲突（校验会拒绝重复编号）
  pads: [polygonPad({ x: -1.35, y: 0 }), ...footprint.pads.filter((pad) => pad.number !== "2")],
});

const sourcesOf = (
  footprint: NormalizedFootprint,
): readonly { relativePath: string; content: string }[] =>
  createAllegroSourceBundle(createConversionPlan(footprint), "C:/e2a-test").sources;

describe("生成的 SKILL / script 源码语法自检", () => {
  const cases: readonly { name: string; footprint: NormalizedFootprint }[] = [
    { name: "SMD（C2040）", footprint: getDemoFootprint("C2040")! },
    { name: "通孔（C20197）", footprint: getDemoFootprint("C20197")! },
    { name: "异形焊盘（C2040 + POLYGON 2 脚）", footprint: withPolygonPad(getDemoFootprint("C2040")!) },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}：括号配平、字符串不跨行`, () => {
      const sources = sourcesOf(testCase.footprint);
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) {
        const result = scanSkill(source.content);
        expect(
          result.unterminatedLines,
          `${source.relativePath} 第 ${result.unterminatedLines.join(",")} 行的字符串没有闭合`,
        ).toEqual([]);
        expect(result.negativeLines, `${source.relativePath} 括号提前闭合`).toEqual([]);
        expect(result.depth, `${source.relativePath} 末尾有 ${result.depth} 个括号未闭合`).toBe(0);
      }
    });
  }

  it("异形焊盘会生成 shape 脚本，且 .il 里按名字引用 .ssm", () => {
    const bundle = createAllegroSourceBundle(
      createConversionPlan(withPolygonPad(getDemoFootprint("C2040")!)),
      "C:/e2a-test",
    );
    expect(bundle.shapeScript).toBe("shape.scr");
    expect(bundle.shapeOutputs.length).toBeGreaterThan(0);
    const build = bundle.sources.find((source) => source.relativePath === "build.il")!;
    expect(build.content).toContain("?figure \"p190x538\"");
    expect(build.content).not.toContain("?figure 'RECTANGLE ?figureSize 1.90002:5.3768");
  });

  it("skillString 把换行折成 \\n，不留下真实换行", () => {
    // 直接经由 padstack 失败分支的报错文案覆盖：含换行、含括号、含路径分隔符
    const bundle = createAllegroSourceBundle(
      createConversionPlan(withPolygonPad(getDemoFootprint("C2040")!)),
      "C:\\e2a\\job",
    );
    const build = bundle.sources.find((source) => source.relativePath === "build.il")!;
    expect(build.content).toContain("\\n\"");
    // 路径里的反斜杠折成 /，否则 SKILL 会当转义
    expect(build.content).toContain("C:/e2a/job");
  });
});
