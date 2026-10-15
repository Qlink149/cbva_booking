import { describe, expect, it } from "vitest";

import { BAYS, MEETING_ROOMS, TOTAL_SEATS, seatCodes } from "@/lib/seed-data/inventory";
import {
  FULL_FLOOR_BOUNDS,
  PLAN_BOUNDS,
  floorplanDetectedModules,
  floorplanDetectionReport,
  floorplanFurniture,
  floorplanMeta,
  floorplanRooms,
  floorplanSeatAnchors,
  floorplanWalls,
  floorplanZones,
  nearestDetectedModule,
  seatAnchor,
} from "@/lib/floorplan";
import { PLAN_LABELS, nonBookableSummary } from "@/lib/floorplan-labels";

/**
 * Guards on the generated CAD geometry.
 *
 * These are not testing the extractor's arithmetic — they are the contract
 * between `npm run build:floorplan` and everything downstream. If somebody
 * regenerates the geometry from a revised drawing and a bay changes size, or a
 * seat lands outside the building, this is where it stops.
 */
describe("generated floor plan geometry", () => {
  it("carries an anchor for every seat in the bay schedule, and no others", () => {
    const expected = BAYS.flatMap(seatCodes).sort();
    const actual = floorplanSeatAnchors.seats.map((s) => s.seatCode).sort();
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(TOTAL_SEATS);
  });

  it("agrees with the bay schedule on every bay's size", () => {
    for (const bay of BAYS) {
      const placed = floorplanSeatAnchors.seats.filter((s) => s.bay === bay.bay);
      expect(placed, `bay ${bay.bay}`).toHaveLength(bay.count);
    }
  });

  it("puts every seat inside the plan bounds", () => {
    for (const seat of floorplanSeatAnchors.seats) {
      expect(seat.planX).toBeGreaterThanOrEqual(PLAN_BOUNDS.x);
      expect(seat.planX).toBeLessThanOrEqual(PLAN_BOUNDS.x + PLAN_BOUNDS.width);
      expect(seat.planY).toBeGreaterThanOrEqual(PLAN_BOUNDS.y);
      expect(seat.planY).toBeLessThanOrEqual(PLAN_BOUNDS.y + PLAN_BOUNDS.height);
    }
  });

  it("does not stack two seats on the same spot", () => {
    // Detection assigning two seats to one chair is the failure mode that
    // would be invisible on screen and wrong in the analytics.
    const seen = new Set<string>();
    for (const seat of floorplanSeatAnchors.seats) {
      const key = `${seat.planX.toFixed(1)},${seat.planY.toFixed(1)}`;
      expect(seen.has(key), `${seat.seatCode} duplicates a position`).toBe(false);
      seen.add(key);
    }
  });

  it("keeps every seat in a bay near its bay-mates", () => {
    // A seat assigned to the wrong wing would sit hundreds of units from the
    // rest of its bay. Passage runs are long, so the bound is generous.
    for (const bay of BAYS) {
      const inBay = floorplanSeatAnchors.seats.filter((s) => s.bay === bay.bay);
      const cx = inBay.reduce((n, s) => n + s.planX, 0) / inBay.length;
      const cy = inBay.reduce((n, s) => n + s.planY, 0) / inBay.length;
      for (const seat of inBay) {
        const d = Math.hypot(seat.planX - cx, seat.planY - cy);
        expect(d, `${seat.seatCode} is ${d.toFixed(0)} from its bay centre`).toBeLessThan(
          220,
        );
      }
    }
  });

  it("gives every seat a rotation in range", () => {
    for (const seat of floorplanSeatAnchors.seats) {
      expect(seat.rotationDeg).toBeGreaterThanOrEqual(0);
      expect(seat.rotationDeg).toBeLessThan(360);
      expect(Number.isInteger(seat.rotationDeg)).toBe(true);
    }
  });

  it("stays under the wall polygon budget Phase 4 extrudes", () => {
    // 400 in generator 2, when walls were one untagged class and glazing was
    // dropped. Generator 3 splits the shell three ways and adds glazing, which
    // chains to 280 runs on its own; truncating to fit 400 lost 45% of the
    // curtain wall. 600 is what the three classes actually need, and it is
    // still three draw calls once merged (ADR-030).
    expect(floorplanWalls.polygons.length).toBeLessThan(600);
    expect(floorplanWalls.polygons.length).toBeGreaterThan(50);
  });

  it("splits the shell into the three classes Phase 4 renders differently", () => {
    const byLayer = new Map<string, number>();
    for (const p of floorplanWalls.polygons) {
      byLayer.set(p.layer, (byLayer.get(p.layer) ?? 0) + 1);
    }
    expect([...byLayer.keys()].sort()).toEqual(["glazing", "partition", "wall"]);
    for (const [layer, budget] of [
      ["wall", 150],
      ["partition", 200],
      ["glazing", 300],
    ] as const) {
      expect(byLayer.get(layer) ?? 0).toBeGreaterThan(0);
      expect(byLayer.get(layer) ?? 0).toBeLessThanOrEqual(budget);
    }
  });

  it("carries no hatch fills among the wall chains", () => {
    // Generator 2 shipped a 61-point, 971-unit zig-zag inside a 35-unit box as
    // the LONGEST polygon in the file. Flat it is invisible; extruded it is a
    // thicket in zone A. The discriminator is how often the chain doubles back.
    const reversalShare = (points: ReadonlyArray<readonly [number, number]>) => {
      let total = 0;
      let reversals = 0;
      for (let i = 1; i < points.length - 1; i += 1) {
        const [ax, ay] = points[i - 1];
        const [bx, by] = points[i];
        const [cx, cy] = points[i + 1];
        const ux = bx - ax;
        const uy = by - ay;
        const vx = cx - bx;
        const vy = cy - by;
        const lu = Math.hypot(ux, uy);
        const lv = Math.hypot(vx, vy);
        if (lu < 1e-9 || lv < 1e-9) continue;
        total += 1;
        if ((ux * vx + uy * vy) / (lu * lv) < -0.7) reversals += 1;
      }
      return total === 0 ? 0 : reversals / total;
    };

    for (const p of floorplanWalls.polygons) {
      if (p.points.length < 6) continue;
      expect(reversalShare(p.points)).toBeLessThan(0.8);
    }
  });

  it("describes all four wings", () => {
    expect(floorplanZones.zones.map((z) => z.code).sort()).toEqual(["A", "B", "C", "D"]);
    for (const zone of floorplanZones.zones) {
      expect(zone.polygon.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("frames a floor larger than any single wing", () => {
    expect(FULL_FLOOR_BOUNDS.width).toBeGreaterThan(400);
    expect(FULL_FLOOR_BOUNDS.height).toBeGreaterThan(400);
  });

  it("records the source drawing's checksum so a revision is detectable", () => {
    expect(floorplanMeta.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(floorplanMeta.source).toContain(".pdf");
  });

  it("resolves the plot scale to something a desk-sized object fits", () => {
    // 1:200 on a 72dpi page. A workstation pitch of ~23 plan units has to come
    // out as roughly 1.5m or the scale is wrong and Phase 4 will build a
    // dolls' house.
    expect(floorplanMeta.mmPerUnit).not.toBeNull();
    const pitchMm = 23 * (floorplanMeta.mmPerUnit ?? 0);
    expect(pitchMm).toBeGreaterThan(1200);
    expect(pitchMm).toBeLessThan(2000);
  });
});

describe("detection report", () => {
  it("reconciles to the bay schedule", () => {
    const placed = floorplanDetectionReport.bays.reduce((n, b) => n + b.placed, 0);
    expect(placed).toBe(TOTAL_SEATS);
  });

  it("never silently drops a detected desk", () => {
    for (const bay of floorplanDetectionReport.bays) {
      expect(bay.detected + bay.interpolated - bay.surplusDropped).toBe(bay.expected);
    }
  });

  it("records no drift between the drawing's pax counts and the schedule", () => {
    expect(floorplanDetectionReport.scheduleDrift).toEqual({});
  });

  it("carries the drawing's own headline total and its exclusion note", () => {
    // The title block is a second source for the total, independent of the
    // numbered desks on the plan. The note is what explains why zone A's
    // conference rooms hold chairs but no seats.
    expect(floorplanDetectionReport.sheetTotalWorkingPeople).toBe(TOTAL_SEATS);
    expect(floorplanDetectionReport.sheetExclusionNote).toBe(
      "NOTE: CONFERENCE AREA AND CAFETERIA NOT INCLUDED.",
    );
  });

  it("has every bay confirmed by the drawing, because every desk is numbered on it", () => {
    // R009 (ADR-049). There is no PAX pairing left to be unsure about: the
    // count of a bay is the count of numbered desks beside its letter.
    expect(floorplanDetectionReport.baysWithoutDrawingPax).toEqual([]);
    expect(floorplanDetectionReport.seatsConfirmedByDrawingPax).toBe(TOTAL_SEATS);
    expect(floorplanDetectionReport.workstationRunPax).toBeNull();
  });

  it("reads the title block's own schedule, which reaches the same total under the old bay names", () => {
    // The sheet still lists A1, D1-D8, PASSAGE, C1-C7, B1, B2 and a grade
    // headcount; both sum to what the plan's numbers do. ASSUMPTIONS A32.
    const bays = floorplanDetectionReport.sheetSchedule ?? [];
    const grades = floorplanDetectionReport.sheetHeadcountByGrade ?? [];
    expect(bays.length).toBeGreaterThan(10);
    expect(bays.reduce((n, r) => n + (r.pax ?? 0), 0)).toBe(TOTAL_SEATS);
    expect(grades.reduce((n, r) => n + (r.pax ?? 0), 0)).toBe(TOTAL_SEATS);
    expect(bays.map((r) => r.label)).toContain("B1");
    expect(grades.find((r) => r.label === "B.")?.pax).toBe(17);
  });

  it("reports zone B's seats and its remaining chairs", () => {
    // 17 numbered workstations (bay C) plus the modular lounge seating R007
    // already had, which no desk number sits on.
    expect(floorplanDetectionReport.zoneBExpected).toBe(17);
    expect(floorplanDetectionReport.zoneBChairsDetected).toBeGreaterThan(0);
  });
});

describe("editor helpers", () => {
  it("finds a seat's anchor by code", () => {
    expect(seatAnchor("36")?.bay).toBe("F");
    expect(seatAnchor("36")?.zone).toBe("C");
    expect(seatAnchor("C3-01")).toBeUndefined();
    expect(seatAnchor("159")).toBeUndefined();
  });

  it("snaps to a detected module when one is close", () => {
    const seat = floorplanSeatAnchors.seats.find((s) => s.source === "detected");
    expect(seat).toBeDefined();
    const hit = nearestDetectedModule(seat!.planX, seat!.planY, 5);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeLessThan(5);
  });

  it("declines to snap when nothing is near", () => {
    expect(nearestDetectedModule(PLAN_BOUNDS.x + 1, PLAN_BOUNDS.y + 1, 10)).toBeNull();
  });

  it("keeps unassigned modules available to snap to", () => {
    // The whole point of exporting every detected module, not just the
    // assigned ones: where assignment failed is where snapping is needed.
    expect(floorplanDetectedModules.modules.length).toBeGreaterThan(
      floorplanSeatAnchors.seats.filter((s) => s.source === "detected").length,
    );
  });
});

/* ------------------------------------------------------- A24: desk overlaps */

describe("no two desks occupy the same space (ASSUMPTIONS A24)", () => {
  // mmPerUnit may legitimately be null when the plot scale cannot be
  // recovered; the committed drawing has it, and a test that silently passes
  // on null would be testing nothing.
  const MM_PER_UNIT = floorplanMeta.mmPerUnit ?? 0;
  /** A desk is 1.30 m wide. Two anchors closer than that are the same desk. */
  const MIN_UNITS = 1300 / MM_PER_UNIT;
  const metres = (u: number) => (u * MM_PER_UNIT) / 1000;

  const pairs = (() => {
    const seats = floorplanSeatAnchors.seats;
    const out: Array<{ a: string; b: string; m: number }> = [];
    for (let i = 0; i < seats.length; i++) {
      for (let k = i + 1; k < seats.length; k++) {
        const d = Math.hypot(
          seats[i]!.planX - seats[k]!.planX,
          seats[i]!.planY - seats[k]!.planY,
        );
        if (d < MIN_UNITS) {
          out.push({ a: seats[i]!.seatCode, b: seats[k]!.seatCode, m: metres(d) });
        }
      }
    }
    return out.sort((x, y) => x.m - y.m);
  })();

  /**
   * The regression test for A24.
   *
   * Fifteen pairs overlapped before Phase 5 — the worst being C7-04 six
   * centimetres from PA-15, which is one desk drawn twice. Two anchors that
   * close are a single pixel at fit-to-floor zoom, which is why this survived
   * two phases on the 2D plan and was only obvious once the desks became solid
   * objects in the 3D view.
   *
   * It matters beyond looks: two desks at one pixel means a click resolves
   * ambiguously, and the person clicking is a partner seeing this for the first
   * time.
   */
  it("knows the drawing scale, so the distance check means something", () => {
    expect(MM_PER_UNIT).toBeGreaterThan(0);
  });

  it("has no pair of desks closer than a desk is wide", () => {
    expect(
      pairs.map((p) => `${p.a}↔${p.b} ${p.m.toFixed(2)}m`),
    ).toEqual([]);
  });

  it("still has every desk after the de-collide step", () => {
    expect(floorplanSeatAnchors.seats).toHaveLength(TOTAL_SEATS);
    expect(new Set(floorplanSeatAnchors.seats.map((s) => s.seatCode)).size).toBe(TOTAL_SEATS);
  });

  /**
   * A24 closed with R009. Under R007 eleven desks could not be found in the
   * drawing and were interpolated along their bay's axis. R009 numbers every
   * desk on the plan and every number snaps onto its own chair block, so
   * nothing is inferred any more. If a revision ever leaves a desk without a
   * chair within reach, the extractor marks it `interpolated` again and this
   * is where it is noticed.
   */
  it("places every desk from a chair block, with nothing interpolated", () => {
    const interpolated = floorplanSeatAnchors.seats
      .filter((s) => s.source === "interpolated")
      .map((s) => s.seatCode);
    expect(interpolated).toEqual([]);
    expect(floorplanDetectionReport.bays.reduce((n, b) => n + b.interpolated, 0)).toBe(0);
  });

  it("uses the architect's desk numbers as seat codes, contiguous per bay", () => {
    // ADR-049: "37" is what is printed beside the desk, so "37" is the code.
    for (const bay of BAYS) {
      const codes = floorplanSeatAnchors.seats
        .filter((s) => s.bay === bay.bay)
        .map((s) => Number(s.seatCode))
        .sort((a, b) => a - b);
      expect(codes[0]).toBe(bay.firstDesk);
      expect(codes.at(-1)).toBe(bay.firstDesk + bay.count - 1);
      expect(codes.every((c, i) => i === 0 || c === codes[i - 1]! + 1)).toBe(true);
    }
    expect(floorplanSeatAnchors.seats.every((s) => /^\d{1,3}$/.test(s.seatCode))).toBe(true);
  });
});

/**
 * Static furniture (ADR-044).
 *
 * The layer exists for one reason: zones A and B contain a 25-person
 * boardroom, four meeting rooms, two lounges, eight foldable tables and a run
 * of storage credenzas, and not one bookable desk — so before this they
 * rendered as bare plate. These guard the property that makes it worth having
 * rather than the exact box count, which will move if the drawing is revised.
 */
describe("static furniture massing", () => {
  const items = floorplanFurniture.items;

  it("produces every kind, so no class can silently vanish", () => {
    for (const kind of ["table", "seating", "planter", "modular"] as const) {
      expect(items.filter((f) => f.kind === kind).length).toBeGreaterThan(0);
    }
  });

  it("puts furniture in zones A and B, which is the whole point", () => {
    // The two west wings, in plan coordinates. Zone A is the boardroom and the
    // meeting rooms; zone B is the lounge seating beside its 17 workstations.
    const west = items.filter((f) => f.x < 620);
    expect(west.length).toBeGreaterThan(100);
  });

  it("keeps every box inside the plan bounds", () => {
    const b = PLAN_BOUNDS;
    for (const f of items) {
      expect(f.x).toBeGreaterThanOrEqual(b.x);
      expect(f.x).toBeLessThanOrEqual(b.x + b.width);
      expect(f.y).toBeGreaterThanOrEqual(b.y);
      expect(f.y).toBeLessThanOrEqual(b.y + b.height);
    }
  });

  it("has plausible real-world dimensions", () => {
    const mm = floorplanMeta.mmPerUnit ?? 70.5556;
    for (const f of items) {
      const longest = (Math.max(f.w, f.h) * mm) / 1000;
      // 100 mm is the sliver filter; 20 m is longer than any wing is wide.
      expect(longest).toBeGreaterThan(0.1);
      expect(longest).toBeLessThan(20);
    }
    const seating = items
      .filter((f) => f.kind === "seating")
      .map((f) => (Math.max(f.w, f.h) * mm) / 1000)
      .sort((a, b) => a - b);
    // A thing somebody sits on is not three metres long. This is the threshold
    // that separates seating from tables inside F-LOOSE FURNITURE.
    expect(seating[Math.floor(seating.length / 2)]).toBeLessThan(1.6);
  });

  it("stays within a budget the 3D view can draw in one call per kind", () => {
    expect(items.length).toBeLessThan(800);
    for (const f of items) {
      expect(f.rotationDeg).toBeGreaterThanOrEqual(0);
      expect(f.rotationDeg).toBeLessThanOrEqual(180);
    }
  });
});

/**
 * Room labels (ADR-045).
 *
 * The capacities here came off the drawing by a different route from the ones
 * seeded into MEETING_ROOMS — the extractor reads zone A's bay tags and PAX
 * annotations, which seat detection deliberately throws away. Asserting the
 * two agree is a real cross-check, not a tautology: if a future revision moves
 * a PAX annotation, this fails rather than the plan and the rooms screen
 * quietly disagreeing.
 */
describe("room labels", () => {
  it("reads zone A's room schedule off the drawing", () => {
    const byBay = new Map(floorplanRooms.rooms.map((r) => [r.bayCode, r.pax]));
    expect(byBay.get("A3")).toBe(25);
    expect(byBay.get("A9")).toBe(10);
    expect(byBay.get("A8")).toBe(7);
    expect(byBay.get("A7")).toBe(5);
    expect(byBay.get("A6")).toBe(5);
    // Storage and the lounge are not rooms with a capacity, and the drawing
    // gives them no PAX. A null here is the drawing being read correctly.
    expect(byBay.get("A4")).toBeNull();
    expect(byBay.get("A5")).toBeNull();
  });

  it("agrees with the seeded meeting room inventory, bay for bay", () => {
    const drawing = new Map(floorplanRooms.rooms.map((r) => [r.bayCode, r.pax]));
    for (const room of MEETING_ROOMS) {
      expect(drawing.get(room.bayCode)).toBe(room.capacity);
    }
    // And the drawing has no room the inventory is missing.
    const seeded = new Set<string>(MEETING_ROOMS.map((r) => r.bayCode));
    const withPax = floorplanRooms.rooms.filter((r) => r.pax !== null).map((r) => r.bayCode);
    expect(withPax.sort()).toEqual([...seeded].sort());
  });

  it("labels every room, and puts them inside the plan", () => {
    // The seven zone-A rooms (A3-A9). No whole-wing labels any more.
    expect(PLAN_LABELS.length).toBe(7);
    for (const label of PLAN_LABELS) {
      expect(label.name.length).toBeGreaterThan(0);
      expect(label.planX).toBeGreaterThanOrEqual(PLAN_BOUNDS.x);
      expect(label.planX).toBeLessThanOrEqual(PLAN_BOUNDS.x + PLAN_BOUNDS.width);
      expect(label.planY).toBeGreaterThanOrEqual(PLAN_BOUNDS.y);
      expect(label.planY).toBeLessThanOrEqual(PLAN_BOUNDS.y + PLAN_BOUNDS.height);
    }
    // Zone B is no longer labelled as a wing: R009 put 17 bookable desks in
    // it, and a "Flexible room" label would sit on top of them.
    expect(PLAN_LABELS.some((l) => l.code === "B")).toBe(false);
  });

  it("is honest that R009 carries no room tags and the schedule is carried forward (A33)", () => {
    expect(floorplanDetectionReport.roomsFromSheet).toBe(false);
  });

  it("says why zone A is empty, in a sentence a screen reader can read", () => {
    const summary = nonBookableSummary();
    expect(summary).toContain("Boardroom (25 seats)");
    expect(summary).toContain("bays A and B");
    expect(summary.length).toBeGreaterThan(80);
  });
});

/**
 * The partners' cabins under R009: bays A and B, desks 1-8, where R007 had
 * A1/A2 with an `8 PAX` annotation beside the A2 tag. The annotation is gone
 * and the numbers replace it; the pair still totals 8.
 */
describe("the cabin desks in zone A", () => {
  it("are desks 1-8 in bays A and B, and nothing else is in zone A", () => {
    const zoneA = floorplanSeatAnchors.seats.filter((s) => s.zone === "A");
    expect(zoneA.map((s) => Number(s.seatCode)).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(new Set(zoneA.map((s) => s.bay))).toEqual(new Set(["A", "B"]));
  });

  it("match the bay schedule for the pair", () => {
    const a = BAYS.find((b) => b.bay === "A");
    const b = BAYS.find((b) => b.bay === "B");
    expect((a?.count ?? 0) + (b?.count ?? 0)).toBe(8);
  });
});
