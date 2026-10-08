/**
 * Who may change a desk booking, now that booking on somebody's behalf is gone.
 *
 * Editing is cancel-and-rebook, so it CREATES a booking. If anyone but the
 * person booked into it could edit, booking on their behalf would still exist
 * by another route. Cancelling creates nothing and stays open to the booker
 * and to admins.
 *
 * Same isolation as the Phase 3 suites: a private floor, a random tag, 2099.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";

import { cancelBooking, createBooking, editBooking } from "@/lib/booking/service";
import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { User } from "@/lib/db/schema";

import {
  bookingById,
  clearBookings,
  createPhase3Fixtures,
  destroyPhase3Fixtures,
  FixedClock,
  MONDAY,
  testDb,
  testPool,
  type Phase3Fixtures,
} from "../phase3-helpers";

/** Monday 5 January 2099, 07:00 IST — before the AM slot and its cut-off. */
const MONDAY_0700_IST = new Date("2099-01-05T01:30:00Z");

let pool: Pool;
let db: Db;
let f: Phase3Fixtures;

function ctx(actor: User) {
  return { db, clock: new FixedClock(MONDAY_0700_IST), actor };
}

/** The colleague's own Monday AM booking on seat A. */
async function colleaguesBooking() {
  return createBooking(ctx(f.colleague), {
    seatCode: f.seatA.code,
    bookingDate: MONDAY,
    slot: "AM",
  });
}

beforeAll(async () => {
  pool = testPool();
  db = testDb(pool);
  f = await createPhase3Fixtures(db);
});

afterEach(async () => {
  await clearBookings(db, f);
});

afterAll(async () => {
  await destroyPhase3Fixtures(db, f);
  await pool.end();
});

describe("editing a desk booking", () => {
  it("is refused for an admin, and the original booking is untouched", async () => {
    const original = await colleaguesBooking();

    await expect(
      editBooking(ctx(f.admin), {
        bookingId: original.booking.id,
        expectedUpdatedAt: original.booking.updatedAt.toISOString(),
        seatCode: f.seatB.code,
        bookingDate: MONDAY,
        slot: "AM",
      }),
    ).rejects.toMatchObject({ code: "NOT_PERMITTED_ON_BEHALF" });

    const row = await bookingById(db, original.booking.id);
    expect(row!.status).toBe("confirmed");
    expect(row!.seatId).toBe(f.seatA.id);
  });

  it("on a historical on-behalf booking: refused for the booker, allowed for the occupant as their own", async () => {
    const original = await colleaguesBooking();
    // Turn it into a pre-removal on-behalf row: booked by the manager.
    await db
      .update(schema.bookings)
      .set({ bookedByUserId: f.manager.id, source: "on_behalf" })
      .where(eq(schema.bookings.id, original.booking.id));
    const legacy = (await bookingById(db, original.booking.id))!;

    await expect(
      editBooking(ctx(f.manager), {
        bookingId: legacy.id,
        expectedUpdatedAt: legacy.updatedAt.toISOString(),
        seatCode: f.seatB.code,
        bookingDate: MONDAY,
        slot: "AM",
      }),
    ).rejects.toMatchObject({ code: "NOT_PERMITTED_ON_BEHALF" });

    const moved = await editBooking(ctx(f.colleague), {
      bookingId: legacy.id,
      expectedUpdatedAt: legacy.updatedAt.toISOString(),
      seatCode: f.seatB.code,
      bookingDate: MONDAY,
      slot: "AM",
    });
    // The new booking is the occupant's own: no on-behalf row is ever minted.
    expect(moved.booking.source).toBe("self");
    expect(moved.booking.bookedByUserId).toBe(f.colleague.id);
    expect(moved.booking.occupantUserId).toBe(f.colleague.id);
  });
});

describe("cancelling a desk booking", () => {
  it("is still allowed for an admin (it creates nothing)", async () => {
    const original = await colleaguesBooking();
    await cancelBooking(ctx(f.admin), { bookingId: original.booking.id });
    const row = await bookingById(db, original.booking.id);
    expect(row!.status).toMatch(/^cancelled/);
  });
});
