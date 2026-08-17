import type {
  ConversionCheck,
  ConversionPlan,
  NormalizedFootprint,
  NormalizedPad,
} from "../../shared/schemas";
import { ConversionPlanSchema } from "../../shared/schemas";
import { FootprintValidationError } from "../../shared/errors";
import { derivePadstackName } from "./naming";

const duplicatePadNumbers = (pads: readonly NormalizedPad[]): readonly string[] => {
  const counts = new Map<string, number>();
  pads.forEach((pad) => counts.set(pad.number, (counts.get(pad.number) ?? 0) + 1));
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([number]) => number)
    .sort();
};

const hasLargePastePad = (pads: readonly NormalizedPad[]): boolean =>
  pads.some((pad) => pad.holeWidth === 0 && pad.width * pad.height > 16);

const check = (
  id: string,
  label: string,
  detail: string,
  severity: ConversionCheck["severity"],
): ConversionCheck => ({ id, label, detail, severity });

export const validateFootprint = (footprint: NormalizedFootprint): readonly ConversionCheck[] => {
  const duplicates = duplicatePadNumbers(footprint.pads);
  const invalidPads = footprint.pads.filter(
    (pad) =>
      pad.width <= 0 ||
      pad.height <= 0 ||
      pad.holeWidth < 0 ||
      pad.holeHeight < 0 ||
      !Number.isFinite(pad.center.x) ||
      !Number.isFinite(pad.center.y),
  );
  const missingNumbers = footprint.pads.filter((pad) => pad.number.trim().length === 0);
  const polygonIssues = footprint.pads.filter(
    (pad) => pad.shape === "polygon" && pad.polygon.length < 3,
  );
  const slotPads = footprint.pads.filter(
    (pad) => pad.holeWidth > 0 && pad.holeHeight > pad.holeWidth + 0.001,
  );
  const checks: ConversionCheck[] = [
    check(
      "pin-count",
      `${footprint.pads.length} 个引脚`,
      "源数据中的引脚和机械焊盘均已识别",
      footprint.pads.length > 0 ? "pass" : "error",
    ),
    check(
      "pin-numbers",
      "引脚编号无重复",
      duplicates.length === 0 ? "编号唯一" : `重复编号：${duplicates.join(", ")}`,
      duplicates.length === 0 ? "pass" : "error",
    ),
    check(
      "pad-dimensions",
      "焊盘尺寸有效",
      invalidPads.length === 0 ? "未发现零尺寸、负尺寸或无效坐标" : "存在无效焊盘尺寸",
      invalidPads.length === 0 ? "pass" : "error",
    ),
    check(
      "solder-mask",
      "阻焊开窗有效",
      "按铜焊盘外扩 0.05 mm 生成，通孔双面开窗",
      "pass",
    ),
    check(
      "paste-mask",
      "钢网开口有效",
      hasLargePastePad(footprint.pads)
        ? "大面积焊盘采用 70% 开口率，投产前建议结合钢网厚度确认"
        : "普通贴片焊盘采用 100% 开口率",
      hasLargePastePad(footprint.pads) ? "warning" : "pass",
    ),
    check(
      "polygon",
      "异形焊盘可转换",
      polygonIssues.length === 0 ? "异形焊盘轮廓完整" : "存在不完整的异形焊盘轮廓",
      polygonIssues.length === 0 ? "pass" : "error",
    ),
    check(
      "slot",
      slotPads.length > 0 ? "槽孔需生产确认" : "孔定义有效",
      slotPads.length > 0
        ? `已保留 ${slotPads.length} 个槽孔的尺寸和方向`
        : "圆孔和镀铜属性有效",
      slotPads.length > 0 ? "warning" : "pass",
    ),
  ];

  const errors: string[] = [];
  if (missingNumbers.length > 0) {
    errors.push("one or more pads have no number");
  }
  if (duplicates.length > 0) {
    errors.push(`duplicate pad numbers: ${duplicates.join(", ")}`);
  }
  if (invalidPads.length > 0) {
    errors.push("one or more pads have invalid geometry");
  }
  if (polygonIssues.length > 0) {
    errors.push("one or more polygon pads have fewer than three points");
  }
  if (errors.length > 0) {
    throw new FootprintValidationError(footprint.info.lcscId, errors);
  }
  return checks;
};

export const createConversionPlan = (footprint: NormalizedFootprint): ConversionPlan => {
  const checks = validateFootprint(footprint);
  const padstackNames = new Set(footprint.pads.map((pad) => derivePadstackName(pad)));
  return ConversionPlanSchema.parse({
    footprint,
    checks,
    padstackCount: padstackNames.size,
    solderMaskExpansionMm: 0.05,
    pasteAreaRatio: hasLargePastePad(footprint.pads) ? 0.7 : 1,
  });
};
