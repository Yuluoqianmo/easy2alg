import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allegroVersionFromText } from "../src/main/connectors/allegro-detector";
import {
  AllegroRunner,
  verifyPinReport,
} from "../src/main/connectors/allegro-runner";
import { createAllegroSourceBundle } from "../src/main/conversion/allegro-skill";
import { derivePadstackName, deriveTargetPackageName } from "../src/main/conversion/naming";
import { createConversionPlan } from "../src/main/conversion/validate";
import { getDemoFootprint } from "../src/shared/demo-fixtures";
import { AppSettingsSchema, type GenerationProgress } from "../src/shared/schemas";
import { lastWindowCloseAction } from "../src/main/lifecycle";

const requiredFixture = (lcscId: string) => {
  const footprint = getDemoFootprint(lcscId);
  if (footprint === null) {
    throw new Error(`Missing required test fixture ${lcscId}`);
  }
  return footprint;
};

describe("industry naming", () => {
  it("derives stable names for common SOIC and QFN packages", () => {
    const soic = requiredFixture("C7593");
    const qfn = requiredFixture("C163691");
    expect(deriveTargetPackageName(soic.info.sourcePackageName, soic.pads)).toBe(
      "SOIC127P600X175-8N",
    );
    expect(deriveTargetPackageName(qfn.info.sourcePackageName, qfn.pads)).toBe(
      "QFN50P500X500X100-33N",
    );
  });

  it("includes drill dimensions in through-hole padstack names", () => {
    const pad = {
      ...requiredFixture("C2040").pads[0]!,
      holeWidth: 0.8,
      holeHeight: 1.4,
    };
    expect(derivePadstackName(pad)).toContain("_H80X140");
  });
});

describe("Allegro source generation", () => {
  it("emits symbol, padstack, solder mask, paste mask, and verification commands", () => {
    const plan = createConversionPlan(requiredFixture("C163691"));
    const bundle = createAllegroSourceBundle(plan, "C:\\Temp\\e2a-job");
    const skill = bundle.sources.find((source) => source.relativePath === "build.il");
    expect(skill).toBeDefined();
    expect(skill!.content).toContain("axlDBCreatePadStack");
    expect(skill!.content).toContain("SOLDERMASK_TOP");
    expect(skill!.content).toContain("PASTEMASK_TOP");
    expect(skill!.content).toContain("e2a_verify");
    expect(skill!.content).toContain("?layer \"TOP\" ?type 'REGULAR");
    expect(skill!.content).toContain("axlPadstackToDisk");
    expect(skill!.content).toContain(
      'axlPadstackToDisk("C:/Temp/e2a-job/padstacks/',
    );
    expect(skill!.content).not.toMatch(/axlPadstackToDisk\("[^"]+" "[^"]+"\)/);
    expect(skill!.content).toContain(
      "axlDBCreatePin(padName location pinText rotation)",
    );
    expect(skill!.content).toContain("?mirrored nil");
    expect(skill!.content).not.toContain("?mirror nil");
    expect(skill!.content).toContain('"REF DES/SILKSCREEN_TOP"');
    expect(skill!.content).toContain('"REF DES/ASSEMBLY_TOP"');
    expect(skill!.content).toContain('fprintf(statusPort "status=ok\\n")');
    expect(skill!.content).toContain("axlDBChangeDesignUnits(\"millimeters\" 4)");
    expect(skill!.content).toContain("axlExtractMap(");
    expect(skill!.content).not.toContain("axlDBGetDesign()->pins");
    expect(bundle.expectedOutputs).toContain(`${plan.footprint.info.targetPackageName}.psm`);
  });

  it("creates and verifies all 57 pads in the C2040-sized case", () => {
    const base = requiredFixture("C163691");
    const sourcePad = base.pads[0]!;
    const pads = Array.from({ length: 57 }, (_, index) => ({
      ...sourcePad,
      number: String(index + 1),
      center: {
        x: (index % 10) * 0.5,
        y: Math.floor(index / 10) * 0.5,
      },
    }));
    const plan = createConversionPlan({
      ...base,
      info: {
        ...base.info,
        lcscId: "C2040",
        name: "RP2040",
        manufacturerPartNumber: "RP2040",
        sourcePackageName: "LQFN-56_L7.0-W7.0-P0.4-EP",
        targetPackageName: "QFN40P700X700X100-57N",
      },
      pads,
    });
    const bundle = createAllegroSourceBundle(plan, "C:\\Temp\\e2a-c2040");
    const skill = bundle.sources.find((source) => source.relativePath === "build.il");
    expect(skill).toBeDefined();
    expect(skill!.content.match(/^  e2a_create_pin\(/gm)).toHaveLength(57);
    expect(skill!.content).toContain('fprintf(port "pins=%d\\n" length(pins))');
  });

  it("fails instead of reporting completion when Allegro is unavailable", async () => {
    const libraryDirectory = await mkdtemp(join(tmpdir(), "e2a-library-"));
    const plan = createConversionPlan(requiredFixture("C2040"));
    const runner = new AllegroRunner();
    const progress: GenerationProgress[] = [];
    await expect(
      runner.generate(
        plan,
        {
          allegroVersion: "17.2",
          libraryDirectory,
          setupCompleted: true,
          allegroExecutablePath: null,
        },
        null,
        (item) => progress.push(item),
      ),
    ).rejects.toThrow("Cadence Allegro 17.2 was not found");
    expect(progress.some((item) => item.stage === "completed")).toBe(false);
  });
});

describe("Allegro installation detection", () => {
  it("recognizes common 16.6 and 17.2 install paths and product versions", () => {
    expect(
      allegroVersionFromText("C:\\Cadence\\SPB_16.6\\tools\\pcb\\bin\\allegro.exe"),
    ).toBe("16.6");
    expect(
      allegroVersionFromText("C:\\Cadence\\SPB_17.2\\tools\\bin\\allegro.exe"),
    ).toBe("17.2");
    expect(allegroVersionFromText("17.20.060")).toBe("17.2");
    expect(allegroVersionFromText("16.60.069")).toBe("16.6");
    expect(allegroVersionFromText("15.7")).toBeNull();
  });

  it("loads existing settings that predate executable-path detection", () => {
    expect(
      AppSettingsSchema.parse({
        allegroVersion: "17.2",
        libraryDirectory: "D:\\AllegroLibrary",
        setupCompleted: true,
      }),
    ).toEqual(
      expect.objectContaining({
        allegroVersion: "17.2",
        allegroExecutablePath: null,
      }),
    );
  });
});

describe("Allegro verification report", () => {
  it("accepts the Windows CRLF line ending used by Allegro", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "e2a-report-"));
    const reportPath = join(reportDirectory, "verification.txt");
    await writeFile(reportPath, "symbol=SOIC127P600X175-8N\r\npins=8\r\n", "utf8");
    await expect(verifyPinReport(reportPath, 8)).resolves.toBeUndefined();
  });

  it("reports both expected and actual pin counts on a real mismatch", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "e2a-report-"));
    const reportPath = join(reportDirectory, "verification.txt");
    await writeFile(reportPath, "symbol=SOIC127P600X175-8N\r\npins=7\r\n", "utf8");
    await expect(verifyPinReport(reportPath, 8)).rejects.toThrow(
      "expected 8 pins but reported 7",
    );
  });
});

describe("application shutdown", () => {
  it("exits immediately on Windows after the last window closes", () => {
    expect(lastWindowCloseAction("win32")).toBe("exit");
    expect(lastWindowCloseAction("linux")).toBe("quit");
    expect(lastWindowCloseAction("darwin")).toBe("stay");
  });
});
