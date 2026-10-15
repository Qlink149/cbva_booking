import { describe, expect, it } from "vitest";

import {
  DIMENSIONS,
  FLOOR_CENTRE,
  FLOOR_SIZE,
  METRES_PER_UNIT,
  SCALE_IS_ASSUMED,
  planLength,
  planRotationToY,
  planToWorld,
  worldToPlan,
} from "@/components/floor-plan/three/coords";
import { GLYPH_ORDER } from "@/components/floor-plan/three/seat-materials";
import { wallSegmentCount } from "@/components/floor-plan/three/wall-geometry";
import { SEAT_STATUSES } from "@/components/seat/seat-status";
import { TOTAL_SEATS } from "@/lib/seed-data/inventory";
import {
  FULL_FLOOR_BOUNDS,
  PLAN_BOUNDS,
  floorplanMeta,
  floorplanSeatAnchors,
  floorplanWalls,
} from "@/lib/floorplan";

/**
 * The 3D view's geometry, tested where it is testable.
 *
 * Everything here is the pure half: the transform from the architect's plan
 * coordinates into world metres, and the shape of the data the scene extrudes.
 * The scene itself is verified in the browser, because a WebGL frame is not
 * something a node test can look at — `e2e/floor-plan-3d.spec.ts` covers draw
 * calls, picking and the shared selection, and the screenshots cover whether it
 * actually looks like the building.
 */
describe("the plan-to-world transform", () => {
  it("uses the drawing's own scale", () => {
    expect(SCALE_IS_ASSUMED).toBe(false);
    expect(METRES_PER_UNIT).toBeCloseTo(0.0705556, 6);
    // 1:200. If a future drawing revision changes this, the building changes
    // size, so it is worth failing loudly rather than quietly rescaling.
    expect(floorplanMeta.mmPerUnit).toBe(70.5556);
  });

  it("puts the core of the building on the origin", () => {
    const [x, y, z] = planToWorld(...(floorplanMeta.coreCentre as [number, number]));
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBe(0);
    expect(z).toBeCloseTo(0, 9);
  });

  it("round-trips", () => {
    for (const seat of floorplanSeatAnchors.seats.slice(0, 20)) {
      const [x, , z] = planToWorld(seat.planX, seat.planY);
      const [px, py] = worldToPlan(x, z);
      expect(px).toBeCloseTo(seat.planX, 6);
      expect(py).toBeCloseTo(seat.planY, 6);
    }
  });

  it("keeps plan +Y pointing at world +Z, so top-down reproduces the drawing", () => {
    const [, , northZ] = planToWorld(700, 200);
    const [, , southZ] = planToWorld(700, 900);
    // Further DOWN the drawing must be further along +Z. Negating this axis is
    // the easy mistake, and it mirrors the whole floor.
    expect(southZ).toBeGreaterThan(northZ);

    const [westX] = planToWorld(200, 600);
    const [eastX] = planToWorld(1200, 600);
    expect(eastX).toBeGreaterThan(westX);
  });

  it("gives the building believable real-world dimensions", () => {
    // 1285 x 970 plan units at 70.5556 mm each.
    expect(FLOOR_SIZE.width).toBeCloseTo(90.66, 1);
    expect(FLOOR_SIZE.depth).toBeCloseTo(68.44, 1);
    // A 158-desk floor of roughly 6,200 m2 gross is plausible for a Mumbai
    // office plate; an order of magnitude out either way would mean the scale
    // recovery in the CAD build had gone wrong.
    expect(FLOOR_SIZE.width * FLOOR_SIZE.depth).toBeGreaterThan(3000);
    expect(FLOOR_SIZE.width * FLOOR_SIZE.depth).toBeLessThan(12000);
  });

  it("offsets the floor plane by the plan box, not the core", () => {
    // The sheet's plan box and the middle of the building are different points.
    // Conflating them slides the drawing off its own walls.
    const [cx, , cz] = FLOOR_CENTRE;
    const [expectedX, , expectedZ] = planToWorld(
      PLAN_BOUNDS.x + PLAN_BOUNDS.width / 2,
      PLAN_BOUNDS.y + PLAN_BOUNDS.height / 2,
    );
    expect(cx).toBeCloseTo(expectedX, 9);
    expect(cz).toBeCloseTo(expectedZ, 9);
    // They differ by only 0.43 m, but the sign of that offset is what decides
    // whether the drawing sits on its own walls or half a metre off them.
    expect(Math.hypot(cx, cz)).toBeGreaterThan(0.3);
  });

  it("negates rotation, because plan degrees are clockwise in a Y-down frame", () => {
    expect(planRotationToY(0)).toBeCloseTo(0, 9);
    expect(planRotationToY(90)).toBeCloseTo(-Math.PI / 2, 9);
    expect(planRotationToY(180)).toBeCloseTo(-Math.PI, 9);
  });

  it("measures a desk pitch that matches the drawing", () => {
    // The CAD build measured a 23.02-unit median workstation pitch and called
    // it 1,624 mm at 1:200. The desk mesh has to fit inside that.
    expect(planLength(23.02)).toBeCloseTo(1.624, 2);
    expect(DIMENSIONS.deskWidth).toBeLessThan(planLength(23.02));
  });
});

describe("the extruded shell", () => {
  it("has a segment for every edge of every chain", () => {
    const counts = wallSegmentCount();
    const total = counts.wall + counts.partition + counts.glazing;
    const expected = floorplanWalls.polygons.reduce(
      (sum, p) => sum + (p.closed ? p.points.length : p.points.length - 1),
      0,
    );
    expect(total).toBe(expected);
    // Every class contributes. A silent zero here would mean a whole layer
    // vanished from the drawing without the build noticing.
    expect(counts.wall).toBeGreaterThan(0);
    expect(counts.partition).toBeGreaterThan(0);
    expect(counts.glazing).toBeGreaterThan(0);
  });

  it("stays small enough to merge into three meshes", () => {
    const counts = wallSegmentCount();
    const total = counts.wall + counts.partition + counts.glazing;
    // Each segment is a 12-triangle box. The budget is about keeping the whole
    // scene under 60 draw calls and a mid-range GPU's comfort, not about the
    // triangle count, which is trivial either way.
    expect(total).toBeLessThan(3000);
    expect(total * 12).toBeLessThan(40_000);
  });

  it("sits inside the floor plane it is drawn on", () => {
    for (const polygon of floorplanWalls.polygons) {
      for (const [px, py] of polygon.points) {
        const [x, , z] = planToWorld(px, py);
        expect(Math.abs(x)).toBeLessThan(FLOOR_SIZE.width);
        expect(Math.abs(z)).toBeLessThan(FLOOR_SIZE.depth);
      }
    }
  });

  it("keeps partitions below eye level and walls above it", () => {
    // The whole reason the shell is split three ways: you can see over a
    // partition and not over a wall, and that has to be true of the model.
    expect(DIMENSIONS.partitionHeight).toBeLessThan(1.6);
    expect(DIMENSIONS.wallHeight).toBeGreaterThan(2.4);
    expect(DIMENSIONS.partitionHeight).toBeLessThan(DIMENSIONS.wallHeight);
  });
});

describe("the seat status vocabulary reaching three.js", () => {
  it("covers every status exactly once, in the order the atlas bakes", () => {
    // ADR-010: one vocabulary. If a status is added to seat-status.ts and not
    // here, that seat renders with no colour and no glyph — so this is the
    // guard that makes the compile-time Record meaningful at runtime too.
    expect([...GLYPH_ORDER].sort()).toEqual([...SEAT_STATUSES].sort());
    expect(GLYPH_ORDER.length).toBe(SEAT_STATUSES.length);
    expect(new Set(GLYPH_ORDER).size).toBe(GLYPH_ORDER.length);
  });
});

describe("the seats the 3D view places", () => {
  it("places every desk within the floor plane", () => {
    expect(floorplanSeatAnchors.seats).toHaveLength(TOTAL_SEATS);
    for (const seat of floorplanSeatAnchors.seats) {
      const [x, , z] = planToWorld(seat.planX, seat.planY);
      expect(Math.abs(x)).toBeLessThan(FLOOR_SIZE.width / 2 + 1);
      expect(Math.abs(z)).toBeLessThan(FLOOR_SIZE.depth / 2 + 1);
    }
  });

  /**
   * The 3D view surfaced a data defect the 2D plan had been hiding.
   *
   * Two dots 6 cm apart on a floor 90 m wide are the same pixel at fit-to-floor
   * zoom, so `/floor` has always drawn C7-04 and PA-15 on top of each other and
   * nobody could tell. Two 1.3 m desk MESHES 6 cm apart are unmistakable.
   *
   * Under R007 every offending pair involved one of the eleven INTERPOLATED
   * anchors — the desks Phase 2 could not detect. Under R009 (ADR-049) every
   * desk is numbered on the plan and snaps onto its own chair block, so there
   * are no interpolated anchors and no pair may intersect at all. A24 is
   * closed; this is what keeps it closed.
   */
  const worldPairs = () => {
    const points = floorplanSeatAnchors.seats.map((s) => ({
      code: s.seatCode,
      source: s.source,
      p: planToWorld(s.planX, s.planY),
    }));
    const out: Array<{ a: (typeof points)[number]; b: (typeof points)[number]; d: number }> = [];
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const d = Math.hypot(points[i].p[0] - points[j].p[0], points[i].p[2] - points[j].p[2]);
        out.push({ a: points[i], b: points[j], d });
      }
    }
    return out;
  };

  it("never intersects two desks that were both detected from the drawing", () => {
    const closest = worldPairs()
      .filter(({ a, b }) => a.source === "detected" && b.source === "detected")
      .reduce((min, { d }) => Math.min(min, d), Infinity);
    // 19.19 plan units between desks 89 and 90, at 70.5556 mm each.
    expect(closest).toBeCloseTo(1.35, 1);
    expect(closest).toBeGreaterThan(DIMENSIONS.deskWidth);
  });

  it("has no interpolated anchors and no overlapping pair", () => {
    expect(floorplanSeatAnchors.seats.filter((s) => s.source === "interpolated")).toEqual([]);
    const tight = worldPairs().filter(({ d }) => d < DIMENSIONS.deskWidth);
    expect(tight.map(({ a, b, d }) => `${a.code} vs ${b.code} ${d.toFixed(2)} m`)).toEqual([]);
  });

  it("frames the whole floor from bounds that contain every seat", () => {
    for (const seat of floorplanSeatAnchors.seats) {
      expect(seat.planX).toBeGreaterThanOrEqual(FULL_FLOOR_BOUNDS.x);
      expect(seat.planX).toBeLessThanOrEqual(FULL_FLOOR_BOUNDS.x + FULL_FLOOR_BOUNDS.width);
      expect(seat.planY).toBeGreaterThanOrEqual(FULL_FLOOR_BOUNDS.y);
      expect(seat.planY).toBeLessThanOrEqual(FULL_FLOOR_BOUNDS.y + FULL_FLOOR_BOUNDS.height);
    }
  });
});
