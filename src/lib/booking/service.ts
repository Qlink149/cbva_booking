/**
 * Booking writes.
 *
 * Every function here takes its database handle, its Clock and its actor as
 * arguments and touches nothing ambient. That is not ceremony:
 *
 * - the eighteen edge cases the brief specifies are all about timing and
 *   concurrency, and none of them is testable through HTTP with a real clock;
 * - `auth()` reads `next/headers` and throws outside a request, so a service
 *   that called it could never be tested at all;
 * - the concurrency proofs need two independent sessions on the DIRECT
 *   endpoint, which means the handle has to be a parameter.
 *
 * THE RULE THAT SHAPES THIS FILE: there is no "is this seat free?" check
 * anywhere. ADR-003 put that rule in the database because a read-then-write has
 * a race window and two people tapping Book at the same moment is exactly the
 * case that must not double-book. `23505` is an ordinary outcome here, mapped
 * to a sentence a person can act on.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { writeAudit } from "@/lib/audit";
import {
  assertMayBookFor,
  assertMayMutateBooking,
  assertSeatBookable,
} from "@/lib/booking/authorise";
import { BookingError, pgErrorInfo, rethrowMapped } from "@/lib/booking/errors";
import {
  assertBeforeCutoff,
  assertDateBookable,
  checkInOpensAt,
  requireSlot,
} from "@/lib/booking/rules";
import { hasReleasedOwnSeat, liveReleasesFor } from "@/lib/booking/seat-release";
import type { Clock } from "@/lib/clock";
import { schema, type Db, type DbLike } from "@/lib/db";
import type { Booking, Seat, User } from "@/lib/db/schema";
import { loadHolidays } from "@/lib/holidays";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { renderSeatNotification } from "@/lib/notifications/render";
import { getSettings, type AppSettings } from "@/lib/settings";
import { deriveSlotBounds, type SlotDefinition } from "@/lib/slots";

/** Booking states that hold a desk, i.e. the partial unique index predicate. */
export const ACTIVE_BOOKING_STATUSES = ["confirmed", "checked_in"] as const;

/** Statuses reached because a PERSON acted, as opposed to the job settling a row. */
const CANCELLED_BY_SOMEBODY: ReadonlySet<string> = new Set([
  "cancelled_by_user",
  "cancelled_after_check_in",
  "cancelled_by_admin",
]);

/**
 * Why a write found no row to change, phrased for the person who attempted it.
 *
 * The distinction is real and worth getting right. A booking the SYSTEM ended —
 * auto-released for want of a check-in, or settled when its slot finished — is
 * over, and "reload and try again" would be a lie. A booking somebody else
 * cancelled or moved is a conflict, and reloading is exactly the fix.
 *
 * Note what this implies about the optimistic lock. `updated_at` cannot
 * distinguish two writes that land inside the same clock tick — under a frozen
 * demo clock, every write shares an instant. The lock is a courtesy that gets
 * the message right in the common case; the thing that actually makes
 * concurrent edits safe is the conditional UPDATE inside the transaction, which
 * matches zero rows once somebody else has moved the booking out of an active
 * status. That is why both exist.
 */
function staleBookingError(status: string): BookingError {
  if (CANCELLED_BY_SOMEBODY.has(status)) {
    return new BookingError(
      "BOOKING_CONFLICT",
      "This booking was changed or cancelled while you had it open. It has been reloaded — please check it and try again.",
    );
  }
  if (status === "auto_released") {
    return new BookingError(
      "BOOKING_NOT_ACTIVE",
      "That desk was released because nobody checked in, so the booking no longer exists. Book another desk from the floor plan.",
    );
  }
  return new BookingError(
    "BOOKING_NOT_ACTIVE",
    "That booking has already finished, so it cannot be changed.",
  );
}

export type CheckInMethod = "qr" | "badge" | "app" | "admin";

export interface ServiceContext {
  db: Db;
  clock: Clock;
  actor: User;
}

/* ------------------------------------------------------------------ shared */

async function seatByCode(db: DbLike, seatCode: string) {
  const [row] = await db
    .select({
      seat: schema.seats,
      zoneCode: schema.zones.code,
    })
    .from(schema.seats)
    .innerJoin(schema.zones, eq(schema.seats.zoneId, schema.zones.id))
    .where(eq(schema.seats.seatCode, seatCode))
    .limit(1);
  return row;
}

async function userById(db: DbLike, id: string): Promise<User | undefined> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return row;
}

/**
 * The existing active booking for a person on a date and slot, if any.
 *
 * Read ONLY to explain a conflict after the database has already rejected the
 * write (edge case 10 asks for the existing booking to be shown). It is never
 * consulted beforehand to decide whether the write may proceed — that is the
 * pre-check ADR-003 forbids.
 */
async function explainOccupantConflict(
  db: DbLike,
  occupantUserId: string,
  bookingDate: string,
  slot: string,
) {
  const [row] = await db
    .select({
      id: schema.bookings.id,
      seatCode: schema.seats.seatCode,
      bay: schema.seats.bay,
      status: schema.bookings.status,
      bookingDate: schema.bookings.bookingDate,
      slot: schema.bookings.slot,
    })
    .from(schema.bookings)
    .innerJoin(schema.seats, eq(schema.bookings.seatId, schema.seats.id))
    .where(
      and(
        eq(schema.bookings.occupantUserId, occupantUserId),
        eq(schema.bookings.bookingDate, bookingDate),
        eq(schema.bookings.slot, slot),
        inArray(schema.bookings.status, [...ACTIVE_BOOKING_STATUSES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

interface NotifyArgs {
  seatCode: string;
  zone: string;
  bay: string;
  bookingDate: string;
  slot: SlotDefinition;
  occupant: User;
  booker: User;
  bookingId: string;
  reason?: string;
  previous?: { seatCode: string; bookingDate: string; slot: SlotDefinition };
}

function notifyContext(a: NotifyArgs) {
  return {
    occupantName: a.occupant.displayName,
    bookerName: a.booker.displayName,
    onBehalf: a.occupant.id !== a.booker.id,
    seatCode: a.seatCode,
    zone: a.zone,
    bay: a.bay,
    bookingDate: a.bookingDate,
    slot: a.slot,
    reason: a.reason,
    previous: a.previous,
  };
}

/* ------------------------------------------------- booking a released desk */

interface ReleaseInsert {
  release: { id: string };
  seat: Seat;
  bookingDate: string;
  slot: string;
  startsAt: Date;
  endsAt: Date;
  bookedByUserId: string;
  occupantUserId: string;
  source: "self" | "admin" | "on_behalf";
  seriesId: string | null;
  now: Date;
}

/**
 * INSERT a booking that only exists because a fixed desk was released, taking
 * the release under a row lock in the SAME statement.
 *
 * The alternative — SELECT the release, check it is live, then INSERT — has a
 * window in which the owner can reclaim the desk, and the booking would land on
 * a desk that is no longer available. `FOR UPDATE` inside the CTE means the
 * revoke path (a conditional UPDATE on the same row) blocks until this commits
 * and then re-evaluates, so the two orderings are the only two outcomes and
 * neither is wrong.
 *
 * Zero rows back means the release was revoked first. That is an ordinary
 * outcome, phrased for a person, exactly like `23505` is.
 */
async function insertAgainstRelease(tx: DbLike, args: ReleaseInsert): Promise<[Booking]> {
  const rows = await (tx as Db).execute(sql`
    with r as (
      select id from seat_releases
       where id = ${args.release.id}
         and revoked_at is null
       for update
    )
    insert into bookings (
      seat_id, booking_date, slot, starts_at, ends_at,
      booked_by_user_id, occupant_user_id, status, source,
      release_id, series_id, created_at, updated_at)
    select
      ${args.seat.id}::uuid, ${args.bookingDate}::date, ${args.slot},
      ${args.startsAt}::timestamptz, ${args.endsAt}::timestamptz,
      ${args.bookedByUserId}::uuid, ${args.occupantUserId}::uuid,
      'confirmed'::booking_status, ${args.source}::booking_source,
      r.id, ${args.seriesId}::uuid, ${args.now}::timestamptz, ${args.now}::timestamptz
    from r
    returning id`);

  const id = (rows.rows[0] as { id?: string } | undefined)?.id;
  if (!id) {
    throw new BookingError(
      "SEAT_NOT_BOOKABLE",
      `${args.seat.seatCode} was taken back by the colleague it is allocated to a moment ago. Please pick another desk.`,
    );
  }

  /**
   * Re-read through the query builder rather than `returning *`.
   *
   * `db.execute` hands back the driver's RAW rows — snake_case keys, no column
   * mapping — so `returning *` produced an object with `updated_at` rather than
   * `updatedAt`. Everything downstream reads the camelCase shape, and the one
   * that matters is `updatedAt`: it IS the optimistic lock. A booking made on a
   * released desk would have serialised `updatedAt: undefined`, and the first
   * attempt to edit it would have failed the lock comparison with a stale-row
   * error nobody could act on.
   *
   * Caught by the test asserting `releaseId` was set, which is the same bug
   * wearing a less alarming hat.
   */
  const [booking] = await (tx as Db)
    .select()
    .from(schema.bookings)
    .where(eq(schema.bookings.id, id))
    .limit(1);
  return [booking!];
}

/* ------------------------------------------------------------------ create */

export interface CreateBookingInput {
  seatCode: string;
  bookingDate: string;
  slot: string;
  /** Omit to book for yourself. */
  occupantUserId?: string;
  /**
   * Set by the recurring-booking materialiser, which reuses this function
   * rather than reimplementing it — so the window check, the slot check,
   * authorisation, the audit row and mapPgError all stay in exactly one place.
   */
  seriesId?: string;
  /**
   * The series was confirmed once, when it was created. A per-occurrence email
   * every time the booking window rolls forward would be spam, and the surest
   * way to get the whole product filtered into a folder nobody reads.
   */
  suppressNotifications?: boolean;
}

export interface BookingResult {
  booking: Booking;
  seatCode: string;
  zone: string;
  bay: string;
  slot: SlotDefinition;
  occupantName: string;
}

export async function createBooking(
  ctx: ServiceContext,
  input: CreateBookingInput,
): Promise<BookingResult> {
  const now = ctx.clock.now();
  const settings = await getSettings(ctx.db);
  const slot = requireSlot(settings, input.slot);
  const holidays = await loadHolidays(ctx.db);

  assertDateBookable(input.bookingDate, now, settings, holidays);

  const seatRow = await seatByCode(ctx.db, input.seatCode);

  // A fixed desk whose owner released it for exactly this date and slot IS
  // bookable. Read here only to produce a good error message — the INSERT below
  // re-selects the release under a row lock, so this read never authorises the
  // write. See seat-release.ts.
  const releases =
    seatRow?.seat.status === "fixed"
      ? await liveReleasesFor(ctx.db, input.bookingDate, slot.key)
      : null;
  const release = releases?.get(seatRow!.seat.id) ?? null;

  assertSeatBookable(seatRow?.seat, release);
  const seat: Seat = seatRow!.seat;
  const zone = seatRow!.zoneCode;

  const occupant =
    input.occupantUserId && input.occupantUserId !== ctx.actor.id
      ? await userById(ctx.db, input.occupantUserId)
      : ctx.actor;
  if (!occupant) {
    throw new BookingError("USER_NOT_FOUND", "That colleague is not on the staff list.");
  }
  // Somebody who gave up their own allocated desk for this slot may take a hot
  // one. Without it, releasing your desk in the morning and then changing your
  // mind leaves you with nowhere to sit and no way to book.
  const releasedOwnSeat = await hasReleasedOwnSeat(
    ctx.db,
    occupant.id,
    input.bookingDate,
    slot.key,
  );
  assertMayBookFor(ctx.actor, occupant, { hasReleasedOwnSeat: releasedOwnSeat });

  const { startsAt, endsAt } = deriveSlotBounds(
    input.bookingDate,
    slot.key,
    settings.slotDefinitions,
    settings.timezone,
  );

  /**
   * THE CUT-OFF DOES NOT GATE CREATION, deliberately.
   *
   * The brief defines it as "past the cut-off, edit and cancel are disabled".
   * Extending it to booking would break the two cases the product most needs to
   * support: somebody who came in unexpectedly and wants a desk this morning,
   * and somebody whose desk was just auto-released being told to "book another
   * desk from the floor plan" by an email they cannot act on.
   *
   * What IS refused is a slot that has already finished. Booking a desk for an
   * afternoon that is over is not a booking, it is a data-entry error, and it
   * would land in the occupancy figures as a desk somebody held.
   */
  if (now >= endsAt) {
    throw new BookingError(
      "DATE_OUTSIDE_WINDOW",
      `The ${slot.label.toLowerCase()} slot on ${input.bookingDate} has already finished.`,
    );
  }

  const source: "self" | "admin" | "on_behalf" =
    occupant.id === ctx.actor.id ? "self" : ctx.actor.isAdmin ? "admin" : "on_behalf";

  try {
    return await ctx.db.transaction(async (tx) => {
      /**
       * On a released fixed desk the INSERT re-selects the release FOR UPDATE
       * in the same statement, so there is no window between finding the desk
       * free to take and taking it. Zero rows inserted means the owner
       * reclaimed it while this request was in flight — an ordinary outcome
       * with a sentence attached, not a 500. Reading first and then inserting
       * would reintroduce exactly the race ADR-003 exists to close.
       */
      const [booking] = release
        ? await insertAgainstRelease(tx, {
            release,
            seat,
            bookingDate: input.bookingDate,
            slot: slot.key,
            startsAt,
            endsAt,
            bookedByUserId: ctx.actor.id,
            occupantUserId: occupant.id,
            source,
            seriesId: input.seriesId ?? null,
            now,
          })
        : await tx
            .insert(schema.bookings)
            .values({
              seatId: seat.id,
              bookingDate: input.bookingDate,
              slot: slot.key,
              startsAt,
              endsAt,
              bookedByUserId: ctx.actor.id,
              occupantUserId: occupant.id,
              status: "confirmed",
              source,
              seriesId: input.seriesId ?? null,
              // Always written explicitly rather than left to DEFAULT now():
              // the optimistic lock compares this value after a JSON round
              // trip, and a Postgres default carries microseconds a JS Date
              // cannot hold.
              createdAt: now,
              updatedAt: now,
            })
            .returning();

      const args: NotifyArgs = {
        seatCode: seat.seatCode,
        zone,
        bay: seat.bay,
        bookingDate: input.bookingDate,
        slot,
        occupant,
        booker: ctx.actor,
        bookingId: booking!.id,
      };

      if (!input.suppressNotifications) {
        await enqueueNotification(tx, {
          kind: "booking_confirmed",
          to: ctx.actor.email,
          bookingId: booking!.id,
          rendered: renderSeatNotification("booking_confirmed", notifyContext(args)),
        });
      }

      // The colleague gets their own message. Being given a desk without being
      // told is how a booking becomes a no-show.
      if (occupant.id !== ctx.actor.id && !input.suppressNotifications) {
        await enqueueNotification(tx, {
          kind: "booked_on_your_behalf",
          to: occupant.email,
          bookingId: booking!.id,
          rendered: renderSeatNotification("booked_on_your_behalf", notifyContext(args)),
        });
      }

      await writeAudit(tx, {
        actorUserId: ctx.actor.id,
        entity: "bookings",
        entityId: booking!.id,
        action: "create",
        after: {
          seatCode: seat.seatCode,
          bookingDate: input.bookingDate,
          slot: slot.key,
          occupantUserId: occupant.id,
          source: booking!.source,
        },
      });

      return {
        booking: booking!,
        seatCode: seat.seatCode,
        zone,
        bay: seat.bay,
        slot,
        occupantName: occupant.displayName,
      };
    });
  } catch (err) {
    await decorateOccupantConflict(err, ctx.db, occupant.id, input.bookingDate, slot.key);
    return rethrowMapped(err);
  }
}

/**
 * Adds the offending booking to an OCCUPANT_ALREADY_BOOKED error.
 *
 * Edge case 10 asks for the existing booking to be shown rather than a bare
 * refusal — "Rahul already has C3-04 that afternoon" is actionable, "conflict"
 * is not.
 */
async function decorateOccupantConflict(
  err: unknown,
  db: Db,
  occupantUserId: string,
  bookingDate: string,
  slot: string,
): Promise<void> {
  const e = pgErrorInfo(err);
  if (e?.code !== "23505" || e?.constraint !== "occupant_slot_unique") return;
  const existing = await explainOccupantConflict(db, occupantUserId, bookingDate, slot);
  throw new BookingError(
    "OCCUPANT_ALREADY_BOOKED",
    existing
      ? `There is already a desk booked for that slot: ${existing.seatCode}.`
      : "There is already a desk booked for that person in that slot.",
    { existing },
  );
}

/* -------------------------------------------------------------------- edit */

export interface EditBookingInput {
  bookingId: string;
  /** The value the client last read. The optimistic lock. */
  expectedUpdatedAt: string;
  seatCode: string;
  bookingDate: string;
  slot: string;
}

/**
 * Change date, slot or seat.
 *
 * Implemented as cancel-and-rebook inside ONE transaction, which is what keeps
 * `seat_slot_unique` protecting us. Updating the row in place would either have
 * to move it through a state where it holds neither desk, or hold both — and if
 * the new desk turns out to be taken, a rolled-back transaction leaves the
 * original booking exactly as it was. The user never ends up with nothing.
 */
export async function editBooking(
  ctx: ServiceContext,
  input: EditBookingInput,
): Promise<BookingResult> {
  const now = ctx.clock.now();
  const settings = await getSettings(ctx.db);
  const slot = requireSlot(settings, input.slot);
  const holidays = await loadHolidays(ctx.db);

  const existing = await loadBookingRow(ctx.db, input.bookingId);
  assertMayMutateBooking(ctx.actor, existing.booking);

  /**
   * The optimistic lock, checked here as well as inside the transaction.
   *
   * Both checks are needed and they say different things. This one turns "the
   * version you were looking at is not the current one" into a CONFLICT, which
   * tells the user to reload — whereas the status check below would report the
   * same situation as "no longer active", which sounds like the booking ended
   * rather than like somebody else moved it. The in-transaction check is the
   * one that actually closes the race; this one gets the message right.
   */
  if (existing.booking.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) {
    throw new BookingError(
      "BOOKING_CONFLICT",
      "Somebody else changed this booking while you had it open. It has been reloaded — please check it and try again.",
    );
  }

  if (!(["confirmed", "checked_in"] as string[]).includes(existing.booking.status)) {
    throw staleBookingError(existing.booking.status);
  }

  // Both ends of the move are gated: you may not escape a closed slot, and you
  // may not move into one that is already closed.
  assertBeforeCutoff(now, existing.booking.startsAt, settings.cutoffMinutes, settings.timezone);
  assertDateBookable(input.bookingDate, now, settings, holidays);

  const seatRow = await seatByCode(ctx.db, input.seatCode);
  // The destination desk gets the same treatment as a fresh booking: a fixed
  // desk released for that date and slot is a legal target. This is the second
  // assertSeatBookable call site and is easy to miss.
  const editReleases =
    seatRow?.seat.status === "fixed"
      ? await liveReleasesFor(ctx.db, input.bookingDate, slot.key)
      : null;
  const editRelease = editReleases?.get(seatRow!.seat.id) ?? null;

  assertSeatBookable(seatRow?.seat, editRelease);
  const seat = seatRow!.seat;
  const zone = seatRow!.zoneCode;

  const occupant = await userById(ctx.db, existing.booking.occupantUserId);
  if (!occupant) throw new BookingError("USER_NOT_FOUND", "That colleague is no longer on the list.");

  const { startsAt, endsAt } = deriveSlotBounds(
    input.bookingDate,
    slot.key,
    settings.slotDefinitions,
    settings.timezone,
  );
  assertBeforeCutoff(now, startsAt, settings.cutoffMinutes, settings.timezone);

  const previous = {
    seatCode: existing.seatCode,
    bookingDate: existing.booking.bookingDate,
    slot:
      settings.slotDefinitions.find((d) => d.key === existing.booking.slot) ?? {
        key: existing.booking.slot,
        label: existing.booking.slot,
        start: "",
        end: "",
      },
  };

  try {
    return await ctx.db.transaction(async (tx) => {
      /**
       * The optimistic lock (edge case 13).
       *
       * `date_trunc('milliseconds', …)` is load-bearing. Postgres timestamps
       * carry microseconds; the value the client echoes back has been through
       * `Date.toISOString()` and lost them. Comparing raw would make every edit
       * of a row written by DEFAULT now() fail with a spurious conflict.
       */
      const cancelled = await tx
        .update(schema.bookings)
        .set({
          status: "cancelled_by_user",
          cancelledAt: now,
          cancelledByUserId: ctx.actor.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.bookings.id, input.bookingId),
            inArray(schema.bookings.status, [...ACTIVE_BOOKING_STATUSES]),
            sql`date_trunc('milliseconds', ${schema.bookings.updatedAt}) = ${new Date(
              input.expectedUpdatedAt,
            )}`,
          ),
        )
        .returning({ id: schema.bookings.id });

      if (cancelled.length === 0) {
        // Somebody committed between the read above and this statement. Read
        // the row back so the message says what actually happened rather than
        // guessing.
        const [now_] = await tx
          .select({ status: schema.bookings.status })
          .from(schema.bookings)
          .where(eq(schema.bookings.id, input.bookingId))
          .limit(1);
        throw staleBookingError(now_?.status ?? "cancelled_by_user");
      }

      /**
       * `seriesId` is deliberately NOT carried over, and `releaseId` is not
       * either.
       *
       * An edited occurrence has detached from its series by definition — it is
       * no longer what the series says. Two things follow, and both matter:
       * the cancelled row above keeps its `seriesId` and so remains the
       * tombstone that stops the materialiser recreating this date, and the new
       * row must NOT carry the same id or it would collide with that tombstone
       * on `booking_series_occurrence_unique`. Miss this and every edit of a
       * recurring booking throws a raw index name at the user.
       *
       * The release link is dropped for the analogous reason: if the edit moved
       * the booking to a different desk or day, the old release no longer has
       * anything to do with it. Moving ONTO a released desk goes through
       * `createBooking`, which takes its own release under a lock.
       */
      const [booking] = editRelease
        ? await insertAgainstRelease(tx, {
            release: editRelease,
            seat,
            bookingDate: input.bookingDate,
            slot: slot.key,
            startsAt,
            endsAt,
            bookedByUserId: existing.booking.bookedByUserId,
            occupantUserId: existing.booking.occupantUserId,
            source: existing.booking.source,
            seriesId: null,
            now,
          })
        : await tx
            .insert(schema.bookings)
            .values({
              seatId: seat.id,
              bookingDate: input.bookingDate,
              slot: slot.key,
              startsAt,
              endsAt,
              bookedByUserId: existing.booking.bookedByUserId,
              occupantUserId: existing.booking.occupantUserId,
              status: "confirmed",
              source: existing.booking.source,
              seriesId: null,
              createdAt: now,
              updatedAt: now,
            })
            .returning();

      const args: NotifyArgs = {
        seatCode: seat.seatCode,
        zone,
        bay: seat.bay,
        bookingDate: input.bookingDate,
        slot,
        occupant,
        booker: ctx.actor,
        bookingId: booking!.id,
        previous,
      };

      await enqueueNotification(tx, {
        kind: "booking_edited",
        to: occupant.email,
        bookingId: booking!.id,
        rendered: renderSeatNotification("booking_edited", notifyContext(args)),
      });

      await writeAudit(tx, {
        actorUserId: ctx.actor.id,
        entity: "bookings",
        entityId: booking!.id,
        action: "edit",
        before: {
          bookingId: input.bookingId,
          seatCode: previous.seatCode,
          bookingDate: previous.bookingDate,
          slot: existing.booking.slot,
        },
        after: {
          seatCode: seat.seatCode,
          bookingDate: input.bookingDate,
          slot: slot.key,
        },
      });

      return {
        booking: booking!,
        seatCode: seat.seatCode,
        zone,
        bay: seat.bay,
        slot,
        occupantName: occupant.displayName,
      };
    });
  } catch (err) {
    if (err instanceof BookingError) throw err;
    await decorateOccupantConflict(err, ctx.db, existing.booking.occupantUserId, input.bookingDate, slot.key);
    return rethrowMapped(err);
  }
}

/* ------------------------------------------------------------------ cancel */

export interface CancelBookingInput {
  bookingId: string;
  /** Optional optimistic lock; omitted by admin force-cancellation. */
  expectedUpdatedAt?: string;
  /** Skips the cut-off. Admin-initiated cancellations only. */
  force?: boolean;
  /**
   * Marks the outcome as `cancelled_by_admin` rather than a user cancellation.
   * The distinction matters to analytics: "the firm took this desk away" is not
   * evidence about whether that person intended to come in.
   */
  byAdmin?: boolean;
  reason?: string;
}

export async function cancelBooking(
  ctx: ServiceContext,
  input: CancelBookingInput,
): Promise<Booking> {
  const now = ctx.clock.now();
  const settings = await getSettings(ctx.db);
  const existing = await loadBookingRow(ctx.db, input.bookingId);
  assertMayMutateBooking(ctx.actor, existing.booking);

  if (!(["confirmed", "checked_in"] as string[]).includes(existing.booking.status)) {
    throw staleBookingError(existing.booking.status);
  }

  /**
   * THE CUT-OFF DOES NOT APPLY ONCE SOMEBODY HAS CHECKED IN.
   *
   * The cut-off exists to stop a desk being dropped so late that nobody else
   * can pick it up. Somebody who has checked in and is now leaving is the
   * opposite situation: releasing the desk gives the rest of the slot back to
   * the floor, which is exactly what the product wants. Refusing it would also
   * make edge case 5 impossible, since check-in only happens after the slot has
   * started and therefore always after the cut-off.
   */
  const alreadyCheckedIn = existing.booking.status === "checked_in";
  if (!input.force && !alreadyCheckedIn) {
    assertBeforeCutoff(now, existing.booking.startsAt, settings.cutoffMinutes, settings.timezone);
  }

  /**
   * EDGE CASE 5. Cancelling after checking in is allowed — people do leave —
   * but it is a different fact from never turning up, and the occupancy report
   * must be able to separate "held a desk and used it, briefly" from "held a
   * desk and did not come". `checked_in_at` is deliberately left in place.
   *
   * An admin-initiated cancellation outranks both: whatever the occupant had
   * done, the reason the booking ended was the firm, not them.
   */
  const status = input.byAdmin
    ? "cancelled_by_admin"
    : alreadyCheckedIn
      ? "cancelled_after_check_in"
      : "cancelled_by_user";

  return ctx.db.transaction(async (tx) => {
    const conditions = [
      eq(schema.bookings.id, input.bookingId),
      inArray(schema.bookings.status, [...ACTIVE_BOOKING_STATUSES]),
    ];
    if (input.expectedUpdatedAt) {
      conditions.push(
        sql`date_trunc('milliseconds', ${schema.bookings.updatedAt}) = ${new Date(
          input.expectedUpdatedAt,
        )}`,
      );
    }

    const rows = await tx
      .update(schema.bookings)
      .set({
        status,
        cancelledAt: now,
        cancelledByUserId: ctx.actor.id,
        updatedAt: now,
      })
      .where(and(...conditions))
      .returning();

    if (rows.length === 0) {
      const [now_] = await tx
        .select({ status: schema.bookings.status })
        .from(schema.bookings)
        .where(eq(schema.bookings.id, input.bookingId))
        .limit(1);
      throw staleBookingError(now_?.status ?? "cancelled_by_user");
    }

    const occupant = await userById(tx, existing.booking.occupantUserId);
    const slot = settings.slotDefinitions.find((d) => d.key === existing.booking.slot) ?? {
      key: existing.booking.slot,
      label: existing.booking.slot,
      start: "",
      end: "",
    };

    if (occupant) {
      await enqueueNotification(tx, {
        kind: "booking_cancelled",
        to: occupant.email,
        bookingId: rows[0]!.id,
        rendered: renderSeatNotification("booking_cancelled", {
          occupantName: occupant.displayName,
          bookerName: ctx.actor.displayName,
          onBehalf: occupant.id !== ctx.actor.id,
          seatCode: existing.seatCode,
          zone: existing.zoneCode,
          bay: existing.bay,
          bookingDate: existing.booking.bookingDate,
          slot,
          reason: input.reason,
        }),
      });
      // Whoever made the booking is told too, when that is somebody else.
      if (existing.booking.bookedByUserId !== occupant.id) {
        const booker = await userById(tx, existing.booking.bookedByUserId);
        if (booker && booker.id !== ctx.actor.id) {
          await enqueueNotification(tx, {
            kind: "booking_cancelled",
            to: booker.email,
            bookingId: rows[0]!.id,
            rendered: renderSeatNotification("booking_cancelled", {
              occupantName: occupant.displayName,
              bookerName: booker.displayName,
              onBehalf: true,
              seatCode: existing.seatCode,
              zone: existing.zoneCode,
              bay: existing.bay,
              bookingDate: existing.booking.bookingDate,
              slot,
              reason: input.reason,
            }),
          });
        }
      }
    }

    await writeAudit(tx, {
      actorUserId: ctx.actor.id,
      entity: "bookings",
      entityId: rows[0]!.id,
      action: input.force ? "force_cancel" : "cancel",
      before: { status: existing.booking.status },
      after: { status, reason: input.reason ?? null },
    });

    return rows[0]!;
  });
}

/* ---------------------------------------------------------------- check-in */

export interface CheckInInput {
  bookingId?: string;
  /** The QR path: which desk somebody is actually sitting at. */
  seatCode?: string;
  /** Whose check-in this is. Defaults to the actor. */
  userId?: string;
  method: CheckInMethod;
}

export interface CheckInResult {
  booking: Booking;
  seatCode: string;
  slot: SlotDefinition;
  /** True when the booking was already checked in — the call is idempotent. */
  alreadyCheckedIn: boolean;
}

/**
 * Turns a claim into evidence.
 *
 * An un-checked-in booking is somebody saying they will come; a check-in is
 * somebody having come. PROJECT.md is explicit that analytics must keep the two
 * apart, which is why `check_in_method` is recorded: a door swipe proves
 * presence on the floor, a desk QR proves use of THAT desk.
 *
 * Idempotent by design. Scanning the QR twice, or swiping a badge and then
 * scanning, must not be an error — people will do both.
 */
export async function checkInBooking(
  ctx: ServiceContext,
  input: CheckInInput,
): Promise<CheckInResult> {
  const now = ctx.clock.now();
  const settings = await getSettings(ctx.db);
  const userId = input.userId ?? ctx.actor.id;

  if (userId !== ctx.actor.id && !ctx.actor.isAdmin) {
    throw new BookingError("FORBIDDEN", "You can only check in your own booking.");
  }

  const found = input.bookingId
    ? await loadBookingRow(ctx.db, input.bookingId)
    : await findCheckInCandidate(ctx.db, userId, input.seatCode!, now, settings);

  if (found.booking.occupantUserId !== userId && !ctx.actor.isAdmin) {
    throw new BookingError("FORBIDDEN", "That booking is not yours to check into.");
  }

  const slot = settings.slotDefinitions.find((d) => d.key === found.booking.slot) ?? {
    key: found.booking.slot,
    label: found.booking.slot,
    start: "",
    end: "",
  };

  if (found.booking.status === "checked_in") {
    return { booking: found.booking, seatCode: found.seatCode, slot, alreadyCheckedIn: true };
  }
  if (found.booking.status !== "confirmed") {
    throw new BookingError(
      "BOOKING_NOT_ACTIVE",
      found.booking.status === "auto_released"
        ? `${found.seatCode} was released because nobody checked in within ${settings.autoReleaseMinutes} minutes. Book another desk from the floor plan.`
        : "That booking is no longer active.",
    );
  }

  const opensAt = checkInOpensAt(found.booking.startsAt, settings.checkInOpensMinutesBefore);
  if (now < opensAt || now >= found.booking.endsAt) {
    throw new BookingError(
      "CHECK_IN_WINDOW_CLOSED",
      now < opensAt
        ? `Check-in for ${found.seatCode} opens ${settings.checkInOpensMinutesBefore} minutes before the slot starts.`
        : `That slot has finished, so ${found.seatCode} can no longer be checked into.`,
    );
  }

  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.bookings)
      .set({
        status: "checked_in",
        checkedInAt: now,
        checkInMethod: input.method,
        updatedAt: now,
      })
      .where(and(eq(schema.bookings.id, found.booking.id), eq(schema.bookings.status, "confirmed")))
      .returning();

    if (rows.length === 0) {
      // Somebody (or the auto-release job) moved it between the read and here.
      throw new BookingError(
        "BOOKING_NOT_ACTIVE",
        "That booking changed a moment ago and could not be checked in. Reload and try again.",
      );
    }

    await writeAudit(tx, {
      actorUserId: ctx.actor.id,
      entity: "bookings",
      entityId: rows[0]!.id,
      action: "check_in",
      after: { method: input.method, at: now.toISOString(), seatCode: found.seatCode },
    });

    return { booking: rows[0]!, seatCode: found.seatCode, slot, alreadyCheckedIn: false };
  });
}

/**
 * The QR path: given a desk and a person, which booking is this?
 *
 * Scoped to the slot that is actually running, so scanning C3-04 at 10:00 finds
 * the morning booking and not the afternoon one somebody also holds.
 */
async function findCheckInCandidate(
  db: Db,
  userId: string,
  seatCode: string,
  now: Date,
  settings: AppSettings,
) {
  const rows = await db
    .select({
      booking: schema.bookings,
      seatCode: schema.seats.seatCode,
      bay: schema.seats.bay,
      zoneCode: schema.zones.code,
    })
    .from(schema.bookings)
    .innerJoin(schema.seats, eq(schema.bookings.seatId, schema.seats.id))
    .innerJoin(schema.zones, eq(schema.seats.zoneId, schema.zones.id))
    .where(
      and(
        eq(schema.seats.seatCode, seatCode),
        eq(schema.bookings.occupantUserId, userId),
        inArray(schema.bookings.status, ["confirmed", "checked_in", "auto_released"]),
      ),
    );

  const opens = (startsAt: Date) => checkInOpensAt(startsAt, settings.checkInOpensMinutesBefore);
  const live = rows.filter((r) => now >= opens(r.booking.startsAt) && now < r.booking.endsAt);
  const chosen =
    live.find((r) => r.booking.status === "confirmed") ??
    live.find((r) => r.booking.status === "checked_in") ??
    live[0];

  if (!chosen) {
    throw new BookingError(
      "NO_BOOKING_FOR_SEAT",
      `You do not have a booking for ${seatCode} right now.`,
      { seatCode },
    );
  }
  return chosen;
}

/* ------------------------------------------------------------------ shared */

export async function loadBookingRow(db: DbLike, bookingId: string) {
  const [row] = await db
    .select({
      booking: schema.bookings,
      seatCode: schema.seats.seatCode,
      bay: schema.seats.bay,
      zoneCode: schema.zones.code,
    })
    .from(schema.bookings)
    .innerJoin(schema.seats, eq(schema.bookings.seatId, schema.seats.id))
    .innerJoin(schema.zones, eq(schema.seats.zoneId, schema.zones.id))
    .where(eq(schema.bookings.id, bookingId))
    .limit(1);
  if (!row) {
    throw new BookingError("BOOKING_NOT_FOUND", "That booking no longer exists.");
  }
  return row;
}
