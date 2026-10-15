/**
 * Shapes of the generated floor plan data in `src/data/floorplan/`.
 *
 * Kept apart from `floorplan.ts` so the build script can import the schemas
 * without dragging the JSON itself into the build's module graph — the build
 * is what writes that JSON, and on a first run it does not exist yet.
 */
import { z } from "zod";

const point = z.tuple([z.number(), z.number()]);

export const planBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const floorplanMetaSchema = z.object({
  generatorVersion: z.number().int(),
  source: z.string(),
  sourceSha256: z.string().length(64),
  planBounds: planBoundsSchema,
  viewBox: z.string(),
  coreCentre: point,
  /** Null when no standard plot scale fitted well enough to publish one. */
  mmPerUnit: z.number().positive().nullable(),
  scaleNote: z.string(),
  texture: z.object({ "2048": z.string(), "4096": z.string() }),
  counts: z.object({
    seats: z.number().int(),
    wallPolygons: z.number().int(),
    chairBlocksDetected: z.number().int(),
    chairBlocksUnassigned: z.number().int(),
    furnitureBoxes: z.number().int().optional(),
    interiorCoverage: z.number(),
  }),
});

/**
 * The shell, split by what Phase 4 has to do with it: `wall` is full height and
 * opaque, `partition` is desk-height, `glazing` is full height and translucent.
 * Generator 2 emitted one untagged array and dropped glazing altogether, which
 * is fine flat on a drawing and wrong in three dimensions.
 */
export const wallLayerSchema = z.enum(["wall", "partition", "glazing"]);
export type WallLayer = z.infer<typeof wallLayerSchema>;

export const wallsSchema = z.object({
  viewBox: z.string(),
  polygons: z.array(
    z.object({
      layer: wallLayerSchema,
      closed: z.boolean(),
      points: z.array(point).min(2),
    }),
  ),
});

/**
 * Static furniture massing — everything on the floor that is NOT a bookable
 * desk: the boardroom and meeting room tables, both lounges, the foldable
 * tables, the storage credenzas, the planters.
 *
 * One minimum-area ORIENTED box per chained CAD outline, because the two side
 * wings are drawn at 45 degrees and an axis-aligned box round a sofa in zone B
 * is half again too big and points the wrong way.
 *
 * This is context, never content. Nothing here is interactive, nothing here
 * carries a booking status, and nothing here is a seat.
 */
export const furnitureKindSchema = z.enum([
  "table",
  "seating",
  "planter",
  "modular",
]);
export type FurnitureKind = z.infer<typeof furnitureKindSchema>;

export const furnitureSchema = z.object({
  viewBox: z.string(),
  items: z.array(
    z.object({
      kind: furnitureKindSchema,
      x: z.number(),
      y: z.number(),
      w: z.number().positive(),
      h: z.number().positive(),
      /** Plan-space rotation of the box's long axis, 0..180. */
      rotationDeg: z.number().min(0).max(180),
    }),
  ),
});

/**
 * Zone A's room schedule, read off the drawing's own bay tags and PAX
 * annotations. `pax` is null for the bays that carry no count — A4 (storage)
 * and A5 (the lounge).
 *
 * Kept apart from seat detection on purpose: `bay_anchors` in the extractor
 * skips every zone-A tag so that a meeting room's capacity can never be
 * imported as a desk count. This is the same text, read separately, for
 * labelling only.
 */
export const roomsSchema = z.object({
  viewBox: z.string(),
  rooms: z.array(
    z.object({
      bayCode: z.string(),
      pax: z.number().int().nullable(),
      planX: z.number(),
      planY: z.number(),
    }),
  ),
});

export const zonesSchema = z.object({
  viewBox: z.string(),
  zones: z
    .array(
      z.object({
        code: z.enum(["A", "B", "C", "D"]),
        labelAnchor: point,
        polygon: z.array(point).min(3),
      }),
    )
    .min(1),
});

/**
 * How a seat's position was arrived at. `detected` means a chair block was
 * found in the drawing at that spot; `interpolated` means the bay came up
 * short and the position was extended along the run's own axis; `manual`
 * means somebody moved it in the editor at /admin/floor-plan.
 */
export const anchorSourceSchema = z.enum(["detected", "interpolated", "manual"]);
export type AnchorSource = z.infer<typeof anchorSourceSchema>;

export const seatAnchorSchema = z.object({
  seatCode: z.string(),
  bay: z.string(),
  zone: z.enum(["A", "B", "C", "D"]),
  planX: z.number(),
  planY: z.number(),
  rotationDeg: z.number().int().min(0).max(359),
  source: anchorSourceSchema,
});
export type SeatAnchor = z.infer<typeof seatAnchorSchema>;

export const seatAnchorsSchema = z.object({
  viewBox: z.string(),
  seats: z.array(seatAnchorSchema),
});

export const detectedModulesSchema = z.object({
  viewBox: z.string(),
  modules: z.array(
    z.object({ x: z.number(), y: z.number(), rotationDeg: z.number().int() }),
  ),
});

export const detectionReportSchema = z.object({
  generatedFrom: z.string(),
  sourceSha256: z.string(),
  /** The drawing's own headline figure, from its title block. */
  sheetTotalWorkingPeople: z.number().int().nullable(),
  sheetExclusionNote: z.string().nullable(),
  scheduleDrift: z.record(
    z.string(),
    z.object({ drawingPax: z.number(), schedule: z.number() }),
  ),
  baysWithoutDrawingPax: z.array(z.string()),
  /**
   * The `8 PAX` annotation on the A1/A2 workstation run.
   *
   * `baysWithoutDrawingPax` has said ["A1","A2"] since Phase 2, and the
   * handoffs repeated that the drawing confirms only 133 of the 141 seats.
   * That was wrong: the annotation exists, 19.1 plan units from the A2 tag,
   * and reads 8 — exactly A1 + A2 in the bay schedule. It was never seen
   * because `bay_anchors` skips every zone-A tag, a guard that is right (it
   * stops a meeting room's capacity becoming a desk count) and that threw out
   * the one zone-A annotation which IS a desk count.
   *
   * Reported, never applied. It confirms the PAIR totals 8; how the 8 split
   * between A1 and A2 is still ours.
   */
  workstationRunPax: z.number().int().nullable().optional(),
  seatsConfirmedByDrawingPax: z.number().int(),
  /**
   * R009 (ADR-049): the title block's own bay schedule and grade headcount,
   * in sheet order. The bay rows still use the R007 names (A1, D1–D8,
   * PASSAGE, C1–C7, B1, B2) and sum to the same total the plan's numbered
   * desks do, by a different grouping — ASSUMPTIONS A32.
   */
  sheetSchedule: z.array(z.object({ label: z.string(), pax: z.number().int().nullable() })).optional(),
  sheetHeadcountByGrade: z
    .array(z.object({ label: z.string(), pax: z.number().int().nullable() }))
    .optional(),
  /** False when the sheet carries no room tags and rooms.json is the R007 schedule carried forward (A33). */
  roomsFromSheet: z.boolean().optional(),
  zoneBChairsDetected: z.number().int(),
  zoneBExpected: z.number().int(),
  unassignedChairs: z.number().int(),
  unassignedChairsByZone: z.record(z.string(), z.number().int()),
  bays: z.array(
    z.object({
      bay: z.string(),
      zone: z.string(),
      expected: z.number().int(),
      drawingPax: z.number().int().nullable(),
      detected: z.number().int(),
      placed: z.number().int(),
      interpolated: z.number().int(),
      surplusDropped: z.number().int(),
    }),
  ),
});
export type DetectionReport = z.infer<typeof detectionReportSchema>;
