/**
 * Meeting rooms.
 *
 * Two things make this different from desks. Rooms are booked as arbitrary
 * ranges rather than slots, so overlap is a GiST exclusion constraint rather
 * than a unique index — and rooms are the one part of the product that talks to
 * an external system.
 *
 * THE CALENDAR RULE: a calendar failure must never lose a booking. The row is
 * committed first and the calendar is called afterwards, outside the
 * transaction. If Graph is down, unreachable, or throttled, the booking still
 * exists, `sync_status` records that it did not sync, and a retry job picks it
 * up. Nothing about a Microsoft outage is allowed to cost somebody their room.
 */
import { and, asc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

import { calendar as defaultCalendar } from "@/lib/adapters";
import type { CalendarSync } from "@/lib/adapters/types";
import { writeAudit } from "@/lib/audit";
import { assertSignedIn } from "@/lib/booking/authorise";
import { BookingError, rethrowMapped } from "@/lib/booking/errors";
import { assertBeforeCutoff } from "@/lib/booking/rules";
import type { Clock } from "@/lib/clock";
import { schema, type Db, type DbLike } from "@/lib/db";
import type { RoomBooking, RoomBookingAttendee, User } from "@/lib/db/schema";
import { loadHolidays } from "@/lib/holidays";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { renderRoomNotification } from "@/lib/notifications/render";
import { getSettings } from "@/lib/settings";
import {
  officeHourColumns,
  roomBookingSchema,
  roomDateIssue,
  type RoomBookingRequest,
} from "@/lib/rooms/validation";

export interface RoomServiceContext {
  db: Db;
  clock: Clock;
  actor: User;
  /** Injected so a test can prove a sync failure does not lose the booking. */
  calendar?: CalendarSync;
}

/* --------------------------------------------------------------- the grid */

export interface RoomGridAttendee {
  name: string;
  email: string;
  /** True when the email matched an active CBVA account. */
  isStaff: boolean;
}

export interface RoomGridBooking {
  id: string;
  roomId: string;
  title: string;
  organiserName: string;
  organiserUserId: string;
  startsAt: string;
  endsAt: string;
  startHour: number;
  endHour: number;
  syncStatus: string;
  updatedAt: string;
  /** Beyond the organiser. Empty for the ordinary "just me" meeting. */
  attendees: RoomGridAttendee[];
}

export interface RoomGrid {
  date: string;
  timezone: string;
  hours: number[];
  rooms: Array<{
    id: string;
    name: string;
    /**
     * The architect's bay tag (A3, A9, A8, A7, A6). Carried so this screen and
     * the floor plan name the same room the same way — the display NAME is the
     * field CBVA is expected to change, so it cannot be the join key.
     * Null for a room that is not on the drawing.
     */
    bayCode: string | null;
    capacity: number;
    isBookable: boolean;
    amenities: unknown;
    /**
     * Distinct people with a confirmed booking in this room on this date —
     * "how many people booked here today", not a count of bookings, so one
     * person holding the room for three separate hours still reads as 1.
     */
    bookedByCount: number;
    /** Total confirmed bookings, kept alongside the person count above. */
    bookingCount: number;
  }>;
  bookings: RoomGridBooking[];
}

export async function roomDay(db: Db, date: string): Promise<RoomGrid> {
  const settings = await getSettings(db);
  const dayStart = fromZonedTime(`${date}T00:00:00`, settings.timezone);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);

  const rooms = await db
    .select()
    .from(schema.meetingRooms)
    .orderBy(sql`${schema.meetingRooms.capacity} desc`, asc(schema.meetingRooms.name));

  const rows = await db
    .select({
      booking: schema.roomBookings,
      organiserName: schema.users.displayName,
    })
    .from(schema.roomBookings)
    .innerJoin(schema.users, eq(schema.roomBookings.organiserUserId, schema.users.id))
    .where(
      and(
        eq(schema.roomBookings.status, "confirmed"),
        gte(schema.roomBookings.startsAt, dayStart),
        lt(schema.roomBookings.startsAt, dayEnd),
      ),
    )
    .orderBy(asc(schema.roomBookings.startsAt));

  const localHour = (d: Date) =>
    Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: settings.timezone,
        hour: "2-digit",
        hour12: false,
      }).format(d),
    );

  // Grouped from the same rows the grid itself is built from, not a second
  // query — this date's bookings are already in memory.
  const byRoom = new Map<string, { people: Set<string>; count: number }>();
  for (const { booking } of rows) {
    const entry = byRoom.get(booking.roomId) ?? { people: new Set<string>(), count: 0 };
    entry.people.add(booking.organiserUserId);
    entry.count += 1;
    byRoom.set(booking.roomId, entry);
  }

  // One query for every attendee across every booking this day, then grouped
  // in memory — an N+1 here would mean one query per meeting on a busy day.
  const bookingIds = rows.map(({ booking }) => booking.id);
  const attendeeRows =
    bookingIds.length === 0
      ? []
      : await db
          .select({
            roomBookingId: schema.roomBookingAttendees.roomBookingId,
            name: schema.roomBookingAttendees.name,
            email: schema.roomBookingAttendees.email,
            userId: schema.roomBookingAttendees.userId,
          })
          .from(schema.roomBookingAttendees)
          .where(inArray(schema.roomBookingAttendees.roomBookingId, bookingIds));
  const attendeesByBooking = new Map<string, RoomGridAttendee[]>();
  for (const a of attendeeRows) {
    const list = attendeesByBooking.get(a.roomBookingId) ?? [];
    list.push({ name: a.name, email: a.email, isStaff: a.userId !== null });
    attendeesByBooking.set(a.roomBookingId, list);
  }

  return {
    date,
    timezone: settings.timezone,
    hours: officeHourColumns(settings.officeHours),
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      bayCode: r.bayCode,
      capacity: r.capacity,
      isBookable: r.isBookable,
      amenities: r.amenities,
      bookedByCount: byRoom.get(r.id)?.people.size ?? 0,
      bookingCount: byRoom.get(r.id)?.count ?? 0,
    })),
    bookings: rows.map(({ booking, organiserName }) => ({
      id: booking.id,
      roomId: booking.roomId,
      title: booking.title,
      organiserName,
      organiserUserId: booking.organiserUserId,
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      startHour: localHour(booking.startsAt),
      // An end of exactly midnight would read as hour 0; the grid never runs
      // that late, but the arithmetic is done on the range rather than the
      // formatted hour so it cannot wrap.
      endHour:
        localHour(booking.startsAt) +
        Math.round((booking.endsAt.getTime() - booking.startsAt.getTime()) / 3600_000),
      syncStatus: booking.syncStatus,
      updatedAt: booking.updatedAt.toISOString(),
      attendees: attendeesByBooking.get(booking.id) ?? [],
    })),
  };
}

/* ------------------------------------------------------------------ create */

export interface CreateRoomBookingResult {
  booking: RoomBooking;
  roomName: string;
  /** False when the calendar call failed. The booking exists either way. */
  calendarSynced: boolean;
  attendees: RoomBookingAttendee[];
}

/**
 * "aparna.modi" becomes "Aparna Modi" — good enough to show on a grid for
 * somebody outside the firm, who has no display name of their own to use.
 * A CBVA employee never reaches this: they are matched by email first.
 */
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Resolves each email against `users` (active only) and inserts one row per
 * attendee. Matched and unmatched attendees are inserted together so a
 * partial failure cannot leave the list half right.
 */
async function insertAttendees(
  tx: DbLike,
  roomBookingId: string,
  emails: string[],
  now: Date,
): Promise<RoomBookingAttendee[]> {
  if (emails.length === 0) return [];

  const matches = await tx
    .select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
    .from(schema.users)
    .where(and(inArray(schema.users.email, emails), eq(schema.users.isActive, true)));
  const byEmail = new Map(matches.map((u) => [u.email.toLowerCase(), u]));

  return tx
    .insert(schema.roomBookingAttendees)
    .values(
      emails.map((email) => {
        const match = byEmail.get(email);
        return {
          roomBookingId,
          userId: match?.id ?? null,
          name: match?.displayName ?? nameFromEmail(email),
          email,
          createdAt: now,
        };
      }),
    )
    .returning();
}

export async function createRoomBooking(
  ctx: RoomServiceContext,
  input: RoomBookingRequest,
): Promise<CreateRoomBookingResult> {
  assertSignedIn(ctx.actor);
  const now = ctx.clock.now();
  const settings = await getSettings(ctx.db);

  // Office hours, zero-length and inverted ranges all die here (edge case 15).
  const parsed = roomBookingSchema(settings.officeHours).safeParse(input);
  if (!parsed.success) {
    throw new BookingError(
      "OUTSIDE_OFFICE_HOURS",
      parsed.error.issues.map((i) => i.message).join(" "),
      { issues: parsed.error.issues },
    );
  }
  const req = parsed.data;

  const [room] = await ctx.db
    .select()
    .from(schema.meetingRooms)
    .where(eq(schema.meetingRooms.id, req.roomId))
    .limit(1);
  if (!room) throw new BookingError("ROOM_NOT_FOUND", "That room is not on this floor.");
  if (!room.isBookable) {
    throw new BookingError("ROOM_NOT_BOOKABLE", `${room.name} is not available for booking.`);
  }

  const startsAt = fromZonedTime(
    `${req.date}T${String(req.startHour).padStart(2, "0")}:00:00`,
    settings.timezone,
  );
  const endsAt = fromZonedTime(
    `${req.date}T${String(req.endHour).padStart(2, "0")}:00:00`,
    settings.timezone,
  );

  // Weekend, holiday, or a start time already behind "now" — none of these
  // are races, just a gap the desk side already closed and rooms had not.
  const holidays = await loadHolidays(ctx.db);
  const dateIssue = roomDateIssue(req.date, startsAt, now, holidays);
  if (dateIssue) {
    throw new BookingError("ROOM_DATE_NOT_BOOKABLE", dateIssue);
  }

  // Deduplicated, case-insensitive, and never the organiser inviting
  // themselves — they are already on the booking as its organiser.
  const attendeeEmails = [
    ...new Set((req.attendeeEmails ?? []).map((e) => e.toLowerCase().trim())),
  ].filter((e) => e !== ctx.actor.email.toLowerCase());

  let created: RoomBooking;
  let attendees: RoomBookingAttendee[] = [];
  try {
    ({ booking: created, attendees } = await ctx.db.transaction(async (tx) => {
      const [booking] = await tx
        .insert(schema.roomBookings)
        .values({
          roomId: room.id,
          startsAt,
          endsAt,
          organiserUserId: ctx.actor.id,
          title: req.title,
          status: "confirmed",
          syncStatus: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const insertedAttendees = await insertAttendees(tx, booking!.id, attendeeEmails, now);

      await enqueueNotification(tx, {
        kind: "room_confirmed",
        to: ctx.actor.email,
        roomBookingId: booking!.id,
        rendered: renderRoomNotification(
          "room_confirmed",
          {
            organiserName: ctx.actor.displayName,
            roomName: room.name,
            title: req.title,
            startsAt,
            endsAt,
          },
          settings.timezone,
        ),
      });

      await writeAudit(tx, {
        actorUserId: ctx.actor.id,
        entity: "room_bookings",
        entityId: booking!.id,
        action: "create",
        after: {
          room: room.name,
          title: req.title,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          attendeeCount: insertedAttendees.length,
        },
      });

      return { booking: booking!, attendees: insertedAttendees };
    }));
  } catch (err) {
    // 23P01 is not a bug, it is "somebody took part of that hour while you were
    // typing the meeting name". The caller refreshes the grid and says so.
    return rethrowMapped(err);
  }

  const synced = await syncOne(ctx.db, ctx.clock, created, ctx.calendar ?? defaultCalendar(), ctx.actor.id);
  return { booking: created, roomName: room.name, calendarSynced: synced, attendees };
}

/* ------------------------------------------------------------------ cancel */

export async function cancelRoomBooking(
  ctx: RoomServiceContext,
  bookingId: string,
): Promise<RoomBooking> {
  assertSignedIn(ctx.actor);
  const now = ctx.clock.now();
  const settings = await getSettings(ctx.db);

  const [existing] = await ctx.db
    .select({ booking: schema.roomBookings, roomName: schema.meetingRooms.name })
    .from(schema.roomBookings)
    .innerJoin(schema.meetingRooms, eq(schema.roomBookings.roomId, schema.meetingRooms.id))
    .where(eq(schema.roomBookings.id, bookingId))
    .limit(1);

  if (!existing) throw new BookingError("BOOKING_NOT_FOUND", "That room booking no longer exists.");
  if (existing.booking.organiserUserId !== ctx.actor.id && !ctx.actor.isAdmin) {
    throw new BookingError("FORBIDDEN", "Only the organiser can cancel that meeting.");
  }
  if (existing.booking.status !== "confirmed") {
    throw new BookingError("BOOKING_NOT_ACTIVE", "That meeting has already been cancelled.");
  }

  // Same rule desks already have, same settings value: changes close
  // `cutoffMinutes` before the meeting starts. Admins can still cancel late —
  // an operational override, not a loophole for the organiser themselves.
  if (!ctx.actor.isAdmin) {
    assertBeforeCutoff(now, existing.booking.startsAt, settings.cutoffMinutes, settings.timezone);
  }

  const cancelled = await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.roomBookings)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(
        and(eq(schema.roomBookings.id, bookingId), eq(schema.roomBookings.status, "confirmed")),
      )
      .returning();
    if (rows.length === 0) {
      throw new BookingError("BOOKING_CONFLICT", "That meeting changed while you were looking at it.");
    }

    await enqueueNotification(tx, {
      kind: "room_cancelled",
      to: ctx.actor.email,
      roomBookingId: rows[0]!.id,
      rendered: renderRoomNotification(
        "room_cancelled",
        {
          organiserName: ctx.actor.displayName,
          roomName: existing.roomName,
          title: existing.booking.title,
          startsAt: existing.booking.startsAt,
          endsAt: existing.booking.endsAt,
        },
        settings.timezone,
      ),
    });

    await writeAudit(tx, {
      actorUserId: ctx.actor.id,
      entity: "room_bookings",
      entityId: rows[0]!.id,
      action: "cancel",
      before: { status: "confirmed" },
      after: { status: "cancelled" },
    });

    return rows[0]!;
  });

  await removeFromCalendar(ctx.db, ctx.clock, cancelled, ctx.calendar ?? defaultCalendar(), ctx.actor.id);
  return cancelled;
}

/* ------------------------------------------------------- calendar plumbing */

/**
 * Pushes one booking to the calendar, recording the outcome on the row.
 *
 * Deliberately returns a boolean rather than throwing: the caller has already
 * committed a booking the user is entitled to keep, and the only correct
 * reaction to a failure here is to record it and move on.
 */
async function syncOne(
  db: Db,
  clock: Clock,
  booking: RoomBooking,
  calendar: CalendarSync,
  actorUserId: string | null,
): Promise<boolean> {
  try {
    const eventId = await calendar.upsert(booking);
    await db
      .update(schema.roomBookings)
      .set({
        calendarEventId: eventId,
        syncStatus: "synced",
        syncError: null,
        syncAttempts: booking.syncAttempts + 1,
        updatedAt: clock.now(),
      })
      .where(eq(schema.roomBookings.id, booking.id));
    await writeAudit(db, {
      actorUserId,
      entity: "room_bookings",
      entityId: booking.id,
      action: "calendar_sync",
      after: { calendarEventId: eventId },
    });
    return true;
  } catch (err) {
    await db
      .update(schema.roomBookings)
      .set({
        syncStatus: "failed",
        syncError: err instanceof Error ? err.message : String(err),
        syncAttempts: booking.syncAttempts + 1,
        updatedAt: clock.now(),
      })
      .where(eq(schema.roomBookings.id, booking.id));
    await writeAudit(db, {
      actorUserId,
      entity: "room_bookings",
      entityId: booking.id,
      action: "calendar_sync_failed",
      after: { error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}

async function removeFromCalendar(
  db: Db,
  clock: Clock,
  booking: RoomBooking,
  calendar: CalendarSync,
  _actorUserId: string | null,
): Promise<boolean> {
  if (!booking.calendarEventId) {
    // Never made it to the calendar, so there is nothing to withdraw and the
    // row is as in step with the outside world as it will ever be.
    await db
      .update(schema.roomBookings)
      .set({ syncStatus: "synced", syncError: null, updatedAt: clock.now() })
      .where(eq(schema.roomBookings.id, booking.id));
    return true;
  }
  try {
    await calendar.remove(booking.calendarEventId);
    await db
      .update(schema.roomBookings)
      .set({ syncStatus: "synced", syncError: null, updatedAt: clock.now() })
      .where(eq(schema.roomBookings.id, booking.id));
    return true;
  } catch (err) {
    await db
      .update(schema.roomBookings)
      .set({
        syncStatus: "failed",
        syncError: err instanceof Error ? err.message : String(err),
        syncAttempts: booking.syncAttempts + 1,
        updatedAt: clock.now(),
      })
      .where(eq(schema.roomBookings.id, booking.id));
    return false;
  }
}

export interface RetrySyncResult {
  attempted: number;
  synced: number;
  stillFailing: number;
}

/**
 * The retry job. Picks up everything the live path could not push.
 *
 * Covers both directions: a confirmed booking that never reached the calendar,
 * and a cancelled booking whose event is still sitting in somebody's Outlook.
 * The second is the one that would otherwise be invisible — a meeting the app
 * thinks is cancelled and Outlook still shows.
 */
export async function retryCalendarSync(options: {
  db: Db;
  clock: Clock;
  calendar?: CalendarSync;
  limit?: number;
}): Promise<RetrySyncResult> {
  const { db, clock } = options;
  const calendar = options.calendar ?? defaultCalendar();
  const rows = await db
    .select()
    .from(schema.roomBookings)
    .where(
      and(
        ne(schema.roomBookings.syncStatus, "synced"),
        or(
          eq(schema.roomBookings.status, "confirmed"),
          and(
            eq(schema.roomBookings.status, "cancelled"),
            sql`${schema.roomBookings.calendarEventId} is not null`,
          ),
        ),
      ),
    )
    .orderBy(asc(schema.roomBookings.updatedAt))
    .limit(options.limit ?? 25);

  const result: RetrySyncResult = { attempted: 0, synced: 0, stillFailing: 0 };
  for (const booking of rows) {
    result.attempted += 1;
    const ok =
      booking.status === "cancelled"
        ? await removeFromCalendar(db, clock, booking, calendar, null)
        : await syncOne(db, clock, booking, calendar, null);
    if (ok) result.synced += 1;
    else result.stillFailing += 1;
  }
  return result;
}
