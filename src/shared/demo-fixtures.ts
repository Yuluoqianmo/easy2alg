import type {
  NormalizedFootprint,
  NormalizedLine,
  NormalizedPad,
  PadShape,
} from "./schemas";

const pad = (
  number: string,
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
  shape: PadShape,
  holeDiameter: number,
  plated: boolean,
): NormalizedPad => ({
  number,
  center: { x, y },
  width,
  height,
  rotation,
  shape,
  polygon: [],
  plated,
  holeWidth: holeDiameter,
  holeHeight: holeDiameter,
  sourceLayerId: holeDiameter > 0 ? 11 : 1,
});

const rectangleLines = (
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  width: number,
  layer: NormalizedLine["layer"],
): readonly NormalizedLine[] => {
  const points = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  return points.map((start, index) => ({
    start,
    end: points[(index + 1) % points.length],
    width,
    layer,
  }));
};

const createSoic = (): NormalizedFootprint => {
  const leftPads = [1, 2, 3, 4].map((number, index) =>
    pad(String(number), -2.7, 1.905 - index * 1.27, 1.55, 0.62, 0, "roundedRectangle", 0, true),
  );
  const rightPads = [8, 7, 6, 5].map((number, index) =>
    pad(String(number), 2.7, 1.905 - index * 1.27, 1.55, 0.62, 0, "roundedRectangle", 0, true),
  );
  return {
    info: {
      lcscId: "C7593",
      name: "NE555DR",
      manufacturer: "Texas Instruments",
      manufacturerPartNumber: "NE555DR",
      sourcePackageName: "SOIC-8_3.9x4.9mm_P1.27mm",
      targetPackageName: "SOIC127P600X175-8N",
      assemblyProcess: "SMT",
      description: "Precision timer, SOIC-8",
    },
    pads: [...leftPads, ...rightPads],
    holes: [],
    lines: [
      ...rectangleLines(-1.95, -2.45, 1.95, 2.45, 0.15, "silkscreen"),
      ...rectangleLines(-1.95, -2.45, 1.95, 2.45, 0.1, "assembly"),
      ...rectangleLines(-3.75, -2.8, 3.75, 2.8, 0.05, "courtyard"),
    ],
    circles: [
      {
        center: { x: -1.2, y: 1.7 },
        radius: 0.28,
        width: 0.15,
        layer: "silkscreen",
      },
    ],
    sourceOrigin: { x: 4000, y: 3000 },
    bounds: { minX: -3.475, minY: -2.8, maxX: 3.475, maxY: 2.8 },
    model3d: {
      name: "SOIC-8",
      uuid: "demo-soic-8",
      translation: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    },
    sourceJson: "{\"fixture\":\"C7593\"}",
  };
};

const createRp2040 = (): NormalizedFootprint => {
  const left = Array.from({ length: 14 }, (_, index) =>
    pad(String(index + 1), -3.5, -2.6 + index * 0.4, 0.75, 0.2, 0, "rectangle", 0, true),
  );
  const top = Array.from({ length: 14 }, (_, index) =>
    pad(String(index + 15), -2.6 + index * 0.4, 3.5, 0.2, 0.75, 90, "rectangle", 0, true),
  );
  const right = Array.from({ length: 14 }, (_, index) =>
    pad(String(index + 29), 3.5, 2.6 - index * 0.4, 0.75, 0.2, 0, "rectangle", 0, true),
  );
  const bottom = Array.from({ length: 14 }, (_, index) =>
    pad(String(index + 43), 2.6 - index * 0.4, -3.5, 0.2, 0.75, 90, "rectangle", 0, true),
  );
  return {
    info: {
      lcscId: "C2040",
      name: "RP2040",
      manufacturer: "Raspberry Pi",
      manufacturerPartNumber: "RP2040",
      sourcePackageName: "LQFN-56_L7.0-W7.0-P0.4-EP",
      targetPackageName: "QFN40P700X700X100-57N",
      assemblyProcess: "SMT",
      description: "RP2040 microcontroller, LQFN-56 with exposed pad",
    },
    pads: [
      ...left,
      ...top,
      ...right,
      ...bottom,
      pad("57", 0, 0, 3.2, 3.2, 0, "roundedRectangle", 0, true),
    ],
    holes: [],
    lines: [
      ...rectangleLines(-3.55, -3.55, 3.55, 3.55, 0.15, "silkscreen"),
      ...rectangleLines(-3.5, -3.5, 3.5, 3.5, 0.1, "assembly"),
      ...rectangleLines(-4.1, -4.1, 4.1, 4.1, 0.05, "courtyard"),
    ],
    circles: [
      {
        center: { x: -3.05, y: -3.05 },
        radius: 0.22,
        width: 0.15,
        layer: "silkscreen",
      },
    ],
    sourceOrigin: { x: 4000, y: 3000 },
    bounds: { minX: -4.1, minY: -4.1, maxX: 4.1, maxY: 4.1 },
    model3d: null,
    sourceJson: "{\"fixture\":\"C2040\"}",
  };
};

const createUsbC = (): NormalizedFootprint => {
  const signalPads = Array.from({ length: 16 }, (_, index) =>
    pad(
      String(index + 1),
      -3.75 + index * 0.5,
      -2.9,
      0.3,
      1.15,
      0,
      "roundedRectangle",
      0,
      true,
    ),
  );
  const shieldPads = [
    pad("S1", -4.55, 1.75, 1.25, 1.55, 0, "roundedRectangle", 0, true),
    pad("S2", 4.55, 1.75, 1.25, 1.55, 0, "roundedRectangle", 0, true),
    pad("S3", -4.55, -1.3, 1.25, 1.55, 0, "roundedRectangle", 0, true),
    pad("S4", 4.55, -1.3, 1.25, 1.55, 0, "roundedRectangle", 0, true),
  ];
  return {
    info: {
      lcscId: "C20197",
      name: "USB Type-C 16P",
      manufacturer: "Korean Hroparts Elec",
      manufacturerPartNumber: "TYPE-C-31-M-12",
      sourcePackageName: "USB-C-SMD_16P",
      targetPackageName: "USB-C-SMD_16P",
      assemblyProcess: "SMT",
      description: "USB Type-C receptacle with four shell tabs",
    },
    pads: [...signalPads, ...shieldPads],
    holes: [
      { center: { x: -3.3, y: -0.75 }, diameter: 0.65 },
      { center: { x: 3.3, y: -0.75 }, diameter: 0.65 },
    ],
    lines: [
      ...rectangleLines(-4.15, -2.15, 4.15, 2.45, 0.15, "silkscreen"),
      ...rectangleLines(-4.2, -2.2, 4.2, 2.5, 0.1, "assembly"),
      ...rectangleLines(-5.4, -3.65, 5.4, 2.8, 0.05, "courtyard"),
    ],
    circles: [],
    sourceOrigin: { x: 4000, y: 3000 },
    bounds: { minX: -5.175, minY: -3.65, maxX: 5.175, maxY: 2.8 },
    model3d: {
      name: "USB_C_Receptacle",
      uuid: "demo-usb-c",
      translation: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    },
    sourceJson: "{\"fixture\":\"C20197\"}",
  };
};

const createQfn = (): NormalizedFootprint => {
  const top = Array.from({ length: 8 }, (_, index) =>
    pad(String(index + 1), -1.75 + index * 0.5, 2.35, 0.28, 0.8, 90, "rectangle", 0, true),
  );
  const right = Array.from({ length: 8 }, (_, index) =>
    pad(String(index + 9), 2.35, 1.75 - index * 0.5, 0.28, 0.8, 0, "rectangle", 0, true),
  );
  const bottom = Array.from({ length: 8 }, (_, index) =>
    pad(String(index + 17), 1.75 - index * 0.5, -2.35, 0.28, 0.8, 90, "rectangle", 0, true),
  );
  const left = Array.from({ length: 8 }, (_, index) =>
    pad(String(index + 25), -2.35, -1.75 + index * 0.5, 0.28, 0.8, 0, "rectangle", 0, true),
  );
  const exposedPad = pad("33", 0, 0, 3.35, 3.35, 0, "roundedRectangle", 0, true);
  return {
    info: {
      lcscId: "C163691",
      name: "QFN-32 5x5",
      manufacturer: "Demo manufacturer",
      manufacturerPartNumber: "QFN32-5X5",
      sourcePackageName: "QFN-32_5x5mm_P0.5mm",
      targetPackageName: "QFN50P500X500X100-33N",
      assemblyProcess: "SMT",
      description: "QFN-32 with exposed thermal pad",
    },
    pads: [...top, ...right, ...bottom, ...left, exposedPad],
    holes: [],
    lines: [
      ...rectangleLines(-2.5, -2.5, 2.5, 2.5, 0.15, "silkscreen"),
      ...rectangleLines(-2.5, -2.5, 2.5, 2.5, 0.1, "assembly"),
      ...rectangleLines(-2.9, -2.9, 2.9, 2.9, 0.05, "courtyard"),
    ],
    circles: [
      {
        center: { x: -2.05, y: 2.05 },
        radius: 0.25,
        width: 0.15,
        layer: "silkscreen",
      },
    ],
    sourceOrigin: { x: 4000, y: 3000 },
    bounds: { minX: -2.9, minY: -2.9, maxX: 2.9, maxY: 2.9 },
    model3d: {
      name: "QFN-32_5x5",
      uuid: "demo-qfn-32",
      translation: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    },
    sourceJson: "{\"fixture\":\"C163691\"}",
  };
};

const DemoFootprints = new Map<string, NormalizedFootprint>([
  ["C2040", createRp2040()],
  ["C7593", createSoic()],
  ["C20197", createUsbC()],
  ["C163691", createQfn()],
]);

export const getDemoFootprint = (lcscId: string): NormalizedFootprint | null => {
  const footprint = DemoFootprints.get(lcscId.toUpperCase());
  return footprint === undefined ? null : structuredClone(footprint);
};

export const listDemoFootprints = (): readonly NormalizedFootprint[] =>
  [...DemoFootprints.values()].map((footprint) => structuredClone(footprint));
