import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";

import {
  AM,
  FixedClock,
  clearBookings,
  createPhase3Fixtures,
  destroyPhase3Fixtures,
  testDb,
  testPool,
  type Phase3Fixtures,
} from "../phase3-helpers";
import { cancelSeries, createSeries, materialiseSeries } from "@/lib/booking/series";
import { cancelBooking, createBooking, editBooking } from "@/lib/booking/service";
import { runAutoRelease } from "@/lib/booking/auto-release";
import { schema, type Db } from "@/lib/db";
import { bookableDates } from "@/lib/booking-days";
import { getSettings } from "@/lib/settings";
import type { Pool } from "pg";

/** yyyy-MM-dd to an ISO weekday, 1 = Monday. Parsed as UTC so nothing shifts. */
function isoWeekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const js = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return js === 0 ? 7 : js;
}

/**
 * Recurring bookings.
 *
 * The design under test is the TOMBSTONE: `booking_series_occurrence_unique` is
 * deliberately not partial on status, so a cancelled occurrence still occupies
 * the key and the materialiser's ON CONFLICT DO NOTHING finds it. There is no
 * exceptions table, which means there is no second piece of state to drift out
 * of sync with the bookings themselves. If that index ever gains a `WHERE
 * status IN (...)` predicate, the resurrection test below fails.
 */
// Every test here is dominated by round-trip latency to a database in
// Singapore, not by computation. The suite default of 60s is tuned for the
// single-write Phase 3 cases.
describe("recurring bookings", { timeout: 180_000 }, () => {
  let pool: Pool;
  let db: Db;
  let f: Phase3Fixtures;
  let clock: FixedClock;
  let windowDates: string[];

  beforeAll(async () => {
    pool = testPool();
    db = testDb(pool);
    f = await createPhase3Fixtures(db);
    // The real clock, so the materialiser's window is the real window — the
    // whole point is that it books exactly the days a person can see.
    clock = new FixedClock(new Date());

    const settings = await getSettings(db);
    const holidays = await db.select({ d: schema.holidays.holidayDate }).from(schema.holidays);
    const allWindowDates = bookableDates({
      now: clock.now(),
      workingDays: settings.bookingWindowWorkingDays,
      calendarBound: settings.bookingWindowDays,
      holidays: new Set(holidays.map((h) => h.d)),
      timezone: settings.timezone,
    });
    // Drop TODAY. bookableDates() offers it regardless of the hour — booking
    // late is allowed — but createBooking() still refuses a slot that has
    // already finished (A21), and this suite runs at whatever real hour CI
    // happens to reach it. Every day past today is, by construction, a slot
    // that has not started yet, so dropping just today is enough: the same
    // real-wall-clock fix PHASE-7-HANDOFF applied to the sibling "detaches an
    // edited occurrence" test, applied here to the window construction rather
    // than to a single edit target.
    windowDates = allWindowDates.slice(1);
  });

  afterAll(async () => {
    await clearBookings(db, f);
    await db.delete(schema.bookingSeries).where(eq(schema.bookingSeries.seatId, f.seatA.id));
    await destroyPhase3Fixtures(db, f);
    await pool.end();
  });

  beforeEach(async () => {
    await clearBookings(db, f);
    await db.delete(schema.bookingSeries).where(eq(schema.bookingSeries.seatId, f.seatA.id));
  });

  /**
   * Only the first TWO days in the window.
   *
   * Every occurrence goes through the whole of createBooking — settings, the
   * holiday set, the seat lookup, the release lookup, authorisation, the audit
   * row — which is roughly eight round trips each against a database in
   * Singapore. Five days per series across nine tests is several minutes of
   * latency and nothing extra proved: the tombstone, the idempotence and the
   * detach-on-edit rules are all about ONE occurrence.
   */
  const weekdaysUnderTest = () =>
    [...new Set(windowDates.slice(0, 2).map(isoWeekdayOf))];

  const datesUnderTest = () =>
    windowDates.filter((d) => weekdaysUnderTest().includes(isoWeekdayOf(d)));

  async function makeSeries() {
    return createSeries(
      { db, clock, actor: f.article },
      {
        seatCode: f.seatA.code,
        slot: AM.key,
        weekdays: weekdaysUnderTest(),
        startsOn: windowDates[0]!,
      },
    );
  }

  it("materialises a booking for every day in the window", async () => {
    const { firstOccurrences } = await makeSeries();
    expect(firstOccurrences.created).toBe(datesUnderTest().length);
    expect(firstOccurrences.failed).toHaveLength(0);
  });

  it("is idempotent — a second run creates nothing", async () => {
    const { series } = await makeSeries();
    const again = await materialiseSeries({ db, clock, onlySeriesIds: [series.id] });
    expect(again.created).toBe(0);
    expect(again.skippedExisting).toBe(datesUnderTest().length);
  });

  // Booking on somebody's behalf was removed at CBVA's request (Oct 2026).
  it("refuses a series for somebody else — admins included — and creates nothing", async () => {
    for (const actor of [f.manager, f.admin]) {
      await expect(
        createSeries(
          { db, clock, actor },
          {
            seatCode: f.seatA.code,
            slot: AM.key,
            weekdays: weekdaysUnderTest(),
            startsOn: windowDates[0]!,
            occupantUserId: f.article.id,
          },
        ),
      ).rejects.toMatchObject({ code: "NOT_PERMITTED_ON_BEHALF" });
    }
    const rows = await db
      .select({ id: schema.bookingSeries.id })
      .from(schema.bookingSeries)
      .where(eq(schema.bookingSeries.seatId, f.seatA.id));
    expect(rows).toHaveLength(0);
  });

  /**
   * A series set up on somebody's behalf before the removal. None existed when
   * it shipped, but if one ever turns up its occurrences must fail quietly: a
   * rethrow here aborts the whole job run, auto-release and email included.
   */
  it("fails a leftover on-behalf series quietly instead of breaking the job run", async () => {
    const [legacy] = await db
      .insert(schema.bookingSeries)
      .values({
        occupantUserId: f.article.id,
        createdByUserId: f.manager.id,
        seatId: f.seatA.id,
        slot: AM.key,
        weekdays: weekdaysUnderTest(),
        startsOn: windowDates[0]!,
        status: "active",
        createdAt: clock.now(),
        updatedAt: clock.now(),
      })
      .returning();

    const run = await materialiseSeries({ db, clock, onlySeriesIds: [legacy!.id] });
    expect(run.created).toBe(0);
    expect(run.failed.length).toBe(datesUnderTest().length);
    expect(run.failed.every((x) => x.code === "NOT_PERMITTED_ON_BEHALF")).toBe(true);
  });

  /** THE TOMBSTONE. Cancel one day; the job must not put it back. */
  it("does not resurrect a deliberately cancelled occurrence", async () => {
    const { series } = await makeSeries();
    const [occurrence] = await db
      .select({ id: schema.bookings.id, date: schema.bookings.bookingDate })
      .from(schema.bookings)
      .where(eq(schema.bookings.seriesId, series.id))
      .limit(1);

    await cancelBooking({ db, clock, actor: f.article }, { bookingId: occurrence!.id, force: true });

    const after = await materialiseSeries({ db, clock, onlySeriesIds: [series.id] });
    expect(after.created).toBe(0);

    const live = await db
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(
        and(
          eq(schema.bookings.seriesId, series.id),
          eq(schema.bookings.bookingDate, occurrence!.date),
          eq(schema.bookings.status, "confirmed"),
        ),
      );
    expect(live).toHaveLength(0);
  });

  /**
   * The cost of the tombstone design, and the one line that pays it.
   *
   * editBooking is cancel-and-rebook (ADR-023). If the rebooked row kept its
   * seriesId it would collide with its own tombstone on
   * booking_series_occurrence_unique, and every edit of a recurring booking
   * would throw a raw index name at the user.
   */
  it("detaches an edited occurrence from its series instead of colliding", async () => {
    const { series } = await makeSeries();
    /*
     * The LAST occurrence, not an arbitrary one.
     *
     * The series starts on the first bookable date, which is often TODAY, and
     * `cutoff_minutes` closes edits 60 minutes before a slot starts. So an
     * unordered `.limit(1)` picked today's occurrence whenever the database
     * felt like it, and the whole test failed after 08:00 with "Changes closed
     * at 08:00" — correct behaviour from the rule, and nothing to do with what
     * this test is about, which is that editing an occurrence DETACHES it from
     * its series.
     *
     * Ordering to the furthest date keeps the real clock (deliberate, above:
     * the materialiser's window has to be the real window) while putting the
     * edited day safely inside the edit window.
     */
    const [occurrence] = await db
      .select({
        id: schema.bookings.id,
        date: schema.bookings.bookingDate,
        updatedAt: schema.bookings.updatedAt,
      })
      .from(schema.bookings)
      .where(eq(schema.bookings.seriesId, series.id))
      .orderBy(desc(schema.bookings.bookingDate))
      .limit(1);

    const moved = await editBooking(
      { db, clock, actor: f.article },
      {
        bookingId: occurrence!.id,
        expectedUpdatedAt: occurrence!.updatedAt.toISOString(),
        seatCode: f.seatB.code,
        bookingDate: occurrence!.date,
        slot: AM.key,
      },
    );

    const [after] = await db
      .select({ seriesId: schema.bookings.seriesId })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, moved.booking.id));
    expect(after!.seriesId).toBeNull();

    // And the tombstone is intact, so the job still does not recreate that day.
    const again = await materialiseSeries({ db, clock, onlySeriesIds: [series.id] });
    expect(again.created).toBe(0);
  });

  it("absorbs a lost race and reports it rather than throwing", async () => {
    // Somebody else takes the desk on the first day before the series runs.
    await createBooking(
      { db, clock, actor: f.colleague },
      { seatCode: f.seatA.code, bookingDate: windowDates[0]!, slot: AM.key },
    );

    const { firstOccurrences } = await makeSeries();
    expect(firstOccurrences.failed).toHaveLength(1);
    expect(firstOccurrences.failed[0]!.code).toBe("SEAT_TAKEN");
    // The rest of the series is unaffected — that is the whole point.
    expect(firstOccurrences.created).toBe(datesUnderTest().length - 1);
  });

  it("changes nothing in a dry run", async () => {
    const { series } = await makeSeries();
    await clearBookings(db, f);
    const dry = await materialiseSeries({ db, clock, onlySeriesIds: [series.id], dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.created).toBe(datesUnderTest().length);

    const rows = await db
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(eq(schema.bookings.seriesId, series.id));
    expect(rows).toHaveLength(0);
  });

  it("stops materialising once the series is ended", async () => {
    const { series } = await makeSeries();
    await cancelSeries(
      { db, clock, actor: f.article },
      { seriesId: series.id, from: windowDates[0]!, cancelFutureOccurrences: true },
    );
    const after = await materialiseSeries({ db, clock, onlySeriesIds: [series.id] });
    expect(after.seriesConsidered).toBe(0);
  });

  /**
   * Cancelling from the very first day is the ordinary case, not an edge one —
   * somebody sets a repeat up and immediately thinks better of it. Without the
   * clamp, ends_on lands before starts_on and booking_series_range_valid throws
   * a raw CHECK violation.
   */
  it("survives being cancelled from its own first day", async () => {
    const { series } = await makeSeries();
    await expect(
      cancelSeries(
        { db, clock, actor: f.article },
        { seriesId: series.id, from: windowDates[0]! },
      ),
    ).resolves.toBeTruthy();
  });
});

/**
 * ASSUMPTIONS A22. A test once drove this job from a clock set to 2099 and it
 * settled 577 real bookings, emptying the demo floor, because all three
 * transitions were unbounded UPDATEs.
 */
describe("the auto-release blast radius bound", { timeout: 180_000 }, () => {
  let pool: Pool;
  let db: Db;
  let f: Phase3Fixtures;

  beforeAll(async () => {
    pool = testPool();
    db = testDb(pool);
    f = await createPhase3Fixtures(db);
  });

  afterAll(async () => {
    await clearBookings(db, f);
    await destroyPhase3Fixtures(db, f);
    await pool.end();
  });

  /**
   * A clock far in the future is exactly the input that caused the incident:
   * from here every booking in the database looks long finished. `onlySeatIds`
   * is NOT passed, deliberately — this is the global run, which is the thing
   * the cap exists to bound.
   */
  const doomsday = new FixedClock(new Date("2099-06-01T00:00:00Z"));

  it("applies NOTHING when a transition exceeds the cap", async () => {
    const result = await runAutoRelease({
      db,
      clock: doomsday,
      batchCap: 1,
      horizonDays: 36_500,
      dryRun: true,
    });

    expect(result.capTripped).toBe(true);
    expect(result.cappedTransitions.length).toBeGreaterThan(0);
    // Not "fewer than the cap" — ZERO. A bound that lets a runaway through in
    // instalments is not a bound. See ADR-038.
    expect(result.released).toBe(0);
    expect(result.markedNoShow).toBe(0);
    expect(result.completed).toBe(0);
  });

  it("names which transition tripped, and by how much", async () => {
    const result = await runAutoRelease({
      db,
      clock: doomsday,
      batchCap: 1,
      horizonDays: 36_500,
      dryRun: true,
    });
    for (const t of result.cappedTransitions) {
      expect(["release", "no_show", "complete"]).toContain(t.transition);
      expect(t.candidates).toBeGreaterThan(t.cap);
    }
  });

  it("counts what the horizon held back rather than ignoring it", async () => {
    const result = await runAutoRelease({
      db,
      clock: doomsday,
      // A small cap keeps the candidate query to `limit 6`. The horizon count
      // is computed separately, so capping does not hide it.
      batchCap: 5,
      horizonDays: 1,
      dryRun: true,
    });
    // Everything seeded ended years before this clock, so the horizon excludes
    // it — and says so, rather than the backlog silently disappearing.
    expect(result.beyondHorizon).toBeGreaterThan(0);
  });

  it("changes nothing in a dry run", async () => {
    const before = await db
      .select({ status: schema.bookings.status })
      .from(schema.bookings)
      .where(eq(schema.bookings.status, "confirmed"));

    await runAutoRelease({ db, clock: doomsday, horizonDays: 36_500, dryRun: true });

    const after = await db
      .select({ status: schema.bookings.status })
      .from(schema.bookings)
      .where(eq(schema.bookings.status, "confirmed"));
    expect(after.length).toBe(before.length);
  });
});
