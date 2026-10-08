/**
 * Recurring bookings: same desk, same slot, same weekdays, repeating.
 *
 * WHY IT IS A JOB AND NOT A LOOP AT CREATION TIME. The booking window is five
 * WORKING days and it rolls forward every day. A series that materialised
 * everything up front would either have to book outside the window — which the
 * write path correctly refuses — or stop after a week and quietly die. So the
 * job re-runs the same idempotent materialisation on every tick, and each new
 * day that enters the window gets its booking the moment it does.
 *
 * THE TOMBSTONE. There is deliberately no exceptions table and no skip list.
 * Cancelling one occurrence leaves a CANCELLED booking row still carrying
 * (series_id, booking_date, slot), and `booking_series_occurrence_unique` is
 * NOT partial on status — so the next INSERT ... ON CONFLICT DO NOTHING
 * conflicts with that row and does nothing. The cancelled row IS the record
 * that this date was deliberately skipped, which means there is no second piece
 * of state to keep in sync with reality.
 *
 * A LOST RACE IS A NOTIFICATION, NOT A FAILURE. Somebody taking the desk first
 * is the ordinary case, not an error: the job records it, emails the person
 * once, and carries on with the rest of the series. Anything that is not a
 * known BookingError is rethrown, because a bug must stay a bug.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { writeAudit } from "@/lib/audit";
import {
  assertBookingForSelf,
  assertOccupantMayBook,
  assertSignedIn,
} from "@/lib/booking/authorise";
import { BookingError, isBookingError } from "@/lib/booking/errors";
import { bookableDates } from "@/lib/booking-days";
import { cancelBooking, createBooking, type ServiceContext } from "@/lib/booking/service";
import type { Clock } from "@/lib/clock";
import { schema, type Db } from "@/lib/db";
import type { BookingSeries, User } from "@/lib/db/schema";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { renderSeatNotification } from "@/lib/notifications/render";
import { getSettings } from "@/lib/settings";
import { findSlot, type SlotDefinition } from "@/lib/slots";

/**
 * The failures the materialiser absorbs. Everything else rethrows.
 *
 * Each of these means "the world moved", not "the code is wrong": the desk went
 * to somebody else, the person already has a desk that day, the desk was taken
 * out of service, or the day fell out of the window between two ticks.
 */
const ABSORBED = new Set([
  "SEAT_TAKEN",
  "OCCUPANT_ALREADY_BOOKED",
  "SEAT_NOT_BOOKABLE",
  "SEAT_NOT_FOUND",
  "DATE_OUTSIDE_WINDOW",
  "UNKNOWN_SLOT",
  "NOT_BOOKABLE_GRADE",
  "OCCUPANT_INACTIVE",
  "BOOKING_CONFLICT",
]);

export interface SeriesFailure {
  seriesId: string;
  occupantUserId: string;
  occupantName: string;
  bookingDate: string;
  slot: string;
  seatCode: string;
  code: string;
  message: string;
}

export interface MaterialiseResult {
  /** The dates currently inside the booking window. */
  windowDates: string[];
  seriesConsidered: number;
  occurrencesConsidered: number;
  created: number;
  /** Already there, or deliberately cancelled — the tombstone did its job. */
  skippedExisting: number;
  failed: SeriesFailure[];
  notified: number;
  /** Legacy series set up on somebody's behalf, ended this run (see below). */
  legacyOnBehalfEnded: number;
  dryRun: boolean;
}

export interface MaterialiseOptions {
  db: Db;
  clock: Clock;
  dryRun?: boolean;
  /** Tests, and the immediate materialisation when a series is created. */
  onlySeriesIds?: string[];
  /** Blast-radius bound, same reasoning as auto-release. */
  maxPerRun?: number;
}

/**
 * Create the bookings a series implies, for every date now inside the window.
 *
 * DETERMINISM. The window comes from `bookableDates()` — the SAME function the
 * date strip renders and `assertDateBookable` enforces — so the job books
 * exactly the days a person can see, and weekends and holidays are skipped for
 * free rather than by a second copy of the rule. Series are processed in
 * (created_at, id) order and dates ascending, so two series competing for one
 * desk resolve first-created-wins, reproducibly, from the injected clock.
 *
 * IDEMPOTENCE comes from the unique index, not from a watermark. A "last run
 * at" column would be wrong the first time somebody winds the demo clock
 * backwards, which is a thing this product invites them to do.
 */
export async function materialiseSeries(
  options: MaterialiseOptions,
): Promise<MaterialiseResult> {
  const { db, clock, dryRun = false, onlySeriesIds, maxPerRun = 500 } = options;
  const now = clock.now();
  const settings = await getSettings(db);

  const holidayRows = await db.select({ d: schema.holidays.holidayDate }).from(schema.holidays);
  const holidays = new Set(holidayRows.map((h) => h.d));

  const windowDates = bookableDates({
    now,
    workingDays: settings.bookingWindowWorkingDays,
    calendarBound: settings.bookingWindowDays,
    holidays,
    timezone: settings.timezone,
  });

  const result: MaterialiseResult = {
    windowDates,
    seriesConsidered: 0,
    occurrencesConsidered: 0,
    created: 0,
    skippedExisting: 0,
    failed: [],
    notified: 0,
    legacyOnBehalfEnded: 0,
    dryRun,
  };
  if (windowDates.length === 0) return result;

  const where = onlySeriesIds?.length
    ? and(
        eq(schema.bookingSeries.status, "active"),
        inArray(schema.bookingSeries.id, onlySeriesIds),
      )
    : eq(schema.bookingSeries.status, "active");

  const rows = await db
    .select({
      series: schema.bookingSeries,
      seatCode: schema.seats.seatCode,
      occupant: schema.users,
    })
    .from(schema.bookingSeries)
    .innerJoin(schema.seats, eq(schema.seats.id, schema.bookingSeries.seatId))
    .innerJoin(schema.users, eq(schema.users.id, schema.bookingSeries.occupantUserId))
    .where(where)
    .orderBy(asc(schema.bookingSeries.createdAt), asc(schema.bookingSeries.id));

  result.seriesConsidered = rows.length;

  for (const { series, seatCode, occupant } of rows) {
    // The actor is the person who set the series up, loaded fresh — so the
    // audit row names a real person rather than a null job actor, and the
    // same book-for-yourself rule applies to every occurrence.
    const creator = await loadUser(db, series.createdByUserId);
    if (!creator) continue;

    /**
     * A series set up on somebody's behalf before that was removed (Oct 2026).
     * None existed at removal. If one turns up, END it, once — never book
     * from it, and never fail it per occurrence: that would rerun the whole
     * booking path every tick, and email the occupant a false "the desk was
     * taken" for every new date, forever.
     */
    if (series.createdByUserId !== series.occupantUserId) {
      if (!dryRun) {
        await db
          .update(schema.bookingSeries)
          .set({ status: "ended", updatedAt: clock.now() })
          .where(eq(schema.bookingSeries.id, series.id));
        await writeAudit(db, {
          actorUserId: null,
          entity: "booking_series",
          entityId: series.id,
          action: "cancel_series",
          before: { status: series.status },
          after: { status: "ended", reason: "booking on behalf was removed" },
        });
      }
      result.legacyOnBehalfEnded += 1;
      continue;
    }

    for (const date of windowDates) {
      if (result.created >= maxPerRun) break;
      if (!matchesSeries(series, date)) continue;
      result.occurrencesConsidered += 1;

      // The tombstone check. A row here means the date is either already booked
      // or was deliberately cancelled, and both mean "do nothing".
      const existing = await db
        .select({ id: schema.bookings.id })
        .from(schema.bookings)
        .where(
          and(
            eq(schema.bookings.seriesId, series.id),
            eq(schema.bookings.bookingDate, date),
            eq(schema.bookings.slot, series.slot),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        result.skippedExisting += 1;
        continue;
      }

      if (dryRun) {
        result.created += 1;
        continue;
      }

      try {
        await createBooking(
          { db, clock, actor: creator },
          {
            seatCode,
            bookingDate: date,
            slot: series.slot,
            occupantUserId: series.occupantUserId,
            seriesId: series.id,
            // The series was confirmed once, when it was set up. An email every
            // time the window rolls forward is how a product gets muted.
            suppressNotifications: true,
          },
        );
        result.created += 1;
      } catch (err) {
        if (!isBookingError(err) || !ABSORBED.has(err.code)) throw err;

        const failure: SeriesFailure = {
          seriesId: series.id,
          occupantUserId: series.occupantUserId,
          occupantName: occupant.displayName,
          bookingDate: date,
          slot: series.slot,
          seatCode,
          code: err.code,
          message: err.message,
        };
        result.failed.push(failure);
        result.notified += (await notifyFailure(
          db,
          settings.slotDefinitions,
          failure,
          occupant,
        ))
          ? 1
          : 0;
      }
    }
  }

  /**
   * Audit only when something actually CHANGED.
   *
   * `failed` is not a change — a series whose desk is permanently taken fails
   * on every tick, so auditing on it wrote an identical row every five minutes
   * forever: ~288 a day of pure noise in the log an admin opens precisely to
   * find out what happened. `notified` counts rows the once-only index actually
   * accepted, so a NEW failure is still recorded exactly once.
   */
  if (!dryRun && (result.created > 0 || result.notified > 0)) {
    await writeAudit(db, {
      actorUserId: null,
      entity: "booking_series",
      entityId: null,
      action: "materialise",
      after: {
        created: result.created,
        failed: result.failed.length,
        skipped: result.skippedExisting,
        window: [windowDates[0], windowDates[windowDates.length - 1]],
      },
    });
  }

  return result;
}

/** ISO weekday of a yyyy-MM-dd string, 1 = Monday, matching Postgres isodow. */
function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const js = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return js === 0 ? 7 : js;
}

function matchesSeries(series: BookingSeries, date: string): boolean {
  if (date < series.startsOn) return false;
  if (series.endsOn && date > series.endsOn) return false;
  return series.weekdays.includes(isoWeekday(date));
}

async function loadUser(db: Db, id: string): Promise<User | null> {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return u ?? null;
}

/**
 * One message per failed occurrence, ever. The unique index in 0003 keyed on
 * (kind, series_id, occurrence_date, recipient_email) is what makes "ever"
 * true — the cron runs every five minutes and would otherwise send the same
 * apology 288 times a day.
 */
async function notifyFailure(
  db: Db,
  slotDefinitions: SlotDefinition[],
  failure: SeriesFailure,
  occupant: User,
): Promise<boolean> {
  const slot = findSlot(slotDefinitions, failure.slot) ?? {
    key: failure.slot,
    label: failure.slot,
    start: "",
    end: "",
  };

  return enqueueNotification(db, {
    kind: "series_occurrence_failed",
    to: occupant.email,
    seriesId: failure.seriesId,
    occurrenceDate: failure.bookingDate,
    rendered: renderSeatNotification("series_occurrence_failed", {
      seatCode: failure.seatCode,
      zone: "",
      bay: "",
      bookingDate: failure.bookingDate,
      slot,
      occupantName: occupant.displayName,
      bookerName: occupant.displayName,
      onBehalf: false,
    }),
  });
}

/* ------------------------------------------------------------- the writes */

export interface CreateSeriesInput {
  seatCode: string;
  slot: string;
  /** ISO weekdays, 1 = Monday. */
  weekdays: number[];
  startsOn: string;
  endsOn?: string | null;
  occupantUserId?: string;
}

export async function createSeries(
  ctx: ServiceContext,
  input: CreateSeriesInput,
): Promise<{ series: BookingSeries; firstOccurrences: MaterialiseResult }> {
  const { db, clock, actor } = ctx;
  assertSignedIn(actor);
  // Before any lookup — see assertBookingForSelf.
  assertBookingForSelf(actor, input.occupantUserId);
  const occupant = actor;

  const settings = await getSettings(db);
  if (!findSlot(settings.slotDefinitions, input.slot)) {
    throw new BookingError("UNKNOWN_SLOT", `${input.slot} is not one of the current slots.`);
  }
  const weekdays = [...new Set(input.weekdays)].sort((a, b) => a - b);
  if (weekdays.length === 0 || weekdays.some((d) => d < 1 || d > 7)) {
    throw new BookingError("SERIES_INVALID", "Pick at least one day of the week.");
  }
  if (input.endsOn && input.endsOn < input.startsOn) {
    throw new BookingError("SERIES_INVALID", "The end date is before the start date.");
  }

  const [seat] = await db
    .select()
    .from(schema.seats)
    .where(eq(schema.seats.seatCode, input.seatCode))
    .limit(1);
  if (!seat) throw new BookingError("SEAT_NOT_FOUND", "That desk is not on the floor plan.");

  // Authorised once, here, on the same rules a single booking uses. The
  // materialiser re-checks per occurrence anyway because a grade or a seat
  // allocation can change between now and next Thursday.
  assertOccupantMayBook(occupant);

  const [series] = await db
    .insert(schema.bookingSeries)
    .values({
      occupantUserId: occupant.id,
      createdByUserId: actor.id,
      seatId: seat.id,
      slot: input.slot,
      weekdays,
      startsOn: input.startsOn,
      endsOn: input.endsOn ?? null,
      status: "active",
      createdAt: clock.now(),
      updatedAt: clock.now(),
    })
    .returning();

  await writeAudit(db, {
    actorUserId: actor.id,
    entity: "booking_series",
    entityId: series!.id,
    action: "create_series",
    after: {
      seatCode: seat.seatCode,
      slot: input.slot,
      weekdays,
      startsOn: input.startsOn,
      endsOn: input.endsOn ?? null,
      occupantUserId: occupant.id,
    },
  });

  // Materialise immediately so the person sees their bookings appear rather
  // than wondering whether it worked until the next cron tick.
  const firstOccurrences = await materialiseSeries({
    db,
    clock,
    onlySeriesIds: [series!.id],
  });

  return { series: series!, firstOccurrences };
}

export interface CancelSeriesInput {
  seriesId: string;
  /** yyyy-MM-dd. Occurrences from this date forward are dropped. */
  from: string;
  /** Also cancel the bookings already materialised from `from` onwards. */
  cancelFutureOccurrences?: boolean;
}

export async function cancelSeries(
  ctx: ServiceContext,
  input: CancelSeriesInput,
): Promise<{ seriesId: string; cancelledBookingIds: string[] }> {
  const { db, clock, actor } = ctx;
  assertSignedIn(actor);

  const [series] = await db
    .select()
    .from(schema.bookingSeries)
    .where(eq(schema.bookingSeries.id, input.seriesId))
    .limit(1);
  if (!series) throw new BookingError("SERIES_NOT_FOUND", "That recurring booking is gone.");

  const mine =
    series.occupantUserId === actor.id || series.createdByUserId === actor.id || actor.isAdmin;
  if (!mine) {
    throw new BookingError("FORBIDDEN", "That is not your recurring booking to change.");
  }

  const cancelledBookingIds: string[] = [];

  if (input.cancelFutureOccurrences) {
    const future = await db
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(
        and(
          eq(schema.bookings.seriesId, series.id),
          sql`${schema.bookings.bookingDate} >= ${input.from}::date`,
          inArray(schema.bookings.status, ["confirmed", "checked_in"]),
        ),
      );

    // Through the ordinary cancel path, so each one gets its notification, its
    // audit row and the right status — ADR-025's precedent.
    for (const b of future) {
      await cancelBooking(ctx, { bookingId: b.id, force: true, reason: "Recurring booking ended." });
      cancelledBookingIds.push(b.id);
    }
  }

  /**
   * Clamped to `startsOn`, because `booking_series_range_valid` rejects an end
   * before the start — and cancelling from the very first day is the ordinary
   * case, not an edge one. Somebody who sets a series up and immediately thinks
   * better of it would otherwise get a raw CHECK violation.
   *
   * `status = 'ended'` is what actually stops the materialiser; `endsOn` is
   * bookkeeping that records how far the series was ever meant to run.
   */
  const endsOn =
    shiftDay(input.from, -1) < series.startsOn ? series.startsOn : shiftDay(input.from, -1);

  await db
    .update(schema.bookingSeries)
    .set({ status: "ended", endsOn, updatedAt: clock.now() })
    .where(eq(schema.bookingSeries.id, series.id));

  await writeAudit(db, {
    actorUserId: actor.id,
    entity: "booking_series",
    entityId: series.id,
    action: "cancel_series",
    before: { status: series.status, endsOn: series.endsOn },
    after: { status: "ended", endsOn, cancelledBookingIds },
  });

  return { seriesId: series.id, cancelledBookingIds };
}

function shiftDay(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!) + days * 86400000);
  return t.toISOString().slice(0, 10);
}

/* --------------------------------------------------------------- the reads */

export interface SeriesRow {
  id: string;
  seatCode: string;
  bay: string;
  zone: string;
  slot: string;
  weekdays: number[];
  startsOn: string;
  endsOn: string | null;
  status: string;
  occupantUserId: string;
  occupantName: string;
  /** Materialised bookings still ahead, so the UI can say "next: Thursday". */
  upcoming: Array<{ bookingDate: string; status: string }>;
}

export async function mySeries(db: Db, userId: string, from: Date): Promise<SeriesRow[]> {
  const day = from.toISOString().slice(0, 10);
  const rows = await db.execute(sql`
    select
      bs.id, s.seat_code, s.bay, z.code as zone, bs.slot, bs.weekdays,
      to_char(bs.starts_on, 'YYYY-MM-DD') as starts_on,
      to_char(bs.ends_on,  'YYYY-MM-DD')  as ends_on,
      bs.status, bs.occupant_user_id, u.display_name as occupant_name,
      coalesce(
        (select json_agg(json_build_object(
                  'bookingDate', to_char(b.booking_date, 'YYYY-MM-DD'),
                  'status', b.status::text) order by b.booking_date)
           from bookings b
          where b.series_id = bs.id
            and b.booking_date >= ${day}::date
            and b.status in ('confirmed','checked_in')),
        '[]'::json) as upcoming
    from booking_series bs
    join seats s on s.id = bs.seat_id
    join zones z on z.id = s.zone_id
    join users u on u.id = bs.occupant_user_id
    where (bs.occupant_user_id = ${userId} or bs.created_by_user_id = ${userId})
      and bs.status <> 'ended'
    order by bs.created_at desc`);

  return (rows.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    seatCode: String(r.seat_code),
    bay: String(r.bay),
    zone: String(r.zone),
    slot: String(r.slot),
    weekdays: (r.weekdays as number[]) ?? [],
    startsOn: String(r.starts_on),
    endsOn: r.ends_on ? String(r.ends_on) : null,
    status: String(r.status),
    occupantUserId: String(r.occupant_user_id),
    occupantName: String(r.occupant_name),
    upcoming: (r.upcoming as Array<{ bookingDate: string; status: string }>) ?? [],
  }));
}
