import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEasyEdaSymbol } from "../src/main/conversion/easyeda-symbol";
import { RawEasyEdaResponseSchema } from "../src/main/conversion/normalize";
import {
  bodyBoxOf,
  boxesOverlap,
  pinNameBox,
  pinNumberBox,
  pinIsVertical,
  pinSideOf,
} from "../src/shared/symbol-labels";
import { buildCaptureLibraryXml } from "../src/main/conversion/capture-olb";
import { DEFAULT_SYMBOL_TEXT_HEIGHT } from "../src/shared/symbol-labels";
import type { NormalizedSymbol } from "../src/shared/schemas";

/**
 * 立创编号（在线 EasyEDA 标准版）链路的原理图符号。
 *
 * 夹具是两个真实接口响应的 `dataStr` 摘录（C2040 = RP2040 57 脚、C7955 = LM393 8 脚），
 * 只保留解析需要的 head / shape / BBox。别手改这两份数据 —— 它们是格式的唯一依据。
 */
const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/easyeda-symbols.json", import.meta.url)), "utf8"),
) as Record<
  string,
  { title: string; dataStr: unknown; subparts?: { title?: string; dataStr?: unknown }[] }
>;

const parse = (lcscId: string): NormalizedSymbol | null =>
  parseEasyEdaSymbol(fixtures[lcscId].dataStr, {
    lcscId,
    fallbackName: fixtures[lcscId].title,
    pcbFootprint: "PKG_UNDER_TEST",
  });

const labelCollisions = (symbol: NormalizedSymbol): number => {
  let count = 0;
  for (const section of symbol.sections) {
    const body = bodyBoxOf(section);
    const boxes = section.pins.flatMap((pin) => [pinNameBox(pin, body), pinNumberBox(pin, body)]);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        if (boxesOverlap(boxes[i], boxes[j])) {
          count += 1;
        }
      }
    }
  }
  return count;
};

describe("easyeda standard symbol", () => {
  it("parses the 57-pin RP2040 symbol from the same response as the footprint", () => {
    const symbol = parse("C2040");
    expect(symbol).not.toBeNull();
    expect(symbol!.name).toBe("RP2040");
    expect(symbol!.refdesPrefix).toBe("U");
    expect(symbol!.pcbFootprint).toBe("PKG_UNDER_TEST");
    expect(symbol!.sections).toHaveLength(1);
    expect(symbol!.sections[0].pins).toHaveLength(57);
  });

  it("puts every pin's body end exactly on the body rect, and anchors it at (0,0)", () => {
    // 源数据里本体在 (285,100)-(515,480)，引脚本体端就在这两条边上 ——
    // 平移归零后必须仍然精确落在矩形边上（这是"映射正确"的硬证据）。
    const symbol = parse("C2040")!;
    const section = symbol.sections[0];
    const body = bodyBoxOf(section);
    expect(body).toEqual({ minX: 0, minY: 0, maxX: 270, maxY: 380 });
    const onEdge = section.pins.filter((pin) => {
      const onX = Math.abs(pin.body.x - body.minX) < 1e-6 || Math.abs(pin.body.x - body.maxX) < 1e-6;
      const onY = Math.abs(pin.body.y - body.minY) < 1e-6 || Math.abs(pin.body.y - body.maxY) < 1e-6;
      return onX !== onY;
    });
    expect(onEdge).toHaveLength(section.pins.length);
    // 引脚长度 10、间距 10（源符号单位 = Capture 符号单位，不做换算）
    expect(section.pins.every((pin) => pin.length === 10)).toBe(true);
  });

  it("maps pin sides from the EasyEDA rotation (0=右 90=上 180=左 270=下)", () => {
    const section = parse("C2040")!.sections[0];
    const sides = section.pins.reduce<Record<string, number>>((counts, pin) => {
      const side = pinSideOf(pin);
      counts[side] = (counts[side] ?? 0) + 1;
      return counts;
    }, {});
    expect(sides).toEqual({ right: 32, left: 11, top: 12, bottom: 2 });
    // 上下边引脚必须是"竖排"的那批（写 .olb 时靠它决定 IsPinNamesRotated）
    expect(section.pins.filter(pinIsVertical)).toHaveLength(14);
  });

  it("maps the EasyEDA electric code to a Capture pin type", () => {
    const pins = parse("C2040")!.sections[0].pins;
    const byNumber = (number: string) => pins.find((pin) => pin.number === number)!;
    // 实测：RUN/XIN = 1(输入)、QSPI_SCLK/SWCLK = 2(输出)、GPIO = 3(双向)
    expect(byNumber("26").name).toBe("RUN");
    expect(byNumber("26").type).toBe("input");
    expect(byNumber("52").type).toBe("output");
    expect(byNumber("9").type).toBe("bidirectional");
  });

  it("approximates circles/ellipses as closed polylines (LM393 has two)", () => {
    const symbol = parse("C7955")!;
    const kinds = symbol.sections[0].shapes.map((shape) => shape.kind);
    expect(kinds.filter((kind) => kind === "polyline").length).toBeGreaterThanOrEqual(2);
    expect(symbol.sections[0].pins).toHaveLength(8);
  });

  it("de-collides pin labels on the C-number path too", () => {
    for (const id of ["C2040", "C7955"]) {
      expect(labelCollisions(parse(id)!), `${id} 仍有标签重叠`).toBe(0);
    }
  });

  it("produces a writable Capture library XML", () => {
    const symbol = parse("C2040")!;
    const xml = buildCaptureLibraryXml(symbol, "C:/libs/target.OLB");
    expect(xml).toContain('<Defn name="C:/libs/target.OLB" />');
    expect(xml).toContain('<Defn CellName="RP2040" />');
    expect(xml).toContain('pcbFootprint="PKG_UNDER_TEST"');
    expect(xml.match(/<SymbolPinScalar>/g)).toHaveLength(57);
    // 单段器件：字母编号关(2)、同质(1)
    expect(xml).toMatch(/alphabeticNumbering="2" isHomogeneous="1"/);
    // 有上下边引脚 → 引脚名旋转打开
    expect(xml).toContain('<IsPinNamesRotated>\n          <Defn val="1" />');
  });

  it("returns null when the source has no symbol data", () => {
    expect(parseEasyEdaSymbol(undefined, { lcscId: "C1", fallbackName: "X", pcbFootprint: "" })).toBeNull();
    expect(parseEasyEdaSymbol({}, { lcscId: "C1", fallbackName: "X", pcbFootprint: "" })).toBeNull();
    expect(
      parseEasyEdaSymbol({ shape: [] }, { lcscId: "C1", fallbackName: "X", pcbFootprint: "" }),
    ).toBeNull();
  });

  /**
   * 多子部件器件（用户 2026-10-23 报的 C18221391 = AGM609MNA 双 MOSFET）：
   * `result.dataStr.shape` 是空数组，真实图形逐段放在 `result.subparts[].dataStr`。
   * 旧逻辑只读 dataStr → 解析成 null → 界面连预览都没有。
   */
  describe("多子部件器件（subparts）", () => {
    const fixture = fixtures.C18221391;
    const parseMulti = () =>
      parseEasyEdaSymbol(fixture.dataStr, {
        lcscId: "C18221391",
        fallbackName: fixture.title,
        pcbFootprint: "PKG_UNDER_TEST",
        subparts: fixture.subparts,
      });

    it("dataStr 为空壳时，从 subparts 逐段解析成多段符号", () => {
      // 前提：这份真实数据的主 dataStr 确实没有任何图形
      expect((fixture.dataStr as { shape: string[] }).shape).toHaveLength(0);
      const symbol = parseMulti();
      expect(symbol).not.toBeNull();
      expect(symbol!.name).toBe("AGM609MNA");
      // 位号前缀跟源数据走：源 pre = "U?.1" → U（EasyEDA 对多段器件用 U，不是 Q）
      expect(symbol!.refdesPrefix).toBe("U");
      expect(symbol!.sections).toHaveLength(2);
      expect(symbol!.sections.map((section) => section.name)).toEqual([
        "AGM609MNA.1",
        "AGM609MNA.2",
      ]);
      expect(symbol!.sections.map((section) => section.pins.map((pin) => pin.number))).toEqual([
        ["6", "1", "2"],
        ["5", "3", "4"],
      ]);
      expect(symbol!.sections.map((section) => section.pins.map((pin) => pin.name))).toEqual([
        ["D1", "S1", "G1"],
        ["D2", "S2", "G2"],
      ]);
      for (const section of symbol!.sections) {
        expect(section.pins).toHaveLength(3);
        expect(section.shapes.length).toBeGreaterThan(0);
      }
    });

    it("每一段都做标签避让（预览/写库看到的是同一份几何）", () => {
      expect(labelCollisions(parseMulti()!)).toBe(0);
    });

    /**
     * 用户 2026-10-23 第二张截图：引脚吸附网格时只挪了引脚、图形没动，
     * 栅极线/漏源引线看起来"断开一格"。整段一起挪之后引脚端点必须仍落在图元上。
     */
    it("引脚端点落在图元上（吸附网格时整段一起挪）", () => {
      for (const section of parseMulti()!.sections) {
        const points = section.shapes.flatMap((shape) =>
          shape.kind === "polyline" ? shape.points : [],
        );
        for (const pin of section.pins) {
          const onDrawing = points.some(
            (point) =>
              Math.abs(point.x - pin.body.x) < 1e-6 && Math.abs(point.y - pin.body.y) < 1e-6,
          );
          expect(onDrawing, `${section.name} 的引脚 ${pin.number} 没落在图元上`).toBe(true);
        }
      }
    });

    /**
     * 没有矩形本体（MOSFET/三极管/二极管）时，本体必须取**图元包围盒**：
     * 拿含引脚桩的 bounds 当本体，Capture 会把引脚名画在引脚末端、脚号画到框外。
     */
    it("没有矩形本体时 SymbolBBox 取图元包围盒，不含引脚桩", () => {
      const symbol = parseMulti()!;
      const section = symbol.sections[0];
      const body = bodyBoxOf(section);
      const xs = section.shapes.flatMap((shape) =>
        shape.kind === "polyline" ? shape.points.map((point) => point.x) : [],
      );
      expect(body.minX).toBe(Math.min(...xs));
      expect(body.minX).toBeGreaterThan(section.bounds.minX);
      const xml = buildCaptureLibraryXml(symbol, "C:/libs/target.OLB");
      expect(xml).toContain(
        `<Defn x1="${body.minX}" x2="${body.maxX}" y1="${body.minY}" y2="${body.maxY}" />`,
      );
    });

    /**
     * Capture 的引脚字号固定 9 单位。源符号本体只有 20 单位高，D1/S1 两个竖排名字
     * 必然在中间撞上 —— 解析阶段把整段按整数倍放大，直到标签互不重叠。
     */
    it("本体放不下引脚名时整段放大，引脚仍落在 10 单位网格上", () => {
      const symbol = parseMulti()!;
      const section = symbol.sections[0];
      const body = bodyBoxOf(section);
      // 源本体 34×20 → 放大 2 倍后 68×40
      expect(body.maxY - body.minY).toBe(40);
      expect(body.maxX - body.minX).toBe(68);
      for (const pin of section.pins) {
        expect(pin.connection.x % 10).toBe(0);
        expect(pin.connection.y % 10).toBe(0);
      }
    });

    it("写成 Capture 库 XML 时按多段 Package 输出（A/B 段 + 全部 6 脚）", () => {
      const xml = buildCaptureLibraryXml(parseMulti()!, "C:/libs/target.OLB");
      expect(xml).toMatch(/alphabeticNumbering="1" isHomogeneous="0"/);
      expect(xml).toContain('<Defn CellName="AGM609MNAA" />');
      expect(xml).toContain('<Defn CellName="AGM609MNAB" />');
      expect(xml.match(/<SymbolPinScalar>/g)).toHaveLength(6);
    });

    it("主 dataStr 有图形时仍走单段老路径（不会被 subparts 覆盖）", () => {
      const symbol = parseEasyEdaSymbol(fixtures.C2040.dataStr, {
        lcscId: "C2040",
        fallbackName: "RP2040",
        pcbFootprint: "",
        subparts: fixture.subparts,
      });
      expect(symbol!.sections).toHaveLength(1);
      expect(symbol!.sections[0].pins).toHaveLength(57);
    });

    it("响应结构校验不会把 subparts 丢掉（连接器实际走的就是这条路）", () => {
      const parsed = RawEasyEdaResponseSchema.parse({
        success: true,
        code: 0,
        result: {
          dataStr: fixture.dataStr,
          subparts: fixture.subparts,
          packageDetail: { title: "PKG", dataStr: { head: { x: 0, y: 0 }, shape: [] } },
        },
      });
      expect(parsed.result.subparts).toHaveLength(2);
      const symbol = parseEasyEdaSymbol(parsed.result.dataStr, {
        lcscId: "C18221391",
        fallbackName: fixture.title,
        pcbFootprint: "PKG",
        subparts: parsed.result.subparts ?? [],
      });
      expect(symbol!.sections).toHaveLength(2);
    });
  });

  it("falls back to a safe library name when the source name has odd characters", () => {
    const symbol = parseEasyEdaSymbol(
      {
        head: { c_para: { name: "OPA2134 PA/BB (DIP)", pre: "U?" } },
        shape: ["R~0~0~~~100~50~#000000~1~0~none~g1~0~"],
      },
      { lcscId: "C9999", fallbackName: "X", pcbFootprint: "" },
    );
    // 末尾括号说明 `(DIP)` 属于供应商元数据，一并剥掉（见 cleanSymbolName）
    expect(symbol?.name).toBe("OPA2134_PA_BB");
  });

  /**
   * 官方库把符号命名成 `<型号>_<立创编号>` 或 `<型号>(<规格>)`，两种尾巴都是
   * 供应商元数据，进 OrCAD 前要剥掉。
   * 用户 2026-10-27 报 C3011202（`HT7533-1_C3011202` → 期望 `HT7533-1`）；
   * 用户 2026-10-28 报 C49023473（`HT7533-1-TD(24V)` → 期望 `HT7533-1-TD`）。
   */
  it("剥掉符号名里的立创编号与括号说明", () => {
    const build = (name: string, lcscId: string) =>
      parseEasyEdaSymbol(
        {
          head: { c_para: { name, pre: "U?" } },
          shape: ["R~0~0~~~100~50~#000000~1~0~none~g1~0~"],
        },
        { lcscId, fallbackName: "X", pcbFootprint: "" },
      );
    expect(build("HT7533-1_C3011202", "C3011202")?.name).toBe("HT7533-1");
    // 大小写不敏感
    expect(build("HT7533-1_c3011202", "C3011202")?.name).toBe("HT7533-1");
    // 末尾括号说明
    expect(build("HT7533-1-TD(24V)", "C49023473")?.name).toBe("HT7533-1-TD");
    // 全角括号同样处理
    expect(build("HT7533-1-TD（24V）", "C49023473")?.name).toBe("HT7533-1-TD");
    // 两种尾巴同时出现
    expect(build("HT7533-1(SOT23-5)_C3011202", "C3011202")?.name).toBe("HT7533-1");
    // 后缀不是本器件编号 → 原样保留（不猜）
    expect(build("HT7533-1_C9999999", "C3011202")?.name).toBe("HT7533-1_C9999999");
    // 名字短到剥完会空 → 不剥（sanitize 只去掉前导下划线）
    expect(build("_C3011202", "C3011202")?.name).toBe("C3011202");
    // 整名都是括号 → 保留原名，不剥成空串
    expect(build("(24V)", "C49023473")?.name).toBe("24V");
  });

  /**
   * 文本字号：源字段是 pt（形如 "11.5pt"），×1.33 换成符号单位；给不出可用值时
   * 兜底到 DEFAULT_SYMBOL_TEXT_HEIGHT（用户 2026-10-16 要求 7，原先写死 6）。
   */
  describe("文本字号", () => {
    const withText = (sizeField: string): number | undefined => {
      const symbol = parseEasyEdaSymbol(
        {
          head: { c_para: { name: "TXT", pre: "U?" } },
          shape: [`T~L~10~20~0~#000000~Arial~${sizeField}~~1~1~1~HELLO~~0~`],
        },
        { lcscId: "C1", fallbackName: "TXT", pcbFootprint: "" },
      );
      const text = symbol?.sections[0]?.shapes.find((shape) => shape.kind === "text");
      return text?.kind === "text" ? text.height : undefined;
    };

    it("正常字号按 ×1.33 换算", () => {
      expect(withText("11.5pt")).toBeCloseTo(15.295, 3);
    });

    it("字号过小时兜底到默认值 7（不再是 6）", () => {
      expect(withText("1pt")).toBe(DEFAULT_SYMBOL_TEXT_HEIGHT);
      expect(withText("4.5pt")).toBe(DEFAULT_SYMBOL_TEXT_HEIGHT);
      expect(DEFAULT_SYMBOL_TEXT_HEIGHT).toBe(7);
    });

    it("缺字段时仍用 12 这个样例一致的缺省值", () => {
      expect(withText("")).toBe(12);
    });
  });
});
