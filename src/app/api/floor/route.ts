import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/lib/adapters";
import { db, schema } from "@/lib/db";
import {
  countsAsCapacity,
  countsAsOccupied,
  seatOccupantLabel,
  seatVisualStatus,
  type BookingDbStatus,
  type SeatDbStatus,
} from "@/lib/seat-visual-status";
import type { FloorPlanPayload, FloorPlanSeat } from "@/components/floor-plan/types";
import { liveReleasesFor } from "@/lib/booking/seat-release";
import { seatAnchor } from "@/lib/floorplan";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be yyyy-MM-dd"),
  // Not an enum: the slot vocabulary is settings data now (ADR-020), and an
  // unknown key is refused by the write path with a message naming the real
  // options rather than by a 400 here.
  slot: z.string().min(1).max(12),
});

/**
 * Every seat on the floor, resolved to a visual status for one date, one slot
 * and one viewer.
 *
 * Which booking rows are joined is a deliberate list, not a convenience:
 *
 * - `confirmed` / `checked_in` hold the desk. Same predicate as seat_slot_unique.
 * - `completed` holds it too, so a past day still reads as occupied rather than
 *   emptying out behind you.
 * - `auto_released` does NOT hold the desk — it is free — but it is joined so
 *   the plan can say the desk came free LATE. That distinction is the 2-hour
 *   rule made visible, and without this row `seatVisualStatus`'s auto_released
 *   branch would be unreachable code.
 *
 * Cancelled rows are excluded entirely. They stay in the table because the
 * history is the analytics, but they must never make a desk look taken.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    date: url.searchParams.get("date"),
    slot: url.searchParams.get("slot"),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  const { date, slot } = parsed.data;

  const viewer = await auth().currentUser();
  const database = db();

  const seatRows = await database
    .select({
      seatId: schema.seats.id,
      seatCode: schema.seats.seatCode,
      bay: schema.seats.bay,
      zoneCode: schema.zones.code,
      planX: schema.seats.planX,
      planY: schema.seats.planY,
      rotationDeg: schema.seats.rotationDeg,
      seatType: schema.seats.seatType,
      status: schema.seats.status,
      assignedName: schema.users.displayName,
    })
    .from(schema.seats)
    .innerJoin(schema.zones, eq(schema.seats.zoneId, schema.zones.id))
    .leftJoin(schema.users, eq(schema.seats.assignedUserId, schema.users.id));

  // Fixed desks their owners have handed back for exactly this date and slot.
  // One query, not 158 — the seat loop below reads the Map.
  const releases = await liveReleasesFor(database, date, slot);

  const bookingRows = await database
    .select({
      seatCode: schema.seats.seatCode,
      bookingId: schema.bookings.id,
      status: schema.bookings.status,
      occupantEmail: schema.users.email,
      occupantName: schema.users.displayName,
      shareAttendance: schema.users.shareAttendance,
      updatedAt: schema.bookings.updatedAt,
      createdAt: schema.bookings.createdAt,
    })
    .from(schema.bookings)
    .innerJoin(schema.seats, eq(schema.bookings.seatId, schema.seats.id))
    .innerJoin(schema.users, eq(schema.bookings.occupantUserId, schema.users.id))
    .where(
      and(
        eq(schema.bookings.bookingDate, date),
        eq(schema.bookings.slot, slot),
        inArray(schema.bookings.status, [
          "confirmed",
          "checked_in",
          "completed",
          "auto_released",
        ]),
      ),
    );

  /**
   * One desk and slot can carry several rows: a booking that was released, then
   * a second person's booking on the freed desk, and both may finish. The row
   * that describes the desk's CURRENT state is the one that still holds it — so
   * a holding row always beats a released one, and among equals the newest wins.
   */
  const HOLDS = new Set(["confirmed", "checked_in", "completed"]);
  const bookingBySeat = new Map<string, (typeof bookingRows)[number]>();
  for (const row of bookingRows) {
    const existing = bookingBySeat.get(row.seatCode);
    if (!existing) {
      bookingBySeat.set(row.seatCode, row);
      continue;
    }
    const better =
      (HOLDS.has(row.status) && !HOLDS.has(existing.status)) ||
      (HOLDS.has(row.status) === HOLDS.has(existing.status) &&
        row.createdAt > existing.createdAt);
    if (better) bookingBySeat.set(row.seatCode, row);
  }

  let occupied = 0;
  let capacity = 0;

  const seats: FloorPlanSeat[] = seatRows.map((row) => {
    const booking = bookingBySeat.get(row.seatCode);
    const releasedByOwner = releases.has(row.seatId);

    /**
     * WHOSE NAME IS VISIBLE, AND TO WHOM.
     *
     * Until Phase 5 this route returned every occupant's name to anybody who
     * asked, including a signed-out visitor. That was a real leak and it is
     * closed here rather than in the UI, because the UI is not the boundary.
     *
     * Two rules, in order:
     *   1. Nobody sees a colleague's name unless they are signed in.
     *   2. A colleague who has opted out of the roster is not named at all.
     *
     * You always see your OWN name, and an opted-out person still shows as a
     * held desk — the seat status is unchanged, only the label goes. So the
     * occupancy data is completely unaffected by anyone's privacy choice, which
     * is the property that lets us offer the opt-out at all.
     */
    const isViewersOwn =
      viewer != null && booking != null && booking.occupantEmail === viewer.email;
    const mayShowName =
      isViewersOwn || (viewer != null && (booking?.shareAttendance ?? true));

    const input = {
      seatStatus: row.status as SeatDbStatus,
      assignedName: row.assignedName,
      bookingStatus: (booking?.status ?? null) as BookingDbStatus | null,
      occupantEmail: booking?.occupantEmail ?? null,
      occupantName: booking?.occupantName ?? null,
      viewerEmail: viewer?.email ?? null,
      releasedByOwner,
    };
    const status = seatVisualStatus(input);
    if (countsAsOccupied(status)) occupied += 1;
    if (countsAsCapacity(status)) capacity += 1;

    const yours =
      booking != null && viewer != null && booking.occupantEmail === viewer.email;

    return {
      seatCode: row.seatCode,
      bay: row.bay,
      zone: row.zoneCode as FloorPlanSeat["zone"],
      // numeric columns arrive as strings from pg — deliberate, not a bug.
      planX: Number(row.planX),
      planY: Number(row.planY),
      rotationDeg: row.rotationDeg,
      seatType: row.seatType,
      seatStatus: input.seatStatus,
      status,
      occupantName: mayShowName ? seatOccupantLabel(input) : null,
      /**
       * The desk is allocated to somebody who has given it up for this slot.
       * Not an eighth status — the seat already renders as available or booked
       * through the ordinary paths — just a line the hover card can add, so it
       * is obvious WHY a partner's desk is bookable today.
       */
      releasedByOwner,
      // Carried so the booking dialog can edit or cancel straight from the
      // plan without a second round trip. Only for the viewer's own booking:
      // nobody needs the id of a desk that is not theirs.
      bookingId: yours ? booking!.bookingId : null,
      bookingUpdatedAt: yours ? booking!.updatedAt.toISOString() : null,
      // Where the position came from: the drawing, an interpolation, or
      // somebody dragging it in the editor. The editor badges the weak ones.
      anchorSource: seatAnchor(row.seatCode)?.source ?? "manual",
    };
  });

  seats.sort((a, b) => a.seatCode.localeCompare(b.seatCode));

  const payload: FloorPlanPayload = {
    date,
    slot,
    seats,
    occupied,
    capacity,
    viewerEmail: viewer?.email ?? null,
  };
  return NextResponse.json(payload);
}
