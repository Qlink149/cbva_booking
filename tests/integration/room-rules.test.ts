/**
 * Who may book a meeting room, and when.
 *
 * Same isolation as the Phase 3 suites: a private floor and room, a random tag,
 * and dates in 2099 that the seed never touches.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";

import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { User } from "@/lib/db/schema";
import { createRoomBooking } from "@/lib/rooms/service";

import {
  createPhase3Fixtures,
  destroyPhase3Fixtures,
  FixedClock,
  MONDAY,
  testDb,
  testPool,
  type Phase3Fixtures,
} from "../phase3-helpers";

/** Monday 5 January 2099, 07:00 IST — before office hours, so every hour is ahead. */
const MONDAY_0700_IST = new Date("2099-01-05T01:30:00Z");

let pool: Pool;
let db: Db;
let f: Phase3Fixtures;

function ctx(actor: User) {
  return { db, clock: new FixedClock(MONDAY_0700_IST), actor };
}

beforeAll(async () => {
  pool = testPool();
  db = testDb(pool);
  f = await createPhase3Fixtures(db);
});

afterEach(async () => {
  await db.delete(schema.roomBookings).where(eq(schema.roomBookings.roomId, f.roomId));
});

afterAll(async () => {
  await destroyPhase3Fixtures(db, f);
  await pool.end();
});

describe("who may book a meeting room — Managers and above (CBVA, Oct 2026)", () => {
  it("lets a manager book", async () => {
    const created = await createRoomBooking(ctx(f.manager), {
      roomId: f.roomId,
      title: "Audit planning",
      date: MONDAY,
      startHour: 10,
      endHour: 11,
    });
    expect(created.booking.status).toBe("confirmed");
  });

  it("refuses an article, an assistant manager and HR/IT admin staff, and books nothing", async () => {
    for (const actor of [f.article, f.colleague, f.admin]) {
      await expect(
        createRoomBooking(ctx(actor), {
          roomId: f.roomId,
          title: "Should not land",
          date: MONDAY,
          startHour: 10,
          endHour: 11,
        }),
        actor.grade,
      ).rejects.toMatchObject({ code: "NOT_PERMITTED_ROOMS" });
    }
    const rows = await db
      .select({ id: schema.roomBookings.id })
      .from(schema.roomBookings)
      .where(eq(schema.roomBookings.roomId, f.roomId));
    expect(rows).toHaveLength(0);
  });
});
