/**
 * The rules that need no database: slot definitions, the cut-off, room ranges,
 * who may book for whom, and the translation of a Postgres error into something
 * a person can read.
 *
 * These are here rather than in the integration file because they are pure, and
 * a rule that can be tested in a millisecond should not need a round trip to
 * Singapore to prove.
 */
import { describe, expect, it } from "vitest";

import {
  assertBookingForSelf,
  assertMayBookFor,
  assertSeatBookable,
} from "@/lib/booking/authorise";
import { BookingError, mapPgError } from "@/lib/booking/errors";
import { assertBeforeCutoff, cutoffInstant, isPastCutoff, requireSlot } from "@/lib/booking/rules";
import { officeHourColumns, roomBookingSchema } from "@/lib/rooms/validation";
import type { AppSettings } from "@/lib/settings";
import type { Seat, User } from "@/lib/db/schema";
import {
  DEFAULT_SLOT_DEFINITIONS,
  deriveSlotBounds,
  hourlySlotDefinitions,
  minutesOfDay,
  parseSlotDefinitions,
  slotDefinitionsSchema,
} from "@/lib/slots";

/* ---------------------------------------------------------- slot vocabulary */

describe("slot definitions", () => {
  it("seeds the half days the brief specifies", () => {
    expect(DEFAULT_SLOT_DEFINITIONS).toEqual([
      { key: "AM", label: "Morning", start: "09:00", end: "13:00" },
      { key: "PM", label: "Afternoon", start: "13:00", end: "17:00" },
    ]);
  });

  it("accepts the legacy record shape and normalises it to an ordered list", () => {
    // A database seeded before Phase 3 holds { AM: {...}, PM: {...} }. Refusing
    // it would take the date strip down with an empty screen rather than a
    // migration error, which is a bad way to find out.
    const legacy = {
      PM: { label: "Afternoon", start: "13:00", end: "17:00" },
      AM: { label: "Morning", start: "09:00", end: "13:00" },
    };
    expect(parseSlotDefinitions(legacy)).toEqual([...DEFAULT_SLOT_DEFINITIONS]);
  });

  it("orders by start time whatever order it is given", () => {
    const scrambled = [
      { key: "PM", label: "Afternoon", start: "13:00", end: "17:00" },
      { key: "AM", label: "Morning", start: "09:00", end: "13:00" },
    ];
    expect(slotDefinitionsSchema.parse(scrambled).map((d) => d.key)).toEqual(["AM", "PM"]);
  });

  it("refuses overlapping slots", () => {
    // Two slots covering the same hour would let one person hold two desks for
    // the same real time while BOTH partial unique indexes stayed happy,
    // because the slot keys differ. There is no database rule that catches
    // this, so the vocabulary has to.
    expect(() =>
      slotDefinitionsSchema.parse([
        { key: "A", label: "A", start: "09:00", end: "13:00" },
        { key: "B", label: "B", start: "12:00", end: "17:00" },
      ]),
    ).toThrow(/overlap/i);
  });

  it("refuses a slot that ends before it starts, a duplicate key, and a bad time", () => {
    expect(() =>
      slotDefinitionsSchema.parse([{ key: "A", label: "A", start: "13:00", end: "09:00" }]),
    ).toThrow(/ends at or before/i);
    expect(() =>
      slotDefinitionsSchema.parse([
        { key: "A", label: "A", start: "09:00", end: "10:00" },
        { key: "A", label: "A2", start: "10:00", end: "11:00" },
      ]),
    ).toThrow(/duplicate/i);
    expect(() =>
      slotDefinitionsSchema.parse([{ key: "A", label: "A", start: "9am", end: "10:00" }]),
    ).toThrow();
  });

  it("builds hourly slots that abut without gaps or overlaps", () => {
    const hourly = hourlySlotDefinitions(9, 12);
    expect(hourly).toEqual([
      { key: "H09", label: "09:00", start: "09:00", end: "10:00" },
      { key: "H10", label: "10:00", start: "10:00", end: "11:00" },
      { key: "H11", label: "11:00", start: "11:00", end: "12:00" },
    ]);
    // And the vocabulary validator accepts them, which is the real assertion:
    // the hourly configuration is a legal one, not a special case.
    expect(slotDefinitionsSchema.parse(hourly)).toHaveLength(3);
  });

  it("reads HH:mm in exactly one place", () => {
    expect(minutesOfDay("00:00")).toBe(0);
    expect(minutesOfDay("13:30")).toBe(810);
    expect(() => minutesOfDay("24:00")).toThrow();
  });
});

describe("deriveSlotBounds", () => {
  it("converts Asia/Kolkata wall time to UTC", () => {
    // IST is UTC+5:30 and has no DST, so 09:00 local is 03:30Z exactly.
    const { startsAt, endsAt } = deriveSlotBounds("2026-09-03", "AM");
    expect(startsAt.toISOString()).toBe("2026-09-03T03:30:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-09-03T07:30:00.000Z");
  });

  it("gives PM a start that abuts the AM end", () => {
    const am = deriveSlotBounds("2026-09-03", "AM");
    const pm = deriveSlotBounds("2026-09-03", "PM");
    expect(pm.startsAt.toISOString()).toBe(am.endsAt.toISOString());
  });

  it("always produces a positive-length range", () => {
    for (const date of ["2026-01-01", "2026-06-15", "2026-12-31"]) {
      for (const slot of ["AM", "PM"]) {
        const { startsAt, endsAt } = deriveSlotBounds(date, slot);
        expect(endsAt.getTime()).toBeGreaterThan(startsAt.getTime());
      }
    }
  });

  it("works on a slot key that did not exist when it was written", () => {
    const { startsAt } = deriveSlotBounds("2026-09-03", "H14", hourlySlotDefinitions());
    expect(startsAt.toISOString()).toBe("2026-09-03T08:30:00.000Z");
  });

  it("names the slots it does know when given one it does not", () => {
    expect(() => deriveSlotBounds("2026-09-03", "EVENING")).toThrow(/Known slots: AM, PM/);
  });
});

/* ------------------------------------------------------------- the cut-off */

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  id: "s",
  timezone: "Asia/Kolkata",
  bookingWindowDays: 14,
  bookingWindowWorkingDays: 5,
  cutoffMinutes: 60,
  autoReleaseMinutes: 120,
  checkInOpensMinutesBefore: 30,
  slotDefinitions: [...DEFAULT_SLOT_DEFINITIONS],
  officeHours: { start: "08:00", end: "20:00" },
  demoOffsetSeconds: 0,
  autoReleaseBatchCap: 250,
  autoReleaseHorizonDays: 3,
  ...over,
});

describe("the cut-off", () => {
  const startsAt = new Date("2026-09-08T03:30:00Z"); // 09:00 IST

  it("closes exactly cutoffMinutes before the slot starts", () => {
    expect(cutoffInstant(startsAt, 60).toISOString()).toBe("2026-09-08T02:30:00.000Z");
    expect(isPastCutoff(new Date("2026-09-08T02:29:59Z"), startsAt, 60)).toBe(false);
    // Inclusive: standing exactly on the cut-off is past it.
    expect(isPastCutoff(new Date("2026-09-08T02:30:00Z"), startsAt, 60)).toBe(true);
  });

  it("says when the cut-off was, not just that it passed", () => {
    // "Too late" on its own generates a support request. The cut-off is a
    // settings value nobody has memorised.
    try {
      assertBeforeCutoff(new Date("2026-09-08T03:00:00Z"), startsAt, 60, "Asia/Kolkata");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BookingError);
      const e = err as BookingError;
      expect(e.code).toBe("PAST_CUTOFF");
      expect(e.message).toBe(
        "Changes closed at 08:00 on Tuesday 8 September — 60 minutes before the 09:00 start.",
      );
    }
  });

  it("honours a cut-off of zero", () => {
    expect(isPastCutoff(new Date("2026-09-08T03:29:59Z"), startsAt, 0)).toBe(false);
    expect(isPastCutoff(new Date("2026-09-08T03:30:00Z"), startsAt, 0)).toBe(true);
  });
});

describe("requireSlot", () => {
  it("names the available slots when given an unknown one", () => {
    expect(() => requireSlot(settings(), "EVENING")).toThrow(/Available: AM, PM/);
  });
});

/* -------------------------------------------------------------- room ranges */

describe("room booking validation — EDGE CASE 15", () => {
  const schema = roomBookingSchema({ start: "08:00", end: "20:00" });
  const base = {
    roomId: "3f7c1b52-4a2d-4f5e-9a1b-2c3d4e5f6a7b",
    title: "Audit planning",
    date: "2026-09-08",
  };

  it("accepts an ordinary meeting inside office hours", () => {
    expect(schema.safeParse({ ...base, startHour: 10, endHour: 11 }).success).toBe(true);
  });

  it("refuses a zero-length range", () => {
    // The load-bearing case. An EMPTY tstzrange overlaps nothing by definition,
    // so a zero-length booking slips straight past no_room_overlap and becomes
    // a legal way to hold a room twice (ADR-004).
    const result = schema.safeParse({ ...base, startHour: 10, endHour: 10 });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/at least an hour/i);
  });

  it("refuses a range that ends before it starts", () => {
    const result = schema.safeParse({ ...base, startHour: 12, endHour: 10 });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/ends before it starts/i);
  });

  it("refuses a range that starts before the office opens", () => {
    const result = schema.safeParse({ ...base, startHour: 6, endHour: 9 });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/between 08:00 and 20:00/);
  });

  it("refuses a range that ends after the office closes", () => {
    expect(schema.safeParse({ ...base, startHour: 19, endHour: 22 }).success).toBe(false);
  });

  it("refuses a meeting with no name", () => {
    const result = schema.safeParse({ ...base, title: "   ", startHour: 10, endHour: 11 });
    expect(result.success).toBe(false);
  });

  it("draws its hour columns from the same settings value", () => {
    expect(officeHourColumns({ start: "08:00", end: "20:00" })).toHaveLength(12);
    expect(officeHourColumns({ start: "09:00", end: "18:00" })[0]).toBe(9);
  });
});

/* ----------------------------------------------------------- authorisation */

const person = (over: Partial<User>): User =>
  ({
    id: "u1",
    email: "a@cbva.in",
    displayName: "A Person",
    grade: "article",
    team: "Audit",
    seatMode: "bookable",
    fixedSeatId: null,
    isAdmin: false,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  }) as User;

describe("who may book for whom — ASSUMPTIONS A7", () => {
  // CBVA asked for booking on somebody's behalf to be removed (Oct 2026).
  it("refuses booking for somebody else, for every grade — admins included", () => {
    const occupant = person({ id: "o", grade: "article" });
    for (const actor of [
      person({ id: "a", grade: "article" }),
      person({ id: "am", grade: "assistant_manager" }),
      person({ id: "m", grade: "manager", seatMode: "fixed" }),
      person({ id: "d", grade: "director", seatMode: "fixed" }),
      person({ id: "p", grade: "partner", seatMode: "fixed" }),
      person({ id: "s", grade: "admin_staff", seatMode: "fixed", isAdmin: true }),
    ]) {
      expect(() => assertMayBookFor(actor, occupant), actor.grade).toThrow(
        /only be booked for yourself/,
      );
    }
  });

  it("refuses an occupant id that isn't the caller, before looking anybody up", () => {
    const me = person({ id: "me" });
    expect(() => assertBookingForSelf(me, "someone-else")).toThrow(/only be booked for yourself/);
    expect(() => assertBookingForSelf(me, "me")).not.toThrow();
    expect(() => assertBookingForSelf(me, undefined)).not.toThrow();
  });

  it("stops a partner consuming a hot desk", () => {
    // Not a permission slip-up but a capacity error: they already hold a desk,
    // so the floor is now short by one and every occupancy number is wrong.
    const partner = person({ id: "p", grade: "partner", seatMode: "fixed" });
    expect(() => assertMayBookFor(partner, partner)).toThrow(/allocated desk/);
  });

  it("stops a deactivated account booking a desk", () => {
    const gone = person({ id: "g", isActive: false });
    expect(() => assertMayBookFor(gone, gone)).toThrow(/no longer active/);
  });

  it("refuses a desk that is not bookable, saying which kind of not", () => {
    const seat = (status: string) => ({ seatCode: "C3-04", status }) as Seat;
    expect(() => assertSeatBookable(seat("fixed"))).toThrow(/allocated to somebody/);
    expect(() => assertSeatBookable(seat("blocked"))).toThrow(/out of service/);
    expect(() => assertSeatBookable(seat("decommissioned"))).toThrow(/no longer a desk/);
    expect(() => assertSeatBookable(undefined)).toThrow(/not on the floor plan/);
  });
});

/* ------------------------------------------------------- the error mapping */

describe("mapPgError", () => {
  it("turns each integrity violation into an outcome a person can act on", () => {
    expect(mapPgError({ code: "23505", constraint: "seat_slot_unique" })?.code).toBe("SEAT_TAKEN");
    expect(mapPgError({ code: "23505", constraint: "occupant_slot_unique" })?.code).toBe(
      "OCCUPANT_ALREADY_BOOKED",
    );
    expect(mapPgError({ code: "23P01", constraint: "no_room_overlap" })?.code).toBe("ROOM_OVERLAP");
    expect(mapPgError({ code: "23514" })?.code).toBe("INVALID_RANGE");
  });

  it("digs the driver error out of the wrapper drizzle throws", () => {
    // Drizzle raises a DrizzleQueryError carrying the pg error on `.cause`.
    // Reading only the top level finds no SQLSTATE, which turns "somebody just
    // took that desk" into an unhandled 500 — a failure that appears ONLY under
    // the exact concurrency the constraint exists for.
    const wrapped = Object.assign(new Error("Failed query: insert into bookings"), {
      cause: Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint: "seat_slot_unique",
      }),
    });
    expect(mapPgError(wrapped)?.code).toBe("SEAT_TAKEN");
  });

  it("leaves anything it does not recognise alone, so bugs stay bugs", () => {
    expect(mapPgError(new TypeError("undefined is not a function"))).toBeNull();
    expect(mapPgError({ code: "42601" })).toBeNull();
    expect(mapPgError(null)).toBeNull();
  });
});
