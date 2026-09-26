/**
 * PROVES two things added to meeting-room booking:
 *
 * 1. Rooms now refuse a weekend, a public holiday, and a start time already
 *    behind "now" — none of these were checked before, and a room could be
 *    booked for a Saturday, a holiday, or a slot that had already started.
 * 2. Attendees beyond the organiser: resolved against `users` where the email
 *    matches an active account, stored as a plain name and email otherwise,
 *    deduplicated, and never including the organiser's own address.
 *
 * Runs against the direct endpoint through the real service functions, same
 * isolation as phase3-edge-cases.test.ts: a private floor, a random tag,
 * dates in 2099 the seed never touches.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";

import { BookingError } from "@/lib/booking/errors";
import type { Db } from "@/lib/db";
import { schema } from "@/lib/db";
import type { User } from "@/lib/db/schema";
import { createRoomBooking, roomDay } from "@/lib/rooms/service";

import {
  clearBookings,
  createPhase3Fixtures,
  destroyPhase3Fixtures,
  FixedClock,
  MONDAY,
  TUESDAY,
  testDb,
  testPool,
  type Phase3Fixtures,
} from "../phase3-helpers";

/** Monday 5 January 2099, 07:00 IST — a normal weekday, well before any slot. */
const MONDAY_0700_IST = new Date("2099-01-05T01:30:00Z");

let pool: Pool;
let db: Db;
let f: Phase3Fixtures;

function ctx(actor: User, clock: FixedClock) {
  return { db, clock, actor };
}

async function expectBookingError(promise: Promise<unknown>, code: string): Promise<BookingError> {
  try {
    await promise;
  } catch (err) {
    expect(err, `expected a BookingError, got ${String(err)}`).toBeInstanceOf(BookingError);
    const e = err as BookingError;
    expect(e.code, `message was: ${e.message}`).toBe(code);
    return e;
  }
  throw new Error(`expected the call to fail with ${code}, but it succeeded`);
}

beforeAll(async () => {
  pool = testPool(10);
  db = testDb(pool);
  f = await createPhase3Fixtures(db);
});

afterAll(async () => {
  await destroyPhase3Fixtures(db, f);
  await pool.end();
});

afterEach(async () => {
  await clearBookings(db, f);
});

describe("meeting rooms refuse a weekend, a holiday, or the past", () => {
  it("refuses a Saturday", async () => {
    const c = ctx(f.manager, new FixedClock(MONDAY_0700_IST));
    const err = await expectBookingError(
      createRoomBooking(c, { roomId: f.roomId, title: "Weekend planning", date: "2099-01-10", startHour: 10, endHour: 11 }),
      "ROOM_DATE_NOT_BOOKABLE",
    );
    expect(err.message).toMatch(/weekend/i);
  });

  it("refuses a public holiday, even on a weekday", async () => {
    await db.insert(schema.holidays).values({ holidayDate: TUESDAY, name: "Test holiday" });
    try {
      const c = ctx(f.manager, new FixedClock(MONDAY_0700_IST));
      const err = await expectBookingError(
        createRoomBooking(c, { roomId: f.roomId, title: "Should not happen", date: TUESDAY, startHour: 10, endHour: 11 }),
        "ROOM_DATE_NOT_BOOKABLE",
      );
      expect(err.message).toMatch(/holiday/i);
    } finally {
      await db.delete(schema.holidays).where(eq(schema.holidays.holidayDate, TUESDAY));
    }
  });

  it("refuses a start time already behind now", async () => {
    // "now" is 10:00 IST on Monday; 09:00 IST the same day is within office
    // hours but has already begun — office hours pass, the date check catches it.
    const c = ctx(f.manager, new FixedClock(new Date("2099-01-05T04:30:00Z")));
    const err = await expectBookingError(
      createRoomBooking(c, { roomId: f.roomId, title: "Too late", date: MONDAY, startHour: 9, endHour: 10 }),
      "ROOM_DATE_NOT_BOOKABLE",
    );
    expect(err.message).toMatch(/already/i);
  });

  it("still accepts an ordinary future weekday with no holiday", async () => {
    const c = ctx(f.manager, new FixedClock(MONDAY_0700_IST));
    const result = await createRoomBooking(c, {
      roomId: f.roomId,
      title: "Ordinary meeting",
      date: MONDAY,
      startHour: 10,
      endHour: 11,
    });
    expect(result.booking.status).toBe("confirmed");
  });
});

describe("attendees beyond the organiser", () => {
  it("resolves a CBVA colleague's email and records somebody outside the firm by name only", async () => {
    const c = ctx(f.manager, new FixedClock(MONDAY_0700_IST));
    const result = await createRoomBooking(c, {
      roomId: f.roomId,
      title: "Client review",
      date: MONDAY,
      startHour: 10,
      endHour: 11,
      attendeeEmails: [f.article.email, "external.client@othercompany.example"],
    });

    expect(result.attendees).toHaveLength(2);
    const staff = result.attendees.find((a) => a.email === f.article.email.toLowerCase());
    expect(staff?.userId).toBe(f.article.id);
    expect(staff?.name).toBe(f.article.displayName);

    const outsider = result.attendees.find((a) => a.email === "external.client@othercompany.example");
    expect(outsider?.userId).toBeNull();
    expect(outsider?.name).toBe("External Client");
  });

  it("deduplicates case-insensitively and drops the organiser inviting themselves", async () => {
    const c = ctx(f.manager, new FixedClock(MONDAY_0700_IST));
    const result = await createRoomBooking(c, {
      roomId: f.roomId,
      title: "Dedup check",
      date: MONDAY,
      startHour: 10,
      endHour: 11,
      attendeeEmails: [
        f.article.email.toUpperCase(),
        f.article.email.toLowerCase(),
        f.manager.email, // the organiser themselves
      ],
    });
    expect(result.attendees).toHaveLength(1);
    expect(result.attendees[0]!.email).toBe(f.article.email.toLowerCase());
  });

  it("an ordinary booking with nobody invited has an empty attendee list, not an error", async () => {
    const c = ctx(f.manager, new FixedClock(MONDAY_0700_IST));
    const result = await createRoomBooking(c, {
      roomId: f.roomId,
      title: "Just me",
      date: MONDAY,
      startHour: 10,
      endHour: 11,
    });
    expect(result.attendees).toEqual([]);
  });

  it("roomDay() carries the same attendees back on the grid", async () => {
    const c = ctx(f.manager, new FixedClock(MONDAY_0700_IST));
    await createRoomBooking(c, {
      roomId: f.roomId,
      title: "Visible on the grid",
      date: MONDAY,
      startHour: 10,
      endHour: 11,
      attendeeEmails: [f.article.email],
    });

    const grid = await roomDay(db, MONDAY);
    const booking = grid.bookings.find((b) => b.roomId === f.roomId);
    expect(booking?.attendees).toEqual([
      { name: f.article.displayName, email: f.article.email.toLowerCase(), isStaff: true },
    ]);
  });
});

describe("roomDay() reports how many distinct people booked each room", () => {
  it("counts distinct organisers, not bookings — one person holding two slots is still 1", async () => {
    const c = ctx(f.manager, new FixedClock(MONDAY_0700_IST));
    await createRoomBooking(c, { roomId: f.roomId, title: "Slot one", date: MONDAY, startHour: 9, endHour: 10 });
    await createRoomBooking(c, { roomId: f.roomId, title: "Slot two", date: MONDAY, startHour: 10, endHour: 11 });

    const grid = await roomDay(db, MONDAY);
    const room = grid.rooms.find((r) => r.id === f.roomId);
    expect(room?.bookingCount).toBe(2);
    expect(room?.bookedByCount).toBe(1);
  });

  it("counts two different organisers as two people", async () => {
    const managerCtx = ctx(f.manager, new FixedClock(MONDAY_0700_IST));
    const adminCtx = ctx(f.admin, new FixedClock(MONDAY_0700_IST));
    await createRoomBooking(managerCtx, { roomId: f.roomId, title: "Manager's slot", date: MONDAY, startHour: 9, endHour: 10 });
    await createRoomBooking(adminCtx, { roomId: f.roomId, title: "Admin's slot", date: MONDAY, startHour: 10, endHour: 11 });

    const grid = await roomDay(db, MONDAY);
    const room = grid.rooms.find((r) => r.id === f.roomId);
    expect(room?.bookingCount).toBe(2);
    expect(room?.bookedByCount).toBe(2);
  });

  it("a room with no bookings that day reports zero for both", async () => {
    const grid = await roomDay(db, TUESDAY);
    const room = grid.rooms.find((r) => r.id === f.roomId);
    expect(room?.bookingCount).toBe(0);
    expect(room?.bookedByCount).toBe(0);
  });
});
