// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FootprintPreview } from "../src/renderer/src/App";
import { getDemoFootprint } from "../src/shared/demo-fixtures";
import { defaultVisibleLayers, footprintLayers } from "../src/shared/preview-layers";
import type { NormalizedFootprint, Point } from "../src/shared/schemas";

/**
 * PCB 预览必须画出异形焊盘的真实轮廓。
 *
 * 用户 2026-10-28 反馈："还是没有创建异形焊盘，应该像这种"——配图里 2 脚仍是矩形。
 * 根因有两层：
 *  1. 生成侧 SKILL 源码括号不配平，Allegro 根本没跑完（已由 skill-syntax.test.ts 锁住）；
 *  2. 预览侧**一律用 `<rect>` 画焊盘**，从来不读 `pad.polygon` —— 就算生成是对的，
 *     界面也永远显示矩形。
 * 这里钉住第 2 条：多边形焊盘渲染成 `<polygon>`，且不套 translate/rotate。
 */

afterEach(cleanup);

const polygon: Point[] = [
  { x: -2.3, y: -1.9 },
  { x: 0, y: -1.9 },
  { x: 0, y: 0.9 },
  { x: -2.3, y: 0.9 },
];

const footprintWithPolygon = (): NormalizedFootprint => {
  const base = getDemoFootprint("C2040")!;
  return {
    ...base,
    pads: base.pads.map((pad, index) =>
      index === 0
        ? {
            ...pad,
            shape: "polygon",
            polygon,
            center: { x: -1.35, y: 0 },
            width: 2.3,
            height: 2.8,
            rotation: 0,
          }
        : pad,
    ),
  };
};

const renderPreview = (footprint: NormalizedFootprint) =>
  render(
    <svg>
      <FootprintPreview
        footprint={footprint}
        visible={defaultVisibleLayers(footprintLayers(footprint))}
        maskExpansionMm={0.05}
        layerColors={{}}
      />
    </svg>,
  );

describe("PCB 预览的异形焊盘", () => {
  it("多边形焊盘渲染成 <polygon>，点数与源数据一致", () => {
    const { container } = renderPreview(footprintWithPolygon());
    const polygons = container.querySelectorAll("polygon");
    expect(polygons.length).toBeGreaterThan(0);
    const copper = [...polygons].find((node) => node.getAttribute("fill") !== "none");
    expect(copper).toBeDefined();
    const points = copper!.getAttribute("points")!.split(" ").filter(Boolean);
    // 阻焊外扩不改变点数，铜层就是源多边形的 4 个点
    expect(points.length).toBe(polygon.length);
    expect(points[0]).toBe("-2.3,-1.9");
  });

  it("多边形焊盘不再套 translate/rotate（坐标已是封装全局坐标）", () => {
    const { container } = renderPreview(footprintWithPolygon());
    const copper = [...container.querySelectorAll("polygon")].find(
      (node) => node.getAttribute("fill") !== "none",
    )!;
    expect(copper.getAttribute("transform")).toBeNull();
    expect(copper.parentElement?.getAttribute("transform")).toBe("scale(1 -1)");
  });

  it("普通矩形焊盘仍然画 <rect>", () => {
    const { container } = renderPreview(getDemoFootprint("C2040")!);
    expect(container.querySelectorAll("polygon").length).toBe(0);
    expect(container.querySelectorAll("rect").length).toBeGreaterThan(0);
  });
});
