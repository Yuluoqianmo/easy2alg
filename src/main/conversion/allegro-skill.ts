import { basename, join } from "node:path";
import type {
  ConversionPlan,
  NormalizedCircle,
  NormalizedLine,
  NormalizedPad,
  Point,
} from "../../shared/schemas";
import { derivePadstackName } from "./naming";

export type AllegroSourceFile = {
  readonly relativePath: string;
  readonly content: string;
};

export type AllegroSourceBundle = {
  readonly symbolName: string;
  readonly sources: readonly AllegroSourceFile[];
  readonly expectedOutputs: readonly string[];
};

const number = (value: number): string => {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Allegro source generation received a non-finite number: ${String(value)}`);
  }
  return value.toFixed(5).replace(/\.?0+$/, "");
};

const skillString = (value: string): string =>
  `"${value.replaceAll("\\", "/").replaceAll("\"", "\\\"")}"`;

const point = (value: Point): string => `${number(value.x)}:${number(value.y)}`;

const padFigure = (pad: NormalizedPad): string => {
  if (pad.shape === "circle") {
    return "'CIRCLE";
  }
  if (pad.shape === "oval") {
    return pad.width >= pad.height ? "'OBLONG_X" : "'OBLONG_Y";
  }
  if (pad.shape === "roundedRectangle") {
    return "'ROUNDED_RECTANGLE";
  }
  return "'RECTANGLE";
};

const padSize = (pad: NormalizedPad, scale: number, expansion: number): string => {
  const width = pad.width * scale + expansion * 2;
  const height = pad.height * scale + expansion * 2;
  return `${number(width)}:${number(height)}`;
};

const corners = (pad: NormalizedPad): string =>
  pad.shape === "roundedRectangle"
    ? ` ?corners "UR-UL-LR-LL" ?radius ${number(Math.min(pad.width, pad.height) * 0.2)}`
    : "";

const padDefinition = (
  pad: NormalizedPad,
  padstackDirectory: string,
  solderMaskExpansionMm: number,
  pasteAreaRatio: number,
): string => {
  const name = derivePadstackName(pad);
  const outputPath = join(padstackDirectory, `${name}.pad`);
  const throughHole = pad.holeWidth > 0;
  const figure = padFigure(pad);
  const pasteScale = pad.width * pad.height > 16 ? Math.sqrt(pasteAreaRatio) : 1;
  const drillFigure =
    pad.holeHeight > pad.holeWidth + 0.001
      ? pad.rotation % 180 === 0
        ? "'OBLONG_Y"
        : "'OBLONG_X"
      : "'CIRCLE";
  const drill = throughHole
    ? `make_axlPadStackDrill(
      ?holeType ${pad.holeHeight > pad.holeWidth + 0.001 ? "'SLOT" : "'CIRCLE_DRILL"}
      ?plating ${pad.plated ? "'PLATED" : "'NON_PLATED"}
      ?drillDiameter ${number(pad.holeWidth)}
      ?figure ${drillFigure}
      ?figureSize ${number(pad.holeWidth)}:${number(Math.max(pad.holeHeight, pad.holeWidth))}
      ?drillChar "A"
    )`
    : "nil";
  const layerPads = throughHole
    ? `list(
      make_axlPadStackPad(?layer "TOP" ?type 'REGULAR ?figure ${figure} ?figureSize ${padSize(pad, 1, 0)}${corners(pad)})
      make_axlPadStackPad(?layer "DEFAULT INTERNAL" ?type 'REGULAR ?figure ${figure} ?figureSize ${padSize(pad, 1, 0)}${corners(pad)})
      make_axlPadStackPad(?layer "BOTTOM" ?type 'REGULAR ?figure ${figure} ?figureSize ${padSize(pad, 1, 0)}${corners(pad)})
      make_axlPadStackPad(?layer "SOLDERMASK_TOP" ?type 'REGULAR ?figure ${figure} ?figureSize ${padSize(pad, 1, solderMaskExpansionMm)}${corners(pad)})
      make_axlPadStackPad(?layer "SOLDERMASK_BOTTOM" ?type 'REGULAR ?figure ${figure} ?figureSize ${padSize(pad, 1, solderMaskExpansionMm)}${corners(pad)})
    )`
    : `list(
      make_axlPadStackPad(?layer "TOP" ?type 'REGULAR ?figure ${figure} ?figureSize ${padSize(pad, 1, 0)}${corners(pad)})
      make_axlPadStackPad(?layer "SOLDERMASK_TOP" ?type 'REGULAR ?figure ${figure} ?figureSize ${padSize(pad, 1, solderMaskExpansionMm)}${corners(pad)})
      make_axlPadStackPad(?layer "PASTEMASK_TOP" ?type 'REGULAR ?figure ${figure} ?figureSize ${padSize(pad, pasteScale, 0)}${corners(pad)})
    )`;
  return `
  padObj = axlDBCreatePadStack(
    ${skillString(name)}
    ${drill}
    ${layerPads}
    t
  )
  unless(padObj
    error("Unable to create padstack ${name}\\n")
  )
  unless(axlPadstackToDisk(${skillString(outputPath)})
    error("Unable to write padstack ${name}\\n")
  )`;
};

const layerName = (line: NormalizedLine): string => {
  if (line.layer === "silkscreen") {
    return "PACKAGE GEOMETRY/SILKSCREEN_TOP";
  }
  if (line.layer === "assembly") {
    return "PACKAGE GEOMETRY/ASSEMBLY_TOP";
  }
  if (line.layer === "courtyard") {
    return "PACKAGE GEOMETRY/PLACE_BOUND_TOP";
  }
  return "MANUFACTURING/DOCUMENTATION";
};

const circleLayerName = (circle: NormalizedCircle): string =>
  circle.layer === "silkscreen"
    ? "PACKAGE GEOMETRY/SILKSCREEN_TOP"
    : circle.layer === "assembly"
      ? "PACKAGE GEOMETRY/ASSEMBLY_TOP"
      : "MANUFACTURING/DOCUMENTATION";

const lineCommand = (line: NormalizedLine): string =>
  `  axlDBCreateLine(list(${point(line.start)} ${point(line.end)}) ${number(line.width)} ${skillString(layerName(line))})`;

const circleCommand = (circle: NormalizedCircle): string =>
  `  axlDBCreateCircle(list(${point(circle.center)} ${number(circle.radius)}) ${number(circle.width)} ${skillString(circleLayerName(circle))})`;

const pinCommand = (pad: NormalizedPad): string => {
  const rotation = ((pad.rotation % 360) + 360) % 360;
  return `  e2a_create_pin(${skillString(derivePadstackName(pad))} ${point(pad.center)} ${skillString(pad.number)} ${number(rotation)})`;
};

const nonPlatedHoleCommand = (center: Point, diameter: number, index: number): string => {
  const pad: NormalizedPad = {
    number: `MH${index}`,
    center,
    width: diameter + 0.5,
    height: diameter + 0.5,
    rotation: 0,
    shape: "circle",
    polygon: [],
    plated: false,
    holeWidth: diameter,
    holeHeight: diameter,
    sourceLayerId: 11,
  };
  return pinCommand(pad);
};

const uniquePadstacks = (pads: readonly NormalizedPad[]): readonly NormalizedPad[] => [
  ...new Map(pads.map((pad) => [derivePadstackName(pad), pad])).values(),
];

const buildSkillSource = (
  plan: ConversionPlan,
  padstackDirectory: string,
  verificationPath: string,
  buildStatusPath: string,
): string => {
  const footprint = plan.footprint;
  const mechanicalPads = footprint.holes.map((hole, index) => ({
    number: `MH${index + 1}`,
    center: hole.center,
    width: hole.diameter + 0.5,
    height: hole.diameter + 0.5,
    rotation: 0,
    shape: "circle" as const,
    polygon: [],
    plated: false,
    holeWidth: hole.diameter,
    holeHeight: hole.diameter,
    sourceLayerId: 11,
  }));
  const allPads = [...footprint.pads, ...mechanicalPads];
  const definitions = uniquePadstacks(allPads)
    .map((pad) =>
      padDefinition(
        pad,
        padstackDirectory,
        plan.solderMaskExpansionMm,
        plan.pasteAreaRatio,
      ),
    )
    .join("\n");
  const pins = [
    ...footprint.pads.map(pinCommand),
    ...footprint.holes.map((hole, index) =>
      nonPlatedHoleCommand(hole.center, hole.diameter, index + 1),
    ),
  ].join("\n");
  const lines = footprint.lines.map(lineCommand).join("\n");
  const circles = footprint.circles.map(circleCommand).join("\n");
  return `; Generated by EasyEDA2Allegro. Do not edit manually.
procedure(e2a_create_pin(padName location pinNumber rotation)
  let((textOrientation textBlock pinText pinObject)
    textOrientation = make_axlTextOrientation(
      ?textBlock "1"
      ?rotation 0.0
      ?justify "center"
      ?mirrored nil
    )
    pinText = make_axlPinText(?number pinNumber ?offset 0:0 ?text textOrientation)
    pinObject = axlDBCreatePin(padName location pinText rotation)
    unless(pinObject
      error("Unable to create pin %s with padstack %s\\n" pinNumber padName)
    )
    pinObject
  )
)

procedure(e2a_build()
  let((padObj textOrientation statusPort)
    axlDBChangeDesignUnits("millimeters" 4)
${definitions}
${pins}
${lines}
${circles}
    textOrientation = make_axlTextOrientation(
      ?textBlock "1"
      ?rotation 0.0
      ?justify "center"
      ?mirrored nil
    )
    axlDBCreateText("REF**" 0:0 textOrientation "REF DES/SILKSCREEN_TOP")
    axlDBCreateText("REF**" 0:0 textOrientation "REF DES/ASSEMBLY_TOP")
    axlDBCreateText(${skillString(footprint.info.targetPackageName)} 0:${number(footprint.bounds.minY - 1)} textOrientation "PACKAGE GEOMETRY/ASSEMBLY_TOP")
    axlDBRefresh()
    statusPort = outfile(${skillString(buildStatusPath)})
    unless(statusPort
      error("Unable to open build status report\\n")
    )
    fprintf(statusPort "status=ok\\n")
    fprintf(statusPort "pins=${allPads.length}\\n")
    close(statusPort)
    t
  )
)

procedure(e2a_verify()
  let((port pins pin)
    port = outfile(${skillString(verificationPath)})
    unless(port
      error("Unable to open verification report\\n")
    )
    pins = nil
    axlExtractMap(
      "cpad_bv"
      lambda((dbid cpad)
        case(dbid->objType
          ("pin" push(dbid pins))
        )
      )
    )
    fprintf(port "symbol=${footprint.info.targetPackageName}\\n")
    fprintf(port "pins=%d\\n" length(pins))
    foreach(pin pins
      fprintf(port "pin=%s|%.5f|%.5f\\n" pin->number car(pin->xy) cadr(pin->xy))
    )
    close(port)
    t
  )
)
`;
};

const buildScriptSource = (
  symbolName: string,
  jobDirectory: string,
  skillPath: string,
): string => `setwindow pcb
new
newdrawfillin ${skillString(join(jobDirectory, `${symbolName}.dra`))} "Package Symbol" YES
skill load(${skillString(skillPath)})
skill e2a_build()
save_as ${skillString(join(jobDirectory, `${symbolName}.dra`))}
create symbol
fillin ${skillString(join(jobDirectory, `${symbolName}.psm`))}
exit
fillin no
`;

const verifyScriptSource = (
  skillPath: string,
): string => `setwindow pcb
skill load(${skillString(skillPath)})
skill e2a_verify()
exit
`;

export const createAllegroSourceBundle = (
  plan: ConversionPlan,
  jobDirectory: string,
): AllegroSourceBundle => {
  const symbolName = basename(plan.footprint.info.targetPackageName);
  const skillPath = join(jobDirectory, "build.il");
  const verificationPath = join(jobDirectory, "verification.txt");
  const buildStatusPath = join(jobDirectory, "build-status.txt");
  const padstackDirectory = join(jobDirectory, "padstacks");
  const padstackFiles = uniquePadstacks([
    ...plan.footprint.pads,
    ...plan.footprint.holes.map((hole, index) => ({
      number: `MH${index + 1}`,
      center: hole.center,
      width: hole.diameter + 0.5,
      height: hole.diameter + 0.5,
      rotation: 0,
      shape: "circle" as const,
      polygon: [],
      plated: false,
      holeWidth: hole.diameter,
      holeHeight: hole.diameter,
      sourceLayerId: 11,
    })),
  ]).map((pad) => `padstacks/${derivePadstackName(pad)}.pad`);
  return {
    symbolName,
    sources: [
      {
        relativePath: "build.il",
        content: buildSkillSource(
          plan,
          padstackDirectory,
          verificationPath,
          buildStatusPath,
        ),
      },
      {
        relativePath: "build.scr",
        content: buildScriptSource(symbolName, jobDirectory, skillPath),
      },
      {
        relativePath: "verify.scr",
        content: verifyScriptSource(skillPath),
      },
      {
        relativePath: "conversion-plan.json",
        content: `${JSON.stringify(plan, null, 2)}\n`,
      },
    ],
    expectedOutputs: [`${symbolName}.dra`, `${symbolName}.psm`, ...padstackFiles],
  };
};
