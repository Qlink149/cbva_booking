/**
 * Typed access to the generated floor plan geometry.
 *
 * `src/data/floorplan/` is written by `npm run build:floorplan` from the
 * architect's PDF and committed, so importing it is a compile-time constant on
 * both server and client — no fetch, no loading state, no runtime parse cost
 * for the wall and zone geometry.
 *
 * seats.json is the source of truth for seat position: the seed reads it, and
 * the editor at /admin/floor-plan writes back to it. The database mirrors it so
 * that a desk can be moved without a redeploy.
 */
import detectedModulesJson from "@/data/floorplan/detected-modules.json";
import detectionReportJson from "@/data/floorplan/detection-report.json";
import furnitureJson from "@/data/floorplan/furniture.json";
import roomsJson from "@/data/floorplan/rooms.json";
import metaJson from "@/data/floorplan/meta.json";
import seatsJson from "@/data/floorplan/seats.json";
import wallsJson from "@/data/floorplan/walls.json";
import zonesJson from "@/data/floorplan/zones.json";
import {
  detectedModulesSchema,
  detectionReportSchema,
  floorplanMetaSchema,
  furnitureSchema,
  roomsSchema,
  seatAnchorsSchema,
  wallsSchema,
  zonesSchema,
} from "@/lib/floorplan-schema";

export const floorplanMeta = floorplanMetaSchema.parse(metaJson);
export const floorplanWalls = wallsSchema.parse(wallsJson);
export const floorplanZones = zonesSchema.parse(zonesJson);
/** Static furniture massing — context, never content. See ADR-044. */
export const floorplanFurniture = furnitureSchema.parse(furnitureJson);
/** Zone A's room schedule, for labelling. Never feeds seat detection. */
export const floorplanRooms = roomsSchema.parse(roomsJson);
export const floorplanSeatAnchors = seatAnchorsSchema.parse(seatsJson);
export const floorplanDetectedModules = detectedModulesSchema.parse(detectedModulesJson);
export const floorplanDetectionReport = detectionReportSchema.parse(detectionReportJson);

export const PLAN_BOUNDS = floorplanMeta.planBounds;
export const PLAN_VIEWBOX = floorplanMeta.viewBox;

export type ZoneCode = (typeof floorplanZones.zones)[number]["code"];

const anchorsByCode = new Map(
  floorplanSeatAnchors.seats.map((s) => [s.seatCode, s] as const),
);

export function seatAnchor(seatCode: string) {
  return anchorsByCode.get(seatCode);
}

/** Zone outlines keyed by code, for highlighting and hit testing. */
export const zoneByCode = new Map(floorplanZones.zones.map((z) => [z.code, z] as const));

/**
 * Bounding box of a set of plan points, padded. Used to frame a zone or the
 * whole floor in the viewport.
 */
export function boundsOf(points: Array<readonly [number, number]>, pad = 0) {
  if (points.length === 0) {
    return { x: PLAN_BOUNDS.x, y: PLAN_BOUNDS.y, width: PLAN_BOUNDS.width, height: PLAN_BOUNDS.height };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

export const FULL_FLOOR_BOUNDS = boundsOf(
  floorplanZones.zones.flatMap((z) => z.polygon as Array<readonly [number, number]>),
  12,
);

export function zoneBounds(code: ZoneCode) {
  const zone = zoneByCode.get(code);
  if (!zone) return FULL_FLOOR_BOUNDS;
  return boundsOf(zone.polygon as Array<readonly [number, number]>, 16);
}

/**
 * A zone's bounding box, tight to its own SEATS rather than to `zoneBounds`'s
 * convex hull (A4, Phase 8).
 *
 * The hull each zone carries in `zones.json` is built by fanning out from the
 * building's interior centroid (`tools/cad/build_floorplan.py` `build_zones`),
 * so every hull includes the core and adjacent zone rectangles overlap it by
 * roughly 32 plan units once `zoneBounds`'s own padding is added. That is
 * enough to push a zone-focus fit below `LOD_2D_EXIT_BAY` / `LOD_3D_EXIT_BAY`,
 * landing a zone selection in bay/chip detail instead of per-seat — the
 * opposite of what picking a zone is for.
 *
 * This is the tightest fit a zone can have — it is built from the desks
 * themselves — and needs no change to the committed geometry: it fixes the
 * zone-view LOD problem at every viewport down to about 490px wide purely by
 * dropping the core overlap. Below that width the wing's own physical extent
 * (not the hull) is what does not fit; see the LOD-forcing note beside the
 * callers of this function.
 */
export function zoneSeatBounds(
  seats: ReadonlyArray<{ zone: ZoneCode; planX: number; planY: number }>,
  code: ZoneCode,
  pad = 24,
) {
  const points = seats
    .filter((s) => s.zone === code)
    .map((s) => [s.planX, s.planY] as const);
  // A zone with no seats (none today; zone B had none under R007) has nothing
  // to fit tightly to, so fall back to the hull bbox.
  if (points.length === 0) return zoneBounds(code);
  return boundsOf(points, pad);
}

/**
 * Nearest detected chair block to a point, within `maxDistance` plan units.
 * This is what "snap to nearest detected workstation" in the editor uses, and
 * it searches every module the extraction found — including ones no seat was
 * assigned to, which is exactly where a bad detection needs rescuing.
 */
export function nearestDetectedModule(x: number, y: number, maxDistance = 40) {
  let best: { x: number; y: number; rotationDeg: number; distance: number } | null = null;
  for (const m of floorplanDetectedModules.modules) {
    const d = Math.hypot(m.x - x, m.y - y);
    if (d <= maxDistance && (best === null || d < best.distance)) {
      best = { x: m.x, y: m.y, rotationDeg: m.rotationDeg, distance: d };
    }
  }
  return best;
}
