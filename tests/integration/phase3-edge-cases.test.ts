/**
 * THE EIGHTEEN CASES. The brief calls this list the spec, so the `it()` blocks
 * are numbered to match it and nothing else lives in this file.
 *
 * These run against the DIRECT endpoint through the real service functions, not
 * through HTTP: every one of them is about timing or concurrency, and neither is
 * controllable from the other side of a request. The services take their
 * database handle, their Clock and their actor as arguments precisely so this
 * file can supply all three.
 *
 * Isolation follows Phase 1: a private floor, a random tag, and dates in 2099
 * the seed never touches, so the suite is safe against a working demo database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { eq, inArray, sql } from "drizzle-orm";

import type { CalendarSync, MailProvider } from "@/lib/adapters/types";
import { changeSeatStatus, setUserActive } from "@/lib/admin/seat-lifecycle";
import { runAutoRelease } from "@/lib/booking/auto-release";
import { BookingError } from "@/lib/booking/errors";
import {
  cancelBooking,
  checkInBooking,
  createBooking,
  editBooking,
} from "@/lib/booking/service";
import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { RoomBooking, User } from "@/lib/db/schema";
import { dispatchNotifications } from "@/lib/notifications/outbox";
import { cancelRoomBooking, createRoomBooking, retryCalendarSync } from "@/lib/rooms/service";
import { getSettings } from "@/lib/settings";

import {
  bookingById,
  clearBookings,
  createPhase3Fixtures,
  destroyPhase3Fixtures,
  FixedClock,
  HOUR,
  messagesFor,
  MINUTE,
  MONDAY,
  restoreSettings,
  snapshotSettings,
  testDb,
  testPool,
  TUESDAY,
  type Phase3Fixtures,
  type SettingsSnapshot,
} from "../phase3-helpers";

/**
 * Monday 5 January 2099, 07:00 in Asia/Kolkata.
 *
 * Before the AM slot (09:00–13:00 IST = 03:30–07:30 UTC) and before its cut-off
 * at 08:00 IST, so a booking made at this instant is fully editable.
 */
const MONDAY_0700_IST = new Date("2099-01-05T01:30:00Z");
const MONDAY_AM_START = new Date("2099-01-05T03:30:00Z");
const MONDAY_AM_END = new Date("2099-01-05T07:30:00Z");

let pool: Pool;
let db: Db;
let f: Phase3Fixtures;
let settingsSnap: SettingsSnapshot;

function ctx(actor: User, clock: FixedClock) {
  return { db, clock, actor };
}

function freshClock(at: Date = MONDAY_0700_IST): FixedClock {
  return new FixedClock(at);
}

/** Fails the test if the promise resolves; returns the BookingError if it does not. */
async function expectBookingError(
  promise: Promise<unknown>,
  code: string,
): Promise<BookingError> {
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
  // settings is a singleton shared with the dev server and every other spec.
  settingsSnap = await snapshotSettings(db);
  f = await createPhase3Fixtures(db);
});

afterAll(async () => {
  await destroyPhase3Fixtures(db, f);
  await restoreSettings(db, settingsSnap);
  await pool.end();
});

afterEach(async () => {
  await clearBookings(db, f);
});

/**
 * The desks this file owns.
 *
 * Handed to `runAutoRelease` so a clock set in 2099 settles only these rows.
 * The job is global by design — from a 2099 clock every real booking in the
 * seeded database finished decades ago, so an unscoped run would mark the whole
 * demo as a no-show. It did exactly that once, which is why this exists.
 */
function seatIds(): string[] {
  return [f.seatA.id, f.seatB.id];
}

/* ========================================================================= */

describe("1 — two people book the same desk at the same moment", () => {
  /**
   * The case ADR-003 put the partial unique index in the database for. Both
   * inserts are in flight before either commits; the loser must get a sentence
   * a person can act on, not a 500, and exactly one live booking must survive.
   *
   * Two different occupants deliberately, so the only rule that can fire is
   * seat_slot_unique — with the same person, occupant_slot_unique would reject
   * the second write first and prove nothing about the desk.
   */
  it("lets exactly one win, and tells the other what happened", async () => {
    const clock = freshClock();
    const attempt = (actor: User) =>
      createBooking(ctx(actor, clock), {
        seatCode: f.seatA.code,
        bookingDate: MONDAY,
        slot: "AM",
      });

    const [a, b] = await Promise.allSettled([attempt(f.article), attempt(f.colleague)]);

    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(BookingError);
    expect((err as BookingError).code).toBe("SEAT_TAKEN");
    // The message has to be usable in a dialog, not a constraint name.
    expect((err as BookingError).message).toMatch(/booked that desk/i);

    const live = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.bookings)
      .where(
        sql`${schema.bookings.seatId} = ${f.seatA.id}
            and ${schema.bookings.bookingDate} = ${MONDAY}
            and ${schema.bookings.slot} = 'AM'
            and ${schema.bookings.status} in ('confirmed','checked_in')`,
      );
    expect(live[0]!.n, "exactly one live booking survives").toBe(1);
  });
});

describe("2 — auto-release runs twice on the same booking", () => {
  it("is a no-op the second time, and does not notify twice", async () => {
    const clock = freshClock();
    const booked = await createBooking(ctx(f.article, clock), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "AM",
    });

    // Grace window is 120 minutes; step one minute past it, still inside the slot.
    clock.set(new Date(MONDAY_AM_START.getTime() + 121 * MINUTE));

    const first = await runAutoRelease({ db, clock, onlySeatIds: seatIds() });
    expect(first.released).toBe(1);

    const afterFirst = await bookingById(db, booked.booking.id);
    expect(afterFirst!.status).toBe("auto_released");

    const second = await runAutoRelease({ db, clock, onlySeatIds: seatIds() });
    expect(second.released, "the second run has nothing left to do").toBe(0);
    expect(second.markedNoShow).toBe(0);

    const afterSecond = await bookingById(db, booked.booking.id);
    expect(afterSecond!.status).toBe("auto_released");
    expect(
      afterSecond!.releasedAt?.toISOString(),
      "the release instant is not rewritten by a re-run",
    ).toBe(afterFirst!.releasedAt?.toISOString());

    const messages = await messagesFor(db, f, "auto_released");
    expect(messages, "one release, one email").toHaveLength(1);
  });
});

describe("2b — the nudge before the release", () => {
  /**
   * Not one of the eighteen, but the reason `reminder` exists as a kind.
   *
   * Taking a desk from somebody who simply forgot to scan lands in the
   * analytics as a no-show, which is supposed to mean "did not come in". One
   * message halfway through the grace window turns some of those back into real
   * check-ins — which is the difference between measuring occupancy and
   * measuring intent.
   */
  it("goes out once, halfway through the grace window, and not again", async () => {
    const clock = freshClock();
    await createBooking(ctx(f.article, clock), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "AM",
    });

    // Too early: nothing yet.
    clock.set(new Date(MONDAY_AM_START.getTime() + 30 * MINUTE));
    expect((await runAutoRelease({ db, clock, onlySeatIds: seatIds() })).remindersQueued).toBe(0);
    expect(await messagesFor(db, f, "reminder")).toHaveLength(0);

    // Halfway through the 120-minute window.
    clock.set(new Date(MONDAY_AM_START.getTime() + 65 * MINUTE));
    expect((await runAutoRelease({ db, clock, onlySeatIds: seatIds() })).remindersQueued).toBe(1);
    expect(await messagesFor(db, f, "reminder")).toHaveLength(1);

    // The job runs every sixty seconds. It must not send sixty reminders.
    clock.set(new Date(MONDAY_AM_START.getTime() + 90 * MINUTE));
    await runAutoRelease({ db, clock, onlySeatIds: seatIds() });
    await runAutoRelease({ db, clock, onlySeatIds: seatIds() });
    expect(
      await messagesFor(db, f, "reminder"),
      "the partial unique index makes this once-only",
    ).toHaveLength(1);

    // And past the window the release takes over, with no further nudging.
    clock.set(new Date(MONDAY_AM_START.getTime() + 121 * MINUTE));
    const released = await runAutoRelease({ db, clock, onlySeatIds: seatIds() });
    expect(released.released).toBe(1);
    expect(released.remindersQueued).toBe(0);
  });
});

describe("3 — auto-release runs on a booking whose slot already ended", () => {
  it("settles it as completed_no_show rather than releasing a slot that is over", async () => {
    const clock = freshClock();
    const booked = await createBooking(ctx(f.article, clock), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "AM",
    });

    clock.set(new Date(MONDAY_AM_END.getTime() + MINUTE));

    const result = await runAutoRelease({ db, clock, onlySeatIds: seatIds() });
    expect(result.released, "there is no remaining time to give anybody").toBe(0);
    expect(result.markedNoShow).toBe(1);

    const row = await bookingById(db, booked.booking.id);
    expect(row!.status).toBe("completed_no_show");
    expect(row!.releasedAt).not.toBeNull();
    // Nothing was "released", so nobody is told a desk came free.
    expect(await messagesFor(db, f, "auto_released")).toHaveLength(0);
  });
});

describe("4 — auto-release must not touch a checked-in or cancelled booking", () => {
  it("leaves both exactly as they were", async () => {
    const clock = freshClock();

    const checkedIn = await createBooking(ctx(f.article, clock), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "AM",
    });
    const cancelled = await createBooking(ctx(f.colleague, clock), {
      seatCode: f.seatB.code,
      bookingDate: MONDAY,
      slot: "AM",
    });

    clock.set(new Date(MONDAY_AM_START.getTime() + 10 * MINUTE));
    await checkInBooking(ctx(f.article, clock), {
      bookingId: checkedIn.booking.id,
      method: "qr",
    });
    await cancelBooking(ctx(f.colleague, clock), {
      bookingId: cancelled.booking.id,
      force: true,
    });

    // Well past the grace window, but still inside the slot.
    clock.set(new Date(MONDAY_AM_START.getTime() + 150 * MINUTE));
    const result = await runAutoRelease({ db, clock, onlySeatIds: seatIds() });

    expect(result.released).toBe(0);
    expect((await bookingById(db, checkedIn.booking.id))!.status).toBe("checked_in");
    expect((await bookingById(db, cancelled.booking.id))!.status).toBe("cancelled_by_user");
  });
});

describe("5 — cancelling after checking in", () => {
  /**
   * Allowed, and counted separately.
   *
   * Note what this case forces: check-in only happens after a slot has started,
   * so it is always after the cut-off. The cut-off therefore cannot apply to a
   * booking somebody has already checked into — and it should not, because
   * releasing a desk you are leaving gives the rest of the slot back to the
   * floor, which is the behaviour the product wants.
   */
  it("records cancelled_after_check_in and keeps the check-in timestamp", async () => {
    const clock = freshClock();
    const booked = await createBooking(ctx(f.article, clock), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "AM",
    });

    clock.set(new Date(MONDAY_AM_START.getTime() + 15 * MINUTE));
    await checkInBooking(ctx(f.article, clock), { bookingId: booked.booking.id, method: "qr" });

    clock.set(new Date(MONDAY_AM_START.getTime() + 90 * MINUTE));
    const cancelledRow = await cancelBooking(ctx(f.article, clock), {
      bookingId: booked.booking.id,
    });

    expect(cancelledRow.status).toBe("cancelled_after_check_in");
    expect(
      cancelledRow.checkedInAt,
      "the fact that they turned up survives the cancellation",
    ).not.toBeNull();
    expect(cancelledRow.checkInMethod).toBe("qr");

    // The analytics separation, stated as the query analytics will actually run.
    const counts = await db
      .select({ status: schema.bookings.status, n: sql<number>`count(*)::int` })
      .from(schema.bookings)
      .where(inArray(schema.bookings.seatId, [f.seatA.id, f.seatB.id]))
      .groupBy(schema.bookings.status);
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
    expect(byStatus.cancelled_after_check_in).toBe(1);
    expect(byStatus.cancelled_by_user ?? 0).toBe(0);
  });
});

describe("6 — the cut-off passes while the edit dialog is open", () => {
  it("rejects on submit and says when the cut-off was", async () => {
    const clock = freshClock();
    const booked = await createBooking(ctx(f.article, clock), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "AM",
    });
    // What the client read when it opened the dialog.
    const readUpdatedAt = booked.booking.updatedAt.toISOString();

    // The user thinks about it. The AM cut-off (08:00 IST) goes past.
    clock.set(new Date("2099-01-05T03:00:00Z")); // 08:30 IST

    const err = await expectBookingError(
      editBooking(ctx(f.article, clock), {
        bookingId: booked.booking.id,
        expectedUpdatedAt: readUpdatedAt,
        seatCode: f.seatB.code,
        bookingDate: MONDAY,
        slot: "AM",
      }),
      "PAST_CUTOFF",
    );

    // "Too late" on its own generates a support request. The instant is named.
    expect(err.message).toMatch(/Changes closed at 08:00/);
    expect(err.message).toMatch(/60 minutes before/);
    expect((err.details as { cutoffMinutes: number }).cutoffMinutes).toBe(60);

    // And nothing moved.
    const row = await bookingById(db, booked.booking.id);
    expect(row!.status).toBe("confirmed");
    expect(row!.seatId).toBe(f.seatA.id);
  });
});

describe("7 — a desk is blocked while future bookings exist", () => {
  it("refuses by default and lists who is affected", async () => {
    const clock = freshClock();
    await createBooking(ctx(f.article, clock), {
      seatCode: f.seatA.code,
      bookingDate: TUESDAY,
      slot: "AM",
    });

    const err = await expectBookingError(
      changeSeatStatus(ctx(f.admin, clock), f.seatA.code, "blocked"),
      "SEAT_HAS_FUTURE_BOOKINGS",
    );
    const affected = (err.details as { affected: Array<{ occupantName: string }> }).affected;
    expect(affected).toHaveLength(1);
    expect(affected[0]!.occupantName).toBe(f.article.displayName);

    const [seat] = await db
      .select()
      .from(schema.seats)
      .where(eq(schema.seats.id, f.seatA.id))
      .limit(1);
    expect(seat!.status, "the desk is untouched until somebody confirms").toBe("bookable");
  });

  it("force-cancels with a notification when the admin confirms", async () => {
    const clock = freshClock();
    const booked = await createBooking(ctx(f.article, clock), {
      seatCode: f.seatA.code,
      bookingDate: TUESDAY,
      slot: "AM",
    });

    const result = await changeSeatStatus(ctx(f.admin, clock), f.seatA.code, "blocked", {
      force: true,
    });
    expect(result.cancelledBookingIds).toEqual([booked.booking.id]);

    const row = await bookingById(db, booked.booking.id);
    // Not cancelled_by_user: the firm took the desk away, and analytics must
    // not read that as this person deciding not to come in.
    expect(row!.status).toBe("cancelled_by_admin");

    const told = await messagesFor(db, f, "booking_cancelled");
    expect(told.map((m) => m.recipientEmail)).toContain(f.article.email);
    expect(told[0]!.body).toMatch(/taken out of service/);

    // Put the desk back for the following cases.
    await db
      .update(schema.seats)
      .set({ status: "bookable" })
      .where(eq(schema.seats.id, f.seatA.id));
  });
});

describe("8 — a desk is decommissioned while future bookings exist", () => {
  it("gets the same treatment as blocking", async () => {
    const clock = freshClock();
    const booked = await createBooking(ctx(f.article, clock), {
      seatCode: f.seatA.code,
      bookingDate: TUESDAY,
      slot: "PM",
    });

    await expectBookingError(
      changeSeatStatus(ctx(f.admin, clock), f.seatA.code, "decommissioned"),
      "SEAT_HAS_FUTURE_BOOKINGS",
    );

    await changeSeatStatus(ctx(f.admin, clock), f.seatA.code, "decommissioned", { force: true });
    expect((await bookingById(db, booked.booking.id))!.status).toBe("cancelled_by_admin");

    const told = await messagesFor(db, f, "booking_cancelled");
    expect(told[0]!.body).toMatch(/taken out of the floor plan/);

    await db
      .update(schema.seats)
      .set({ status: "bookable" })
      .where(eq(schema.seats.id, f.seatA.id));
  });
});

describe("9 — one person books two different desks in the same slot", () => {
  it("refuses the second and hands back the booking in the way; somebody else can still take the desk", async () => {
    const clock = freshClock();
    await createBooking(ctx(f.article, clock), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "AM",
    });

    const err = await expectBookingError(
      createBooking(ctx(f.article, clock), {
        seatCode: f.seatB.code,
        bookingDate: MONDAY,
        slot: "AM",
      }),
      "OCCUPANT_ALREADY_BOOKED",
    );
    // "Conflict" is not actionable; the desk they already have is.
    const existing = (err.details as { existing: { seatCode: string } | null }).existing;
    expect(existing?.seatCode).toBe(f.seatA.code);
    expect(err.message).toContain(f.seatA.code);

    // occupant_slot_unique is keyed on the occupant, so a different person
    // booking the other desk is simply a different key.
    const colleague = await createBooking(ctx(f.colleague, clock), {
      seatCode: f.seatB.code,
      bookingDate: MONDAY,
      slot: "AM",
    });
    expect(colleague.booking.status).toBe("confirmed");
    expect(colleague.booking.source).toBe("self");
  });
});

/**
 * The brief's case 10 was "booking on behalf of somebody who already has a
 * desk". CBVA asked for booking on behalf to be removed altogether (Oct 2026),
 * so the case is now: it is refused for everybody, before anyone is looked up.
 */
describe("10 — booking on behalf of somebody else", () => {
  it("is refused for every grade, admins included, and books nothing", async () => {
    const clock = freshClock();
    for (const actor of [f.manager, f.admin]) {
      await expectBookingError(
        createBooking(ctx(actor, clock), {
          seatCode: f.seatB.code,
          bookingDate: MONDAY,
          slot: "PM",
          occupantUserId: f.colleague.id,
        }),
        "NOT_PERMITTED_ON_BEHALF",
      );
    }

    const live = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.bookings)
      .where(
        sql`${schema.bookings.occupantUserId} = ${f.colleague.id}
            and ${schema.bookings.bookingDate} = ${MONDAY}`,
      );
    expect(live[0]!.n).toBe(0);
  });
});

describe("11 — the booking window", () => {
  /**
   * The calendar arithmetic — five working days across a weekend and Ganesh
   * Chaturthi — is proven in tests/unit/booking-days.test.ts, where it can be
   * driven over many dates cheaply. What matters here is that the WRITE PATH
   * enforces the same list the date strip offers, rather than trusting it.
   */
  it("refuses a date the strip never offered", async () => {
    const clock = freshClock();
    const err = await expectBookingError(
      createBooking(ctx(f.article, clock), {
        seatCode: f.seatA.code,
        bookingDate: "2099-01-19", // a fortnight out, well past five working days
        slot: "AM",
      }),
      "DATE_OUTSIDE_WINDOW",
    );
    expect(err.message).toMatch(/next 5 working days/);
    expect((err.details as { offered: string[] }).offered).toEqual([
      "2099-01-05",
      "2099-01-06",
      "2099-01-07",
      "2099-01-08",
      "2099-01-09",
    ]);
  });

  it("refuses a Saturday even though it is inside the calendar bound", async () => {
    const clock = freshClock();
    await expectBookingError(
      createBooking(ctx(f.article, clock), {
        seatCode: f.seatA.code,
        bookingDate: "2099-01-10", // Saturday
        slot: "AM",
      }),
      "DATE_OUTSIDE_WINDOW",
    );
  });
});

describe("12 — a user is deactivated with future bookings", () => {
  it("cancels them and tells both the occupant and whoever booked it", async () => {
    const clock = freshClock();
    const own = await createBooking(ctx(f.colleague, clock), {
      seatCode: f.seatA.code,
      bookingDate: TUESDAY,
      slot: "AM",
    });
    // A historical on-behalf booking — none can be created any more, but the
    // ones made before the removal are kept, and their booker still has to be
    // told when they're cancelled.
    const legacy = await createBooking(ctx(f.colleague, clock), {
      seatCode: f.seatB.code,
      bookingDate: TUESDAY,
      slot: "PM",
    });
    await db
      .update(schema.bookings)
      .set({ bookedByUserId: f.manager.id, source: "on_behalf" })
      .where(eq(schema.bookings.id, legacy.booking.id));

    const result = await setUserActive(ctx(f.admin, clock), f.colleague.id, false);
    expect([...result.cancelledBookingIds].sort()).toEqual(
      [own.booking.id, legacy.booking.id].sort(),
    );

    for (const id of [own.booking.id, legacy.booking.id]) {
      const row = await bookingById(db, id);
      expect(row!.status).toBe("cancelled_by_admin");
    }

    const told = await messagesFor(db, f, "booking_cancelled");
    const recipients = told.map((m) => m.recipientEmail);
    expect(recipients).toContain(f.colleague.email);
    expect(recipients, "the manager who booked it needs to know too").toContain(f.manager.email);

    await db
      .update(schema.users)
      .set({ isActive: true })
      .where(eq(schema.users.id, f.colleague.id));
  });
});

describe("13 — two people edit the same booking at once", () => {
  it("lets one through and gives the other a conflict, not a silent overwrite", async () => {
    const clock = freshClock();
    const booked = await createBooking(ctx(f.article, clock), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "AM",
    });
    // Both clients read the same version.
    //
    // Note the clock is frozen, so both edits will stamp the SAME updated_at —
    // which is exactly the situation a timestamp lock cannot see. That is
    // deliberate: it forces the conditional UPDATE inside the transaction to be
    // the thing that arbitrates, which is what has to hold under real
    // concurrency too.
    const stale = booked.booking.updatedAt.toISOString();

    const edit = (seatCode: string) =>
      editBooking(ctx(f.article, clock), {
        bookingId: booked.booking.id,
        expectedUpdatedAt: stale,
        seatCode,
        bookingDate: MONDAY,
        slot: "AM",
      });

    const [a, b] = await Promise.allSettled([edit(f.seatB.code), edit(f.seatA.code)]);

    expect([a, b].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BookingError);
    expect((rejected.reason as BookingError).code).toBe("BOOKING_CONFLICT");
    expect((rejected.reason as BookingError).message).toMatch(/changed or cancelled while you had it open/i);

    // One live booking for this person in this slot, not two.
    const live = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.bookings)
      .where(
        sql`${schema.bookings.occupantUserId} = ${f.article.id}
            and ${schema.bookings.bookingDate} = ${MONDAY}
            and ${schema.bookings.status} in ('confirmed','checked_in')`,
      );
    expect(live[0]!.n).toBe(1);
  });
});

describe("14 — a meeting that starts exactly when another ends", () => {
  /**
   * The '[)' bound in the exclusion constraint. Half-open is what makes an
   * ordinary back-to-back meeting legal; with '[]' every consecutive booking in
   * the building would be refused, which is the kind of bug that is obvious in
   * a boundary test and invisible in a demo.
   */
  it("is allowed, and a genuine overlap is still refused", async () => {
    const clock = freshClock();
    const c = { ...ctx(f.manager, clock), calendar: workingCalendar() };

    const first = await createRoomBooking(c, {
      roomId: f.roomId,
      title: "Audit planning",
      date: MONDAY,
      startHour: 10,
      endHour: 11,
    });
    expect(first.booking.status).toBe("confirmed");

    // Starts at the exact instant the first ends.
    const second = await createRoomBooking(c, {
      roomId: f.roomId,
      title: "Tax review",
      date: MONDAY,
      startHour: 11,
      endHour: 12,
    });
    expect(second.booking.startsAt.toISOString()).toBe(first.booking.endsAt.toISOString());

    // And an hour that genuinely collides is still refused, with a message
    // about the room rather than a constraint name.
    const err = await expectBookingError(
      createRoomBooking(c, {
        roomId: f.roomId,
        title: "Clashing",
        date: MONDAY,
        startHour: 10,
        endHour: 12,
      }),
      "ROOM_OVERLAP",
    );
    expect(err.message).toMatch(/booked for part of this time/i);

    await cancelRoomBooking(c, first.booking.id);
    await cancelRoomBooking(c, second.booking.id);
  });
});

describe("15 — a room range that is not a range", () => {
  /**
   * Refused at the Zod layer, which is one layer earlier than the database
   * CHECK from ADR-004. The zero-length case is the load-bearing one: an EMPTY
   * tstzrange overlaps nothing by definition, so without this a zero-length
   * booking sails past no_room_overlap and becomes a legal way to hold a room
   * twice.
   *
   * The pure-schema cases are also asserted in tests/unit/room-validation.test.ts;
   * this proves the service actually applies them.
   */
  it("refuses zero length, inverted, and outside office hours", async () => {
    const clock = freshClock();
    const c = { ...ctx(f.manager, clock), calendar: workingCalendar() };
    const base = { roomId: f.roomId, title: "Nope", date: MONDAY };

    const zero = await expectBookingError(
      createRoomBooking(c, { ...base, startHour: 10, endHour: 10 }),
      "OUTSIDE_OFFICE_HOURS",
    );
    expect(zero.message).toMatch(/at least an hour/i);

    const inverted = await expectBookingError(
      createRoomBooking(c, { ...base, startHour: 12, endHour: 10 }),
      "OUTSIDE_OFFICE_HOURS",
    );
    expect(inverted.message).toMatch(/ends before it starts/i);

    const early = await expectBookingError(
      createRoomBooking(c, { ...base, startHour: 6, endHour: 8 }),
      "OUTSIDE_OFFICE_HOURS",
    );
    expect(early.message).toMatch(/between 08:00 and 20:00/);

    await expectBookingError(
      createRoomBooking(c, { ...base, startHour: 19, endHour: 22 }),
      "OUTSIDE_OFFICE_HOURS",
    );
  });
});

describe("16 — the calendar is down", () => {
  it("keeps the booking, records the failure, and syncs on retry", async () => {
    const clock = freshClock();
    const failing = failingCalendar();

    const created = await createRoomBooking(
      { ...ctx(f.manager, clock), calendar: failing },
      { roomId: f.roomId, title: "Partners meeting", date: MONDAY, startHour: 14, endHour: 15 },
    );

    // THE RULE: a calendar failure must never lose a booking.
    expect(created.calendarSynced).toBe(false);
    expect(created.booking.status).toBe("confirmed");

    const [stored] = await db
      .select()
      .from(schema.roomBookings)
      .where(eq(schema.roomBookings.id, created.booking.id));
    expect(stored!.status).toBe("confirmed");
    expect(stored!.syncStatus).toBe("failed");
    expect(stored!.syncError).toMatch(/graph/i);
    expect(stored!.calendarEventId).toBeNull();

    const retry = await retryCalendarSync({ db, clock, calendar: workingCalendar() });
    expect(retry.synced).toBeGreaterThanOrEqual(1);

    const [after] = await db
      .select()
      .from(schema.roomBookings)
      .where(eq(schema.roomBookings.id, created.booking.id));
    expect(after!.syncStatus).toBe("synced");
    expect(after!.calendarEventId).toMatch(/^demo-evt-/);
    expect(after!.syncError).toBeNull();

    await cancelRoomBooking(
      { ...ctx(f.manager, clock), calendar: workingCalendar() },
      created.booking.id,
    );
  });
});

describe("17 — the mail server is down", () => {
  it("keeps the booking, counts the attempt, and sends on retry", async () => {
    const clock = freshClock();

    /**
     * Drain the outbox first, so the dispatch counts below are about THIS
     * message.
     *
     * dispatchNotifications is global by design — it is the real job, and the
     * job has no business knowing which test queued what. That was harmless
     * while bookings were the only thing that queued mail; Phase 5 added a
     * recurring-booking materialiser that emails a failure per unbookable
     * occurrence, and a suite run can leave dozens of those in the shared
     * database. `expect(failed.failed).toBe(1)` then reads 32 and the failure
     * looks like a mail bug rather than a housekeeping one.
     *
     * Draining rather than relaxing the assertion, because "exactly one message
     * failed" is the thing worth asserting.
     */
    await dispatchNotifications({ db, clock, mailer: workingMailer(), limit: 500 });

    const booked = await createBooking(ctx(f.article, clock), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "AM",
    });

    const queued = await messagesFor(db, f, "booking_confirmed");
    expect(queued, "the message is written inside the booking transaction").toHaveLength(1);
    expect(queued[0]!.status).toBe("queued");

    const failed = await dispatchNotifications({ db, clock, mailer: failingMailer() });
    expect(failed.sent).toBe(0);
    expect(failed.failed).toBe(1);

    // The booking is untouched. A delivery problem is a fact about the message.
    expect((await bookingById(db, booked.booking.id))!.status).toBe("confirmed");

    const afterFailure = (await messagesFor(db, f, "booking_confirmed"))[0]!;
    expect(afterFailure.status, "still queued, not abandoned").toBe("queued");
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.error).toMatch(/graph/i);
    expect(afterFailure.nextAttemptAt).not.toBeNull();

    // Backoff is respected: retrying immediately does nothing.
    const tooSoon = await dispatchNotifications({ db, clock, mailer: workingMailer() });
    expect(tooSoon.attempted).toBe(0);

    clock.advance(2 * HOUR);
    const retried = await dispatchNotifications({ db, clock, mailer: workingMailer() });
    expect(retried.sent).toBe(1);

    const delivered = (await messagesFor(db, f, "booking_confirmed"))[0]!;
    expect(delivered.status).toBe("sent");
    expect(delivered.attempts).toBe(2);
    expect(delivered.sentAt).not.toBeNull();
  });
});

describe("18 — the demo clock is wound backwards", () => {
  /**
   * Somebody advances the clock two hours to demonstrate auto-release, then
   * resets it. Nothing may un-happen: a released desk stays released, the
   * release instant stays where it was, and no second email goes out.
   */
  it("corrupts nothing, and the freed desk is still bookable", async () => {
    const clock = freshClock();
    const booked = await createBooking(ctx(f.article, clock), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "AM",
    });

    clock.set(new Date(MONDAY_AM_START.getTime() + 121 * MINUTE));
    expect((await runAutoRelease({ db, clock, onlySeatIds: seatIds() })).released).toBe(1);
    const released = await bookingById(db, booked.booking.id);

    // Wind back to before the slot even started.
    clock.set(new Date(MONDAY_AM_START.getTime() - 4 * HOUR));
    const rewound = await runAutoRelease({ db, clock, onlySeatIds: seatIds() });
    expect(rewound).toMatchObject({ released: 0, markedNoShow: 0, completed: 0 });

    const after = await bookingById(db, booked.booking.id);
    expect(after!.status, "a release does not un-happen").toBe("auto_released");
    expect(after!.releasedAt?.toISOString()).toBe(released!.releasedAt?.toISOString());
    expect(await messagesFor(db, f, "auto_released")).toHaveLength(1);

    // And the desk really is back in the pool: somebody else can take it.
    const rebooked = await createBooking(ctx(f.colleague, clock), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "AM",
    });
    expect(rebooked.booking.status).toBe("confirmed");
  });
});

/* ---------------------------------------------------------------- doubles */

/**
 * The adapters are injected rather than mocked at the module level, which is
 * why the services take them as arguments. A test that could not make Graph
 * fail could not prove that a Graph failure is survivable — and that is the
 * whole claim being made.
 */
function failingCalendar(): CalendarSync {
  return {
    async upsert(): Promise<string> {
      throw new Error("Graph /events returned 503 Service Unavailable");
    },
    async remove(): Promise<void> {
      throw new Error("Graph /events returned 503 Service Unavailable");
    },
  };
}

function workingCalendar(): CalendarSync {
  return {
    async upsert(b: RoomBooking): Promise<string> {
      return b.calendarEventId ?? `demo-evt-${b.id}`;
    },
    async remove(): Promise<void> {},
  };
}

function failingMailer(): MailProvider {
  return {
    async send(): Promise<void> {
      throw new Error("Graph sendMail returned 429 Too Many Requests");
    },
  };
}

function workingMailer(): MailProvider {
  return {
    async send(): Promise<void> {},
  };
}

/* Keeps getSettings honest: if the seeded configuration ever drifts, the
 * numbers these cases assume stop being true and this fails first. */
describe("the settings these cases assume", () => {
  it("are the seeded ones", async () => {
    const settings = await getSettings(db);
    expect(settings.cutoffMinutes).toBe(60);
    expect(settings.autoReleaseMinutes).toBe(120);
    expect(settings.bookingWindowWorkingDays).toBe(5);
    expect(settings.slotDefinitions.map((d) => d.key)).toEqual(["AM", "PM"]);
    expect(settings.slotDefinitions[0]).toMatchObject({ start: "09:00", end: "13:00" });
    expect(settings.officeHours).toEqual({ start: "08:00", end: "20:00" });
  });
});
