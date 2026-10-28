import { describe, expect, it } from "vitest";
import {
  AppSettingsSchema,
  LEFT_RAIL_DEFAULT_WIDTH,
  RIGHT_RAIL_DEFAULT_WIDTH,
  defaultUiSettings,
} from "../src/shared/schemas";

/**
 * 界面偏好（侧栏宽度 / 分组折叠 / 图层配色 / 记住的本地库路径）的持久化契约。
 *
 * 用户 2026-10-16 要求：右侧分组"支持展开与隐藏，需要持久化；导入本地库路径也需要持久化"。
 * 这些都落在 settings.json 的 `ui` 字段里，老配置文件没有这一节 → 必须用默认值补齐，
 * 而不是让读取直接失败。
 */
const minimal = {
  allegroVersion: "17.4",
  libraryDirectory: "E:\\high_clouds\\cadence\\cadencelib",
  setupCompleted: true,
};

describe("ui settings persistence", () => {
  it("fills the ui section with defaults for older config files", () => {
    const settings = AppSettingsSchema.parse(minimal);
    expect(settings.ui).toEqual(defaultUiSettings());
    expect(settings.ui.leftRailWidth).toBe(LEFT_RAIL_DEFAULT_WIDTH);
    expect(settings.ui.rightRailWidth).toBe(RIGHT_RAIL_DEFAULT_WIDTH);
    expect(settings.ui.collapsedSections).toEqual([]);
    expect(settings.ui.layerColors).toEqual({});
    expect(settings.ui.localLibraryDir).toBeNull();
  });

  /**
   * 用户 2026-10-20：网格吸附开关 + 100/50 mil 两档 + 背景网格显示，都要记住。
   * 三个字段必须在 transform 里显式补默认值，否则读一次设置就消失。
   */
  it("defaults the symbol grid settings for older config files", () => {
    const settings = AppSettingsSchema.parse(minimal);
    expect(settings.ui.symbolSnapEnabled).toBe(true);
    expect(settings.ui.symbolSnapGrid).toBe(10);
    expect(settings.ui.symbolGridVisible).toBe(true);
  });

  it("round-trips the symbol grid settings", () => {
    const settings = AppSettingsSchema.parse({
      ...minimal,
      ui: { symbolSnapEnabled: false, symbolSnapGrid: 5, symbolGridVisible: false },
    });
    expect(settings.ui.symbolSnapEnabled).toBe(false);
    expect(settings.ui.symbolSnapGrid).toBe(5);
    expect(settings.ui.symbolGridVisible).toBe(false);
    const again = AppSettingsSchema.parse(JSON.parse(JSON.stringify(settings)));
    expect(again.ui.symbolSnapGrid).toBe(5);
  });

  it("rejects grid values outside the two supported tiers", () => {
    expect(() =>
      AppSettingsSchema.parse({ ...minimal, ui: { symbolSnapGrid: 7 } }),
    ).toThrow();
  });

  it("keeps a partial ui section while filling the rest", () => {
    const settings = AppSettingsSchema.parse({
      ...minimal,
      ui: { leftRailWidth: 420, collapsedSections: ["checks"] },
    });
    expect(settings.ui.leftRailWidth).toBe(420);
    expect(settings.ui.collapsedSections).toEqual(["checks"]);
    expect(settings.ui.rightRailWidth).toBe(RIGHT_RAIL_DEFAULT_WIDTH);
  });

  it("round-trips layer colors and the remembered local library directory", () => {
    const ui = {
      ...defaultUiSettings(),
      layerColors: { pads: "#ff8800", silkscreen: "#00aa55" },
      localLibraryDir: "E:\\libs",
    };
    const settings = AppSettingsSchema.parse({ ...minimal, ui });
    const again = AppSettingsSchema.parse(JSON.parse(JSON.stringify(settings)));
    expect(again.ui.layerColors).toEqual({ pads: "#ff8800", silkscreen: "#00aa55" });
    expect(again.ui.localLibraryDir).toBe("E:\\libs");
  });

  it("migrates the legacy file path into its directory", () => {
    // 0.1.20 及以前记的是文件本身；读老配置时要退化成它所在的目录
    const migrated = AppSettingsSchema.parse({
      ...minimal,
      ui: { localLibraryPath: "E:\\libs\\pex8748.elibz2" },
    });
    expect(migrated.ui.localLibraryDir).toBe("E:\\libs");
    // 新字段优先
    const preferred = AppSettingsSchema.parse({
      ...minimal,
      ui: { localLibraryPath: "E:\\old\\x.elibz2", localLibraryDir: "D:\\new" },
    });
    expect(preferred.ui.localLibraryDir).toBe("D:\\new");
    // 光秃秃的文件名（没有目录部分）→ null，不给选择框塞非法路径
    const bare = AppSettingsSchema.parse({ ...minimal, ui: { localLibraryPath: "x.elibz2" } });
    expect(bare.ui.localLibraryDir).toBeNull();
  });

  it("defaultUiSettings returns a fresh object each call", () => {
    // 共享可变引用会让"改一个器件的图层颜色"污染所有默认值
    const first = defaultUiSettings();
    const second = defaultUiSettings();
    first.collapsedSections.push("checks");
    first.layerColors.pads = "#000000";
    expect(second.collapsedSections).toEqual([]);
    expect(second.layerColors).toEqual({});
  });

  it("clamps rail widths to the allowed range", () => {
    expect(AppSettingsSchema.safeParse({ ...minimal, ui: { leftRailWidth: 10 } }).success).toBe(false);
    expect(AppSettingsSchema.safeParse({ ...minimal, ui: { leftRailWidth: 9999 } }).success).toBe(false);
    expect(AppSettingsSchema.safeParse({ ...minimal, ui: { leftRailWidth: 300 } }).success).toBe(true);
  });
});

describe("symbol property panel position", () => {
  it("defaults to null and round-trips a dragged position", () => {
    expect(AppSettingsSchema.parse(minimal).ui.symbolPropsPosition).toBeNull();
    const settings = AppSettingsSchema.parse({
      ...minimal,
      ui: { symbolPropsPosition: { x: 120, y: 40 } },
    });
    expect(settings.ui.symbolPropsPosition).toEqual({ x: 120, y: 40 });
    const again = AppSettingsSchema.parse(JSON.parse(JSON.stringify(settings)));
    expect(again.ui.symbolPropsPosition).toEqual({ x: 120, y: 40 });
  });
});

/**
 * 用户 2026-10-27：Allegro 25.1 装好了却存不进设置（旧 schema 是写死的 enum，
 * 只认到 23.1）。版本号改成"形如 25.1"即可，新版本不用改代码。
 */
describe("allegro version", () => {
  it("accepts versions newer than the built-in list", () => {
    expect(AppSettingsSchema.parse({ ...minimal, allegroVersion: "25.1" }).allegroVersion).toBe(
      "25.1",
    );
    expect(AppSettingsSchema.parse({ ...minimal, allegroVersion: "26.1" }).allegroVersion).toBe(
      "26.1",
    );
  });

  it("rejects a value that is not a version number", () => {
    expect(AppSettingsSchema.safeParse({ ...minimal, allegroVersion: "latest" }).success).toBe(
      false,
    );
    expect(AppSettingsSchema.safeParse({ ...minimal, allegroVersion: "25" }).success).toBe(false);
  });
});
