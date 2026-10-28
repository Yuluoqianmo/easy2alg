import { describe, expect, it } from "vitest";
import { createAllegroSourceBundle } from "../src/main/conversion/allegro-skill";
import {
  localPadPolygon,
  normalizePolygon,
  offsetPolygon,
  polygonSignedArea,
  scalePolygon,
} from "../src/main/conversion/geometry";
import { createConversionPlan } from "../src/main/conversion/validate";
import type { NormalizedFootprint, NormalizedPad, Point } from "../src/shared/schemas";

/**
 * 异形焊盘（`PAD~POLYGON`）→ Allegro shape symbol。
 *
 * 用户 2026-10-27 报的 HT7533-1（C49023473）2 号焊盘：1.9 × 5.38mm 的"本体 + 细长引脚"，
 * 修复前被 padFigure() 当矩形画（铜皮错、还不报错）。这里锁住三件事：
 *  1. 多边形变换的数学不变量（局部化后按 rotation 摆回去要等于原多边形）；
 *  2. 外扩/缩放这两个几何操作的数值；
 *  3. SKILL 源里必须引用 `.ssm`，且不再出现矩形图元。
 */

const square = (half: number): readonly Point[] => [
  { x: -half, y: -half },
  { x: half, y: -half },
  { x: half, y: half },
  { x: -half, y: half },
];

const rotate = (point: Point, angleDegrees: number): Point => {
  const radians = (angleDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: point.x * cosine - point.y * sine,
    y: point.x * sine + point.y * cosine,
  };
};

const pad = (overrides: Partial<NormalizedPad>): NormalizedPad => ({
  number: "1",
  center: { x: 0, y: 0 },
  width: 1,
  height: 1,
  rotation: 0,
  shape: "rectangle",
  polygon: [],
  plated: true,
  holeWidth: 0,
  holeHeight: 0,
  sourceLayerId: 1,
  ...overrides,
});

describe("多边形几何工具", () => {
  it("normalizePolygon 去掉重复点与末尾闭合点", () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 0, y: 0 },
    ];
    expect(normalizePolygon(ring)).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ]);
  });

  it("polygonSignedArea 区分顺逆时针", () => {
    expect(polygonSignedArea(square(1))).toBeCloseTo(4, 9);
    expect(polygonSignedArea([...square(1)].reverse())).toBeCloseTo(-4, 9);
  });

  it("offsetPolygon 把正方形按距离外扩", () => {
    const expanded = offsetPolygon(square(1), 0.2);
    expect(expanded).toHaveLength(4);
    for (const point of expanded) {
      expect(Math.abs(point.x)).toBeCloseTo(1.2, 6);
      expect(Math.abs(point.y)).toBeCloseTo(1.2, 6);
    }
  });

  it("offsetPolygon 对顺时针输入给出同样的外扩结果", () => {
    const expanded = offsetPolygon([...square(1)].reverse(), 0.2);
    for (const point of expanded) {
      expect(Math.abs(point.x)).toBeCloseTo(1.2, 6);
      expect(Math.abs(point.y)).toBeCloseTo(1.2, 6);
    }
  });

  it("offsetPolygon 距离为 0 时原样返回", () => {
    expect(offsetPolygon(square(1), 0)).toEqual(square(1));
  });

  it("scalePolygon 以包围盒中心缩放", () => {
    const scaled = scalePolygon(square(1), 0.5);
    for (const point of scaled) {
      expect(Math.abs(point.x)).toBeCloseTo(0.5, 6);
      expect(Math.abs(point.y)).toBeCloseTo(0.5, 6);
    }
  });

  /**
   * 关键不变量：padstack 图形是"焊盘局部坐标"，引脚再按 rotation 摆到 center。
   * 所以 localPadPolygon 必须满足 center + R(rotation)·local === 原始多边形，
   * 否则铜皮会整体偏移（HT7533-1 实测漏了减中心，偏了 1.36mm）。
   */
  it.each([0, 90, 180, 270, -90])("localPadPolygon 与 pad.rotation=%i 互为逆运算", (rotation) => {
    const center = { x: -1.3563, y: 0.4211 };
    const polygon = square(1.5).map((point) => ({
      x: point.x + center.x,
      y: point.y + center.y,
    }));
    const local = localPadPolygon(pad({ center, rotation, shape: "polygon", polygon }));
    expect(local).toHaveLength(4);
    local.forEach((point, index) => {
      const rotated = rotate(point, rotation);
      expect(rotated.x + center.x).toBeCloseTo(polygon[index].x, 6);
      expect(rotated.y + center.y).toBeCloseTo(polygon[index].y, 6);
    });
  });
});

const footprintWith = (pads: NormalizedPad[]): NormalizedFootprint => {
  const xs = pads.flatMap((item) => [
    item.center.x - item.width / 2,
    item.center.x + item.width / 2,
  ]);
  const ys = pads.flatMap((item) => [
    item.center.y - item.height / 2,
    item.center.y + item.height / 2,
  ]);
  return {
    info: {
      lcscId: "C49023473",
      name: "HT7533-1",
      manufacturer: "TECH PUBLIC",
      manufacturerPartNumber: "HT7533-1(SOT23-5)",
      sourcePackageName: "SOT-89-3_L4.5-W2.4-P1.50-LS4.0-BR",
      targetPackageName: "SOT-89-3_L4_5-W2_4-P1_50-LS4_0-BR",
      assemblyProcess: "SMT",
      description: "HT7533-1",
    },
    pads,
    holes: [],
    lines: [],
    circles: [],
    sourceOrigin: { x: 0, y: 0 },
    bounds: {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    },
    model3d: null,
    sourceJson: "{}",
  };
};

describe("异形焊盘生成 shape symbol", () => {
  const polygonPad = pad({
    number: "2",
    center: { x: -1.3563, y: 0 },
    width: 1.9,
    height: 5.3769,
    rotation: -90,
    shape: "polygon",
    // 简化的"本体 + 引脚"轮廓（HT7533-1 真实数据是 123 点圆弧近似）
    polygon: [
      { x: -3.2329, y: -0.95 },
      { x: 2.1439, y: -0.95 },
      { x: 2.1439, y: -0.33 },
      { x: 0.7537, y: -0.33 },
      { x: 0.7537, y: 0.33 },
      { x: 2.1439, y: 0.33 },
      { x: 2.1439, y: 0.95 },
      { x: -3.2329, y: 0.95 },
    ],
  });
  const rectanglePad = pad({
    number: "1",
    center: { x: -1.9, y: 2.3 },
    width: 1.575,
    height: 0.672,
  });

  const bundle = createAllegroSourceBundle(
    createConversionPlan(footprintWith([polygonPad, rectanglePad])),
    "C:\\Temp\\e2a-poly",
  );
  const source = (name: string) => bundle.sources.find((item) => item.relativePath === name)?.content ?? "";

  it("产出 shape 脚本与 .ssm 清单", () => {
    expect(bundle.shapeScript).toBe("shape.scr");
    expect(bundle.shapeOutputs).toEqual(["p190x538.ssm", "p190x538m.ssm"]);
    expect(bundle.expectedOutputs).toContain("p190x538.ssm");
    expect(bundle.expectedOutputs).toContain("p190x538m.ssm");
  });

  it("padstack 用 ?figure 引用 .ssm，不再画矩形", () => {
    const skill = source("build.il");
    const padstack = skill.slice(skill.indexOf('axlDBCreatePadStack(\n    "P190X538"'));
    expect(padstack).toContain('?figure "p190x538"');
    expect(padstack).toContain('?figure "p190x538m"');
    // 阻焊外扩 0.05 → 尺寸比铜箔每边大 0.05（number() 会去掉末尾 0，按数值比）
    const size = (name: string) => {
      const match = padstack.match(
        new RegExp(`\\?figure "${name}" \\?figureSize ([\\d.]+):([\\d.]+)`),
      );
      expect(match).not.toBeNull();
      return [Number(match![1]), Number(match![2])] as const;
    };
    expect(size("p190x538")[0]).toBeCloseTo(1.9, 4);
    expect(size("p190x538")[1]).toBeCloseTo(5.3768, 4);
    expect(size("p190x538m")[0]).toBeCloseTo(2, 4);
    expect(size("p190x538m")[1]).toBeCloseTo(5.4768, 4);
    // 同一个 padstack 里不能出现矩形图元
    expect(padstack.slice(0, padstack.indexOf("unless(padObj"))).not.toContain("'RECTANGLE");
  });

  it("普通矩形焊盘仍用内建图元", () => {
    const skill = source("build.il");
    expect(skill).toContain("'RECTANGLE");
    expect(skill).toContain('?figureSize 1.575:0.672');
  });

  it("shape 脚本每个符号一张图纸并编译成 .ssm", () => {
    const script = source("shape.scr");
    expect(script.match(/newdrawfillin /g)).toHaveLength(2);
    expect(script.match(/"Shape Symbol"/g)).toHaveLength(2);
    expect(script.match(/skill e2a_compile_shape\(/g)).toHaveLength(2);
    expect(script).toContain('newdrawfillin "C:/Temp/e2a-poly/p190x538.dra" "Shape Symbol" YES');
  });

  it("shape SKILL 把图形建在 ETCH/TOP 上", () => {
    const skill = source("shape.il");
    expect(skill).toContain('axlDBCreateShape(path t "ETCH/TOP")');
    expect(skill).toContain('axlSetSymbolType("shape")');
  });

  it("没有异形焊盘时不生成 shape 步骤", () => {
    const plain = createAllegroSourceBundle(
      createConversionPlan(footprintWith([rectanglePad])),
      "C:\\Temp\\e2a-plain",
    );
    expect(plain.shapeScript).toBeNull();
    expect(plain.shapeOutputs).toEqual([]);
    expect(plain.sources.map((item) => item.relativePath)).not.toContain("shape.scr");
  });
});
