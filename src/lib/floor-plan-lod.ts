/**
 * Level of detail for the floor plan, shared by the 2D and 3D renderings.
 *
 * WHY THIS EXISTS. Phase 4 recorded it and did not build it: at whole-floor
 * zoom the seven status fills are illegible, and Phase 7's colour-accurate
 * texture makes that worse rather than optional. Nobody picks a desk from
 * sixty metres up. The question at that framing is "how full is the floor and
 * which wing is busy", which is a DENSITY question, not a per-seat one.
 *
 * So past the threshold the plan answers the density question, and inside it
 * the plan answers the per-seat one. It does not try to make per-seat status
 * readable at a zoom where it never can be — the Phase 4 attempt to do that by
 * enlarging the glyph plate smeared the atlas across every desk, because the
 * atlas cell holds one CENTRED glyph and stretching the plate stretches the
 * glyph with it.
 *
 * WHAT THIS MODULE IS NOT. It is not a second colour vocabulary. A bay chip is
 * drawn from `--seat-booked-fill` against `--seat-available-fill`, the same two
 * values a seat uses, and it carries its own count as the non-colour
 * differentiator. There is exactly one colour map in this product.
 */
import type { FloorPlanSeat } from "@/components/floor-plan/types";
import { countsAsCapacity, countsAsOccupied } from "@/lib/seat-visual-status";

export type LodLevel = "seat" | "bay";

/**
 * The 2D thresholds, which are not a guess — they fall out of the marker size.
 *
 * `plan-canvas` sizes a marker `min(34, max(13, scale * 16))`, so below
 * scale 0.8125 the chip is PINNED at its 13px floor while the drawing's
 * 23-unit desk pitch keeps shrinking underneath it. That is the regime where
 * chips start colliding and a glyph stops being legible, and it is where the
 * switch belongs.
 *
 * Two values, not one. A single threshold flickers when a spring settles or a
 * trackpad drifts across it, and a flickering plan is worse than either state.
 */
export const LOD_2D_ENTER_BAY = 0.85;
export const LOD_2D_EXIT_BAY = 1.0;

/**
 * The 3D thresholds, in metres from the orbit target.
 *
 * Whole-floor framing sits around 95–115 m out depending on aspect; wing
 * framing is nearer 45 m. 70/55 puts the switch between the two, so a zone
 * focus is always per-seat and a whole-floor view is always density.
 */
export const LOD_3D_ENTER_BAY = 70;
export const LOD_3D_EXIT_BAY = 55;

/**
 * Hysteresis. `value` rising past `enter` switches to bay; falling past `exit`
 * switches back; between the two, whatever we were showing stays. Pure, so the
 * transition is a unit test rather than a thing to eyeball.
 *
 * The two views measure "how far away" in opposite directions -- 2D by zoom
 * scale, where SMALL is far, and 3D by camera distance, where LARGE is far --
 * so the orientation is read off the pair rather than hard-coded. `enter` below
 * `exit` is the zoom sense; `enter` above `exit` is the distance sense.
 */
export function resolveLod(
  previous: LodLevel,
  value: number,
  enter: number,
  exit: number,
): LodLevel {
  if (enter < exit) {
    // Zoom-like (2D): SMALL is far away, so bay detail is below `enter` and
    // seat detail above `exit`. enter 0.85 < exit 1.0.
    if (value <= enter) return "bay";
    if (value >= exit) return "seat";
    return previous;
  }
  // Distance-like (3D): LARGE is far away, so bay detail is above `enter` and
  // seat detail below `exit`. enter 70 > exit 55.
  if (value >= enter) return "bay";
  if (value <= exit) return "seat";
  return previous;
}

export interface BayOccupancy {
  bay: string;
  zone: FloorPlanSeat["zone"];
  /** Centroid of the bay's desks, in plan units. */
  planX: number;
  planY: number;
  /** Desks in this bay somebody is in or has claimed. */
  occupied: number;
  /** Desks in this bay that are part of the bookable supply at all. */
  capacity: number;
  /** Every desk drawn in this bay, including fixed and blocked ones. */
  desks: number;
}

/**
 * Occupancy per bay, from the same seat array both renderings already hold.
 *
 * NORMALISE BY THE BAY'S OWN CAPACITY. Phase 5 shipped a bay heat map that
 * counted occupied desks without dividing, so every cell saturated to the
 * bay's size and the map drew a picture of which bays were biggest. PD has 18
 * desks and D5 has one; an undivided count says nothing about either.
 *
 * `capacity` can be 0 — bay O is the one allocated management cabin and desk
 * 142 is blocked — so callers must guard the division. A bay with no bookable supply
 * is not 0% full, it is not a question.
 */
export function bayOccupancy(seats: FloorPlanSeat[]): BayOccupancy[] {
  const acc = new Map<string, BayOccupancy & { sumX: number; sumY: number }>();

  for (const seat of seats) {
    let row = acc.get(seat.bay);
    if (!row) {
      row = {
        bay: seat.bay,
        zone: seat.zone,
        planX: 0,
        planY: 0,
        occupied: 0,
        capacity: 0,
        desks: 0,
        sumX: 0,
        sumY: 0,
      };
      acc.set(seat.bay, row);
    }
    row.desks += 1;
    row.sumX += seat.planX;
    row.sumY += seat.planY;
    if (countsAsCapacity(seat.status)) row.capacity += 1;
    if (countsAsOccupied(seat.status)) row.occupied += 1;
  }

  return [...acc.values()]
    .map(({ sumX, sumY, ...row }) => ({
      ...row,
      // A centroid, deliberately, not a hull. PA (16 desks) and PD (18) are
      // long passage runs and the C and D wings are drawn at 45 degrees, so an
      // axis-aligned box would misdescribe four of the nineteen bays and an
      // oriented hull is work this does not need to do its job.
      planX: sumX / row.desks,
      planY: sumY / row.desks,
    }))
    .sort((a, b) => a.bay.localeCompare(b.bay));
}

/** The fraction to draw, or null when the bay holds no bookable supply. */
export function occupancyFraction(bay: BayOccupancy): number | null {
  return bay.capacity === 0 ? null : bay.occupied / bay.capacity;
}

export interface PlacedChip extends BayOccupancy {
  /** Centre of the chip after separation, in plan units. */
  chipX: number;
  chipY: number;
}

/**
 * Place one chip per bay, pushed apart so none covers another.
 *
 * Bay centroids are where the desks are, not where there is room to write, and
 * in the C and D wings four pairs sit within a chip's width of each other. Drawn
 * at the raw centroid, C5 covers C6 and D2 covers D3 -- so the layer that
 * exists to answer "which wing is busy" hides the two bays it is answering
 * about.
 *
 * A few rounds of pairwise separation fixes it. Deterministic: the input is
 * sorted by bay code, the iteration count is fixed, and there is no randomness,
 * so the same floor always lays out the same way and a screenshot is stable.
 *
 * Bays with no bookable supply are DROPPED, not drawn empty. C1, C2, C3 and the
 * cabins are allocated in full to fixed-grade staff; "0/0" is not a low
 * occupancy reading, it is not a question, and eight of those plates over the
 * drawing is noise that makes the eleven real ones harder to find.
 */
export function layoutBayChips(
  bays: BayOccupancy[],
  chipW: number,
  chipH: number,
  bounds: { x: number; y: number; width: number; height: number },
  rounds = 40,
): PlacedChip[] {
  const placed: PlacedChip[] = bays
    .filter((b) => b.capacity > 0)
    .map((b) => ({ ...b, chipX: b.planX, chipY: b.planY }));

  // Gaps, not just touching: a hairline between two plates still reads as one
  // wide plate at fit-to-floor.
  const gapX = chipW * 1.06;
  const gapY = chipH * 1.25;

  // Separation must not push a chip off the drawing. Clamped every round
  // rather than once at the end, so a chip pinned against an edge still
  // pushes its neighbours instead of being silently stacked under them.
  const clamp = (c: PlacedChip) => {
    // A chip may be nudged, not relocated. Left uncapped, separation walked
    // C3 nearly fifty pixels off its own desks and up against the top edge,
    // and a chip that far from its bay is mislabelling the floor rather than
    // decluttering it. Residual overlap plus a leader line is the better
    // trade: it is legible AND it points at the right desks.
    const dx = c.chipX - c.planX;
    const dy = c.chipY - c.planY;
    const reach = Math.hypot(dx, dy);
    const limit = chipH * 0.85;
    if (reach > limit) {
      c.chipX = c.planX + (dx / reach) * limit;
      c.chipY = c.planY + (dy / reach) * limit;
    }
    c.chipX = Math.min(
      bounds.x + bounds.width - chipW / 2,
      Math.max(bounds.x + chipW / 2, c.chipX),
    );
    c.chipY = Math.min(
      bounds.y + bounds.height - chipH / 2,
      Math.max(bounds.y + chipH / 2, c.chipY),
    );
  };
  placed.forEach(clamp);

  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (let i = 0; i < placed.length; i++) {
      for (let k = i + 1; k < placed.length; k++) {
        const a = placed[i];
        const b = placed[k];
        const dx = b.chipX - a.chipX;
        const dy = b.chipY - a.chipY;
        const overlapX = gapX - Math.abs(dx);
        const overlapY = gapY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        moved = true;
        // Separate along whichever axis needs the smaller correction, so a
        // chip travels the shortest distance from the desks it describes.
        if (overlapX / gapX < overlapY / gapY) {
          const push = (overlapX / 2) * (dx < 0 ? -1 : 1);
          a.chipX -= push;
          b.chipX += push;
        } else {
          const push = (overlapY / 2) * (dy < 0 ? -1 : 1);
          a.chipY -= push;
          b.chipY += push;
        }
      }
    }
    placed.forEach(clamp);
    if (!moved) break;
  }

  return placed;
}
