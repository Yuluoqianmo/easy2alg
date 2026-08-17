import { z } from "zod";

export const AllegroVersionSchema = z.enum(["23.1", "22.1", "17.4", "17.2", "16.6"]);
export type AllegroVersion = z.infer<typeof AllegroVersionSchema>;

export const AppSettingsSchema = z.object({
  allegroVersion: AllegroVersionSchema,
  libraryDirectory: z.string().min(1),
  setupCompleted: z.boolean(),
  allegroExecutablePath: z.string().min(1).nullable().optional(),
}).transform((settings) => ({
  ...settings,
  allegroExecutablePath: settings.allegroExecutablePath ?? null,
}));
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const PointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type Point = z.infer<typeof PointSchema>;

export const PadShapeSchema = z.enum([
  "rectangle",
  "roundedRectangle",
  "oval",
  "circle",
  "polygon",
]);
export type PadShape = z.infer<typeof PadShapeSchema>;

export const NormalizedPadSchema = z.object({
  number: z.string().min(1),
  center: PointSchema,
  width: z.number().positive(),
  height: z.number().positive(),
  rotation: z.number().finite(),
  shape: PadShapeSchema,
  polygon: z.array(PointSchema),
  plated: z.boolean(),
  holeWidth: z.number().nonnegative(),
  holeHeight: z.number().nonnegative(),
  sourceLayerId: z.number().int(),
});
export type NormalizedPad = z.infer<typeof NormalizedPadSchema>;

export const NormalizedLineSchema = z.object({
  start: PointSchema,
  end: PointSchema,
  width: z.number().positive(),
  layer: z.enum(["silkscreen", "assembly", "courtyard", "documentation"]),
});
export type NormalizedLine = z.infer<typeof NormalizedLineSchema>;

export const NormalizedCircleSchema = z.object({
  center: PointSchema,
  radius: z.number().positive(),
  width: z.number().positive(),
  layer: z.enum(["silkscreen", "assembly", "documentation"]),
});
export type NormalizedCircle = z.infer<typeof NormalizedCircleSchema>;

export const ThreeDModelSchema = z.object({
  name: z.string().min(1),
  uuid: z.string().min(1),
  translation: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  }),
  rotation: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  }),
});
export type ThreeDModel = z.infer<typeof ThreeDModelSchema>;

export const ComponentInfoSchema = z.object({
  lcscId: z.string().regex(/^C\d+$/),
  name: z.string().min(1),
  manufacturer: z.string(),
  manufacturerPartNumber: z.string(),
  sourcePackageName: z.string().min(1),
  targetPackageName: z.string().min(1),
  assemblyProcess: z.enum(["SMT", "THT"]),
  description: z.string(),
});
export type ComponentInfo = z.infer<typeof ComponentInfoSchema>;

export const NormalizedFootprintSchema = z.object({
  info: ComponentInfoSchema,
  pads: z.array(NormalizedPadSchema).min(1),
  holes: z.array(
    z.object({
      center: PointSchema,
      diameter: z.number().positive(),
    }),
  ),
  lines: z.array(NormalizedLineSchema),
  circles: z.array(NormalizedCircleSchema),
  sourceOrigin: PointSchema,
  bounds: z.object({
    minX: z.number().finite(),
    minY: z.number().finite(),
    maxX: z.number().finite(),
    maxY: z.number().finite(),
  }),
  model3d: ThreeDModelSchema.nullable(),
  sourceJson: z.string(),
});
export type NormalizedFootprint = z.infer<typeof NormalizedFootprintSchema>;

export const CheckSeveritySchema = z.enum(["pass", "warning", "error"]);
export type CheckSeverity = z.infer<typeof CheckSeveritySchema>;

export const ConversionCheckSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().min(1),
  severity: CheckSeveritySchema,
});
export type ConversionCheck = z.infer<typeof ConversionCheckSchema>;

export const ConversionPlanSchema = z.object({
  footprint: NormalizedFootprintSchema,
  checks: z.array(ConversionCheckSchema),
  padstackCount: z.number().int().nonnegative(),
  solderMaskExpansionMm: z.number().nonnegative(),
  pasteAreaRatio: z.number().positive().max(1),
});
export type ConversionPlan = z.infer<typeof ConversionPlanSchema>;

export const GeneratedFileSchema = z.object({
  relativePath: z.string().min(1),
  status: z.enum(["generated", "verified", "planned"]),
  bytes: z.number().int().nonnegative(),
});
export type GeneratedFile = z.infer<typeof GeneratedFileSchema>;

export const GenerationStageSchema = z.enum([
  "preparing",
  "launching",
  "generating",
  "verifying",
  "copying",
  "completed",
  "failed",
]);
export type GenerationStage = z.infer<typeof GenerationStageSchema>;

export const GenerationProgressSchema = z.object({
  lcscId: z.string().regex(/^C\d+$/),
  stage: GenerationStageSchema,
  percent: z.number().int().min(0).max(100),
  message: z.string().min(1),
  diagnosticDirectory: z.string().min(1).nullable(),
  timestamp: z.string().datetime(),
});
export type GenerationProgress = z.infer<typeof GenerationProgressSchema>;

export const ConversionResultSchema = z.object({
  lcscId: z.string().regex(/^C\d+$/),
  targetPackageName: z.string().min(1),
  libraryDirectory: z.string().min(1),
  outcome: z.enum(["success", "scripts-only", "failed"]),
  files: z.array(GeneratedFileSchema),
  checks: z.array(ConversionCheckSchema),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  message: z.string().min(1),
});
export type ConversionResult = z.infer<typeof ConversionResultSchema>;

export const HistoryEntrySchema = ConversionResultSchema.extend({
  id: z.string().min(1),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const QueueItemSchema = z.object({
  id: z.string().regex(/^C\d+$/),
  state: z.enum([
    "ready",
    "loading",
    "warning",
    "error",
    "generationFailed",
    "generated",
  ]),
  footprint: NormalizedFootprintSchema.nullable(),
  message: z.string(),
  selected: z.boolean(),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const AllegroInstallSchema = z.object({
  version: AllegroVersionSchema,
  executablePath: z.string().min(1),
  detected: z.boolean(),
});
export type AllegroInstall = z.infer<typeof AllegroInstallSchema>;

export const AppApiSchema = z.object({
  platform: z.string().min(1),
  appVersion: z.string().min(1),
});
export type AppApiInfo = z.infer<typeof AppApiSchema>;
