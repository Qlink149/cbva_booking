/**
 * "Switching to hourly must be a settings change, not a refactor. Prove it."
 *
 * CBVA's document says hourly; its only worked example is a half day, and the
 * deck we showed them uses half days. So half days ship — but if the firm comes
 * back and asks for hourly, the answer has to be a settings write, not a
 * quarter's work. This file is the proof, and it is deliberately unglamorous:
 * it adds one-hour slots to `settings.slot_definitions` and then runs the
 * ENTIRE desk lifecycle — book, check in, edit, cancel, auto-release, backfill
 * — against a slot key that did not exist when the code was written.
 *
 * Nothing in `src/` is aware of this test. If anybody reintroduces an AM/PM
 * type, a hardcoded slot list, or a second copy of `deriveSlotBounds`, this is
 * what fails.
 *
 * WHY IT ADDS SLOTS RATHER THAN REPLACING THEM. The seeded database has ~530
 * live AM/PM bookings, and `updateSettings` refuses to drop a slot key that
 * live bookings still use — a booking whose slot no longer exists has no start
 * time that could be computed for it. That refusal is correct product
 * behaviour and is asserted below in its own case. So the change demonstrated
 * here is the one a real firm could actually perform: extend the vocabulary,
 * then book against the new keys.
 *
 * `settings` is a singleton shared with the dev server and every other spec, so
 * it is snapshotted and restored without fail.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";

import { updateSettings } from "@/lib/admin/settings-service";
import { runAutoRelease } from "@/lib/booking/auto-release";
import {
  cancelBooking,
  checkInBooking,
  createBooking,
  editBooking,
} from "@/lib/booking/service";
import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getSettings } from "@/lib/settings";
import { DEFAULT_SLOT_DEFINITIONS, hourlySlotDefinitions, type SlotDefinition } from "@/lib/slots";

import {
  bookingById,
  clearBookings,
  createPhase3Fixtures,
  destroyPhase3Fixtures,
  FixedClock,
  MINUTE,
  MONDAY,
  restoreSettings,
  snapshotSettings,
  testDb,
  testPool,
  type Phase3Fixtures,
  type SettingsSnapshot,
} from "../phase3-helpers";

/** Monday 5 January 2099, 07:00 IST — before every slot of the day. */
const MONDAY_0700_IST = new Date("2099-01-05T01:30:00Z");
/** E17 runs 17:00–18:00 IST, which is 11:30–12:30 UTC. */
const E17_START = new Date("2099-01-05T11:30:00Z");
const E17_END = new Date("2099-01-05T12:30:00Z");

/**
 * Half days, plus one-hour slots for the evening.
 *
 * A firm moving to hourly booking would do it this way — a vocabulary that
 * grows, rather than one swapped out underneath people who have already booked.
 */
const HALF_DAYS_PLUS_HOURLY: SlotDefinition[] = [
  ...DEFAULT_SLOT_DEFINITIONS,
  ...hourlySlotDefinitions(17, 20).map((d) => ({ ...d, key: d.key.replace("H", "E") })),
];

let pool: Pool;
let db: Db;
let f: Phase3Fixtures;
let snap: SettingsSnapshot;

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

beforeAll(async () => {
  pool = testPool(6);
  db = testDb(pool);
  snap = await snapshotSettings(db);
  f = await createPhase3Fixtures(db);
});

afterAll(async () => {
  await clearBookings(db, f);
  await destroyPhase3Fixtures(db, f);
  // Without this the dev database is left running the extended vocabulary, and
  // every other spec — and the demo — quietly changes shape.
  await restoreSettings(db, snap);
  await pool.end();
});

describe("reconfiguring the firm to hourly booking", () => {
  it("is a settings write, and the whole booking lifecycle still works", async () => {
    const clock = new FixedClock(MONDAY_0700_IST);
    const ctx = (actor: schema.User) => ({ db, clock, actor });

    /* ---- the entire change ---- */
    await updateSettings(ctx(f.admin), { slotDefinitions: HALF_DAYS_PLUS_HOURLY });

    const settings = await getSettings(db);
    expect(settings.slotDefinitions.map((d) => d.key)).toEqual(["AM", "PM", "E17", "E18", "E19"]);
    expect(settings.slotDefinitions[2]).toMatchObject({
      key: "E17",
      start: "17:00",
      end: "18:00",
    });

    /* ---- book an hour, on a key that did not exist in the source ---- */
    const booked = await createBooking(ctx(f.article), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "E17",
    });
    expect(booked.booking.slot).toBe("E17");
    // The bounds came from the same deriveSlotBounds the half-day config uses.
    expect(booked.booking.startsAt.toISOString()).toBe(E17_START.toISOString());
    expect(booked.booking.endsAt.toISOString()).toBe(E17_END.toISOString());

    /* ---- the next hour on the same desk is a different slot ---- */
    const nextHour = await createBooking(ctx(f.colleague), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "E18",
    });
    expect(nextHour.booking.status).toBe("confirmed");

    /* ---- and the same hour on the same desk is still refused ---- */
    await expect(
      createBooking(ctx(f.colleague), {
        seatCode: f.seatA.code,
        bookingDate: MONDAY,
        slot: "E17",
      }),
    ).rejects.toMatchObject({ code: "SEAT_TAKEN" });

    /* ---- move it to another desk ---- */
    const moved = await editBooking(ctx(f.article), {
      bookingId: booked.booking.id,
      expectedUpdatedAt: booked.booking.updatedAt.toISOString(),
      seatCode: f.seatB.code,
      bookingDate: MONDAY,
      slot: "E17",
    });
    expect(moved.seatCode).toBe(f.seatB.code);
    expect(moved.booking.slot).toBe("E17");

    /* ---- check in during the hour ---- */
    clock.set(new Date(E17_START.getTime() + 5 * MINUTE));
    const checked = await checkInBooking(ctx(f.article), {
      seatCode: f.seatB.code,
      method: "qr",
    });
    expect(checked.booking.status).toBe("checked_in");
    expect(checked.slot.key).toBe("E17");

    /* ---- cancel after checking in ---- */
    const cancelled = await cancelBooking(ctx(f.article), { bookingId: moved.booking.id });
    expect(cancelled.status).toBe("cancelled_after_check_in");

    /* ---- auto-release runs the real rule on an hourly slot ---- */
    // The grace window is 120 minutes, LONGER than an hour-long slot — so an
    // un-checked-in hourly booking can never "release": by the time the window
    // expires the hour is over and it settles as a no-show instead. That is
    // correct, and it is exactly the sort of interaction a settings change
    // produces, which is why it is asserted rather than assumed. If CBVA does
    // move to hourly, auto_release_minutes has to come down with it.
    clock.set(new Date(E17_END.getTime() + 45 * MINUTE)); // inside E18
    expect((await runAutoRelease({ db, clock, onlySeatIds: seatIds() })).released).toBe(0);

    clock.set(new Date("2099-01-05T14:00:00Z")); // 19:30 IST, past E18
    const after = await runAutoRelease({ db, clock, onlySeatIds: seatIds() });
    expect(after.markedNoShow).toBe(1);
    expect((await bookingById(db, nextHour.booking.id))!.status).toBe("completed_no_show");

    await clearBookings(db, f);
  });

  it("refuses a slot key the definitions do not contain", async () => {
    const clock = new FixedClock(MONDAY_0700_IST);
    await expect(
      createBooking(
        { db, clock, actor: f.article },
        { seatCode: f.seatA.code, bookingDate: MONDAY, slot: "H09" },
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_SLOT" });
  });

  it("refuses to drop a slot that live bookings still use, rather than orphaning them", async () => {
    const clock = new FixedClock(MONDAY_0700_IST);
    const ctx = (actor: schema.User) => ({ db, clock, actor });

    // The seeded database has hundreds of live AM and PM bookings. Dropping
    // those keys would leave every one of them with a slot that has no start
    // time, so the change is refused — with the count — rather than applied.
    await expect(
      updateSettings(ctx(f.admin), { slotDefinitions: hourlySlotDefinitions(9, 17) }),
    ).rejects.toMatchObject({ code: "UNKNOWN_SLOT" });

    const settings = await getSettings(db);
    expect(settings.slotDefinitions.map((d) => d.key)).toContain("AM");
  });

  it("backfills stored bounds when a boundary moves — ADR-007's open problem", async () => {
    const clock = new FixedClock(MONDAY_0700_IST);
    const ctx = (actor: schema.User) => ({ db, clock, actor });

    const booked = await createBooking(ctx(f.article), {
      seatCode: f.seatA.code,
      bookingDate: MONDAY,
      slot: "E19",
    });
    expect(booked.booking.startsAt.toISOString()).toBe("2099-01-05T13:30:00.000Z"); // 19:00 IST

    // Move E19 half an hour later. Under ADR-007's original design the settings
    // row and this booking would now disagree about when 19:00 is, for ever.
    const shifted = HALF_DAYS_PLUS_HOURLY.map((d) =>
      d.key === "E19" ? { ...d, start: "19:30", end: "20:30" } : d,
    );
    const result = await updateSettings(ctx(f.admin), { slotDefinitions: shifted });

    expect(result.backfilled).toBeGreaterThanOrEqual(1);
    const after = await bookingById(db, booked.booking.id);
    expect(
      after!.startsAt.toISOString(),
      "the stored bounds moved with the definition that produced them",
    ).toBe("2099-01-05T14:00:00.000Z"); // 19:30 IST

    await db.delete(schema.bookings).where(eq(schema.bookings.id, booked.booking.id));
  });
});
