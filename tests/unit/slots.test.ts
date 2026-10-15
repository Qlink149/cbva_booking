/**
 * The seed inventory reconciliation.
 *
 * `deriveSlotBounds` and the slot vocabulary moved to booking-rules.test.ts in
 * Phase 3, when slots stopped being a two-value type and became settings data —
 * they belong beside the cut-off and the rest of the rules that read them.
 */
import { describe, expect, it } from "vitest";
import {
  BAYS,
  BLOCKED_SEAT_CODE,
  FIXED_SEAT_ALLOCATION,
  HEADCOUNT,
  TOTAL_HEADCOUNT,
  TOTAL_SEATS,
  seatCodes,
} from "@/lib/seed-data/inventory";

/**
 * The seed inventory has to reconcile against the CAD drawing exactly. If a bay
 * count is edited without the headcount following, analytics silently starts
 * reporting utilisation against the wrong denominator — and analytics is the
 * product.
 */
describe("seed inventory reconciliation", () => {
  it("totals 158 seats, matching the drawing's bay schedule (R009)", () => {
    expect(TOTAL_SEATS).toBe(158);
  });

  it("totals 158 people, matching the drawing's headcount", () => {
    expect(TOTAL_HEADCOUNT).toBe(158);
  });

  it("allocates exactly one fixed seat per fixed-grade person", () => {
    const fixedPeople = HEADCOUNT.filter((h) => h.seatMode === "fixed").reduce(
      (n, h) => n + h.count,
      0,
    );
    const fixedSeats = FIXED_SEAT_ALLOCATION.reduce((n, a) => n + a.codes.length, 0);
    expect(fixedPeople).toBe(47);
    expect(fixedSeats).toBe(47);
  });

  it("leaves one bookable seat for every person who must book", () => {
    const bookablePeople = HEADCOUNT.filter((h) => h.seatMode === "bookable").reduce(
      (n, h) => n + h.count,
      0,
    );
    const fixedSeats = FIXED_SEAT_ALLOCATION.reduce((n, a) => n + a.codes.length, 0);
    expect(bookablePeople).toBe(111);
    expect(TOTAL_SEATS - fixedSeats).toBe(111);
  });

  it("matches each fixed allocation block to its grade's headcount", () => {
    for (const alloc of FIXED_SEAT_ALLOCATION) {
      const bracket = HEADCOUNT.find((h) => h.grade === alloc.grade);
      expect(bracket, `no headcount bracket for ${alloc.grade}`).toBeDefined();
      expect(alloc.codes.length, `${alloc.grade} seat/people mismatch`).toBe(
        bracket!.count,
      );
    }
  });

  it("allocates only seat codes that actually exist", () => {
    const all = new Set(BAYS.flatMap(seatCodes));
    for (const alloc of FIXED_SEAT_ALLOCATION) {
      for (const code of alloc.codes) {
        expect(all.has(code), `${code} is not a real seat`).toBe(true);
      }
    }
  });

  it("never allocates the same seat twice", () => {
    const codes = FIXED_SEAT_ALLOCATION.flatMap((a) => a.codes);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("keeps every passage seat bookable", () => {
    const allocated = new Set(FIXED_SEAT_ALLOCATION.flatMap((a) => a.codes));
    const passage = BAYS.filter((b) => b.bay === "S" || b.bay === "T").flatMap(seatCodes);
    expect(passage.length).toBe(34);
    for (const code of passage) expect(allocated.has(code)).toBe(false);
  });

  it("uses the architect's desk numbers as seat codes, contiguous in bay order", () => {
    // R009 numbers every desk 1-158 on the plan; bay D is desks 26-31.
    const d = seatCodes(BAYS.find((b) => b.bay === "D")!);
    expect(d[0]).toBe("26");
    expect(d.at(-1)).toBe("31");
    const all = BAYS.flatMap(seatCodes);
    expect(all).toEqual(Array.from({ length: TOTAL_SEATS }, (_, i) => String(i + 1)));
  });

  it("keeps the blocked desk in a bookable bay, never an allocated one", () => {
    const allocated = new Set(FIXED_SEAT_ALLOCATION.flatMap((a) => a.codes));
    expect(BAYS.flatMap(seatCodes)).toContain(BLOCKED_SEAT_CODE);
    expect(allocated.has(BLOCKED_SEAT_CODE)).toBe(false);
  });
});
