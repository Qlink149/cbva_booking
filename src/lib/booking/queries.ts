/**
 * Reads for the booking screens.
 *
 * Separate from service.ts because these have no side effects and no
 * authorisation of their own beyond "whose bookings are these" — keeping them
 * apart makes it obvious which functions can change something.
 */
import { and, asc, desc, eq, gte, inArray, lt, or } from "drizzle-orm";

import { schema, type Db } from "@/lib/db";

export interface MyBookingRow {
  id: string;
  seatCode: string;
  bay: string;
  zone: string;
  bookingDate: string;
  slot: string;
  startsAt: string;
  endsAt: string;
  status: string;
  source: string;
  checkedInAt: string | null;
  checkInMethod: string | null;
  updatedAt: string;
  occupantUserId: string;
  occupantName: string;
  bookedByUserId: string;
  bookedByName: string;
  /** True when the viewer is not the person sitting there. */
  bookedForSomeoneElse: boolean;
}

const ROW = {
  id: schema.bookings.id,
  seatCode: schema.seats.seatCode,
  bay: schema.seats.bay,
  zone: schema.zones.code,
  bookingDate: schema.bookings.bookingDate,
  slot: schema.bookings.slot,
  startsAt: schema.bookings.startsAt,
  endsAt: schema.bookings.endsAt,
  status: schema.bookings.status,
  source: schema.bookings.source,
  checkedInAt: schema.bookings.checkedInAt,
  checkInMethod: schema.bookings.checkInMethod,
  updatedAt: schema.bookings.updatedAt,
  occupantUserId: schema.bookings.occupantUserId,
  occupantName: schema.users.displayName,
  bookedByUserId: schema.bookings.bookedByUserId,
};

/** What the ROW selection above actually comes back as. */
interface RawBookingRow {
  id: string;
  seatCode: string;
  bay: string;
  zone: string;
  bookingDate: string;
  slot: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  source: string;
  checkedInAt: Date | null;
  checkInMethod: string | null;
  updatedAt: Date;
  occupantUserId: string;
  occupantName: string;
  bookedByUserId: string;
}

function shape(
  row: RawBookingRow,
  bookerNames: Map<string, string>,
  viewerId: string,
): MyBookingRow {
  return {
    id: row.id,
    seatCode: row.seatCode,
    bay: row.bay,
    zone: row.zone,
    bookingDate: row.bookingDate,
    slot: row.slot,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    source: row.source,
    checkedInAt: row.checkedInAt ? row.checkedInAt.toISOString() : null,
    checkInMethod: row.checkInMethod,
    updatedAt: row.updatedAt.toISOString(),
    occupantUserId: row.occupantUserId,
    occupantName: row.occupantName,
    bookedByUserId: row.bookedByUserId,
    bookedByName: bookerNames.get(row.bookedByUserId) ?? "—",
    bookedForSomeoneElse: row.occupantUserId !== viewerId,
  };
}

/**
 * Bookings that concern this person: the ones they sit in, and the ones they
 * made for somebody else. A manager who seats their team needs to be able to
 * find and unbook those, so filtering on occupant alone would strand them.
 */
export async function myBookings(
  db: Db,
  userId: string,
  now: Date,
): Promise<{ upcoming: MyBookingRow[]; past: MyBookingRow[] }> {
  const mine = or(
    eq(schema.bookings.occupantUserId, userId),
    eq(schema.bookings.bookedByUserId, userId),
  );

  const upcomingRows = await db
    .select(ROW)
    .from(schema.bookings)
    .innerJoin(schema.seats, eq(schema.bookings.seatId, schema.seats.id))
    .innerJoin(schema.zones, eq(schema.seats.zoneId, schema.zones.id))
    .innerJoin(schema.users, eq(schema.bookings.occupantUserId, schema.users.id))
    .where(
      and(
        mine,
        gte(schema.bookings.endsAt, now),
        inArray(schema.bookings.status, ["confirmed", "checked_in"]),
      ),
    )
    .orderBy(asc(schema.bookings.startsAt));

  const pastRows = await db
    .select(ROW)
    .from(schema.bookings)
    .innerJoin(schema.seats, eq(schema.bookings.seatId, schema.seats.id))
    .innerJoin(schema.zones, eq(schema.seats.zoneId, schema.zones.id))
    .innerJoin(schema.users, eq(schema.bookings.occupantUserId, schema.users.id))
    .where(
      and(
        mine,
        or(
          lt(schema.bookings.endsAt, now),
          // Cancelled and released rows belong in the history even when their
          // slot has not happened yet: they are what the person did, and
          // hiding them makes a cancellation look like it never registered.
          inArray(schema.bookings.status, [
            "cancelled_by_user",
            "cancelled_after_check_in",
            "cancelled_by_admin",
            "auto_released",
            "completed",
            "completed_no_show",
          ]),
        ),
      ),
    )
    .orderBy(desc(schema.bookings.startsAt))
    .limit(60);

  const bookerIds = [...new Set([...upcomingRows, ...pastRows].map((r) => r.bookedByUserId))];
  const bookers = bookerIds.length
    ? await db
        .select({ id: schema.users.id, displayName: schema.users.displayName })
        .from(schema.users)
        .where(inArray(schema.users.id, bookerIds))
    : [];
  const names = new Map(bookers.map((b) => [b.id, b.displayName]));

  return {
    upcoming: upcomingRows.map((r) => shape(r, names, userId)),
    past: pastRows.map((r) => shape(r, names, userId)),
  };
}

/**
 * Active bookings on a desk from a given instant onwards.
 *
 * The list an admin is shown before a seat is taken out of service — edge cases
 * 7 and 8 refuse the change rather than silently stranding these people.
 */
export async function futureBookingsForSeat(
  db: Db,
  seatId: string,
  from: Date,
): Promise<
  Array<{
    id: string;
    bookingDate: string;
    slot: string;
    occupantName: string;
    occupantEmail: string;
  }>
> {
  return db
    .select({
      id: schema.bookings.id,
      bookingDate: schema.bookings.bookingDate,
      slot: schema.bookings.slot,
      occupantName: schema.users.displayName,
      occupantEmail: schema.users.email,
    })
    .from(schema.bookings)
    .innerJoin(schema.users, eq(schema.bookings.occupantUserId, schema.users.id))
    .where(
      and(
        eq(schema.bookings.seatId, seatId),
        gte(schema.bookings.endsAt, from),
        inArray(schema.bookings.status, ["confirmed", "checked_in"]),
      ),
    )
    .orderBy(asc(schema.bookings.startsAt));
}

/** Active bookings a person holds from an instant onwards (edge case 12). */
export async function futureBookingsForUser(db: Db, userId: string, from: Date) {
  return db
    .select({ id: schema.bookings.id, startsAt: schema.bookings.startsAt })
    .from(schema.bookings)
    .where(
      and(
        eq(schema.bookings.occupantUserId, userId),
        gte(schema.bookings.endsAt, from),
        inArray(schema.bookings.status, ["confirmed", "checked_in"]),
      ),
    )
    .orderBy(asc(schema.bookings.startsAt));
}
