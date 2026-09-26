/**
 * Releasing an allocated desk back to the pool.
 *
 * WHY THIS EXISTS. 47 of the 141 desks are allocated to Manager grade and
 * above and are never bookable, so they contribute nothing to the occupancy
 * data — they are a constant, not a measurement. A partner who frees their desk
 * on a WFH day does two things at once: increases usable supply for the day,
 * and puts that desk into the analytics for the first time. It is the only
 * route by which the fixed pool is ever measured, which is why a feature that
 * looks like a courtesy is actually load-bearing for the product.
 *
 * THE RACE THAT MATTERS is not book-vs-book — `seat_slot_unique` already covers
 * that, unchanged, because it is keyed on (seat, date, slot) and says nothing
 * about seat status. It is revoke-vs-book: an owner reclaiming their desk in
 * the same moment a colleague books it. Both directions below are single
 * conditional statements against the row, never a read-then-write, for exactly
 * the reason ADR-003 gives.
 */
import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";

import { writeAudit } from "@/lib/audit";
import { assertMayReleaseSeat, assertSignedIn } from "@/lib/booking/authorise";
import { BookingError } from "@/lib/booking/errors";
import { cancelBooking, type ServiceContext } from "@/lib/booking/service";
import { assertDateBookable } from "@/lib/booking/rules";
import { schema, type Db, type DbLike } from "@/lib/db";
import { loadHolidays } from "@/lib/holidays";
import { getSettings } from "@/lib/settings";
import { deriveSlotBounds, findSlot } from "@/lib/slots";

export interface SeatReleaseRow {
  id: string;
  seatCode: string;
  bay: string;
  zone: string;
  releaseDate: string;
  slot: string;
  startsAt: string;
  endsAt: string;
  ownerUserId: string;
  ownerName: string;
  note: string | null;
  revokedAt: string | null;
  /** Who took the desk, if anybody has. Null while it is still free. */
  takenBy: {
    bookingId: string;
    occupantName: string;
    status: string;
  } | null;
}

export interface ReleaseSeatInput {
  seatCode: string;
  /** yyyy-MM-dd. Each must be inside the bookable window. */
  dates: string[];
  /** Slot keys. Omit for every slot in the current definitions — a whole day. */
  slots?: string[];
  note?: string;
}

/* --------------------------------------------------------------- the reads */

/**
 * Live releases for one date and slot, keyed by seat id.
 *
 * `/api/floor` calls this once per render and hands the result to
 * `seatVisualStatus` as a boolean. It is a Map rather than a per-seat lookup
 * because the floor route already loads all 141 seats in one query and must not
 * grow 141 more.
 */
export async function liveReleasesFor(
  db: DbLike,
  date: string,
  slot: string,
): Promise<Map<string, { id: string; ownerUserId: string }>> {
  const rows = await (db as Db)
    .select({
      id: schema.seatReleases.id,
      seatId: schema.seatReleases.seatId,
      ownerUserId: schema.seatReleases.ownerUserId,
    })
    .from(schema.seatReleases)
    .where(
      and(
        eq(schema.seatReleases.releaseDate, date),
        eq(schema.seatReleases.slot, slot),
        isNull(schema.seatReleases.revokedAt),
      ),
    );

  return new Map(rows.map((r) => [r.seatId, { id: r.id, ownerUserId: r.ownerUserId }]));
}

/**
 * Does this person hold a live release on their OWN allocated desk for this
 * date and slot? The one thing that lets a fixed-grade person book a hot desk.
 */
export async function hasReleasedOwnSeat(
  db: DbLike,
  userId: string,
  date: string,
  slot: string,
): Promise<boolean> {
  const [row] = await (db as Db)
    .select({ id: schema.seatReleases.id })
    .from(schema.seatReleases)
    .where(
      and(
        eq(schema.seatReleases.ownerUserId, userId),
        eq(schema.seatReleases.releaseDate, date),
        eq(schema.seatReleases.slot, slot),
        isNull(schema.seatReleases.revokedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

const RELEASE_ROW = sql`
  select
    r.id,
    s.seat_code,
    s.bay,
    z.code as zone,
    to_char(r.release_date, 'YYYY-MM-DD') as release_date,
    r.slot, r.starts_at, r.ends_at, r.owner_user_id, r.note, r.revoked_at,
    o.display_name as owner_name,
    b.id as booking_id,
    b.status::text as booking_status,
    bu.display_name as taken_by_name
  from seat_releases r
  join seats s on s.id = r.seat_id
  join zones z on z.id = s.zone_id
  join users o on o.id = r.owner_user_id
  left join bookings b
    on b.release_id = r.id and b.status in ('confirmed','checked_in')
  left join users bu on bu.id = b.occupant_user_id`;

function toRow(r: Record<string, unknown>): SeatReleaseRow {
  return {
    id: String(r.id),
    seatCode: String(r.seat_code),
    bay: String(r.bay),
    zone: String(r.zone),
    releaseDate: String(r.release_date),
    slot: String(r.slot),
    startsAt: new Date(r.starts_at as string).toISOString(),
    endsAt: new Date(r.ends_at as string).toISOString(),
    ownerUserId: String(r.owner_user_id),
    ownerName: String(r.owner_name),
    note: r.note ? String(r.note) : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at as string).toISOString() : null,
    takenBy: r.booking_id
      ? {
          bookingId: String(r.booking_id),
          occupantName: String(r.taken_by_name ?? "Somebody"),
          status: String(r.booking_status),
        }
      : null,
  };
}

/** A person's own releases, from `now` forward. Drives the "My desk" panel. */
export async function myReleases(
  db: Db,
  userId: string,
  from: Date,
): Promise<SeatReleaseRow[]> {
  const day = from.toISOString().slice(0, 10);
  const rows = await db.execute(sql`
    ${RELEASE_ROW}
    where r.owner_user_id = ${userId}
      and r.release_date >= ${day}::date
      and r.revoked_at is null
    order by r.release_date, r.slot`);
  return (rows.rows as Record<string, unknown>[]).map(toRow);
}

/** Every live release for a date range. Feeds the admin seat inventory. */
export async function releasesBetween(
  db: Db,
  from: string,
  to: string,
): Promise<SeatReleaseRow[]> {
  const rows = await db.execute(sql`
    ${RELEASE_ROW}
    where r.release_date between ${from}::date and ${to}::date
      and r.revoked_at is null
    order by r.release_date, s.seat_code, r.slot`);
  return (rows.rows as Record<string, unknown>[]).map(toRow);
}

/* -------------------------------------------------------------- the writes */

/**
 * Hand an allocated desk back to the pool for one or more date/slot pairs.
 *
 * Idempotent per (seat, date, slot) through `seat_release_unique` and
 * `onConflictDoNothing`: releasing the same morning twice is a no-op, not an
 * error, because the user's intent is already true.
 */
export async function releaseFixedSeat(
  ctx: ServiceContext,
  input: ReleaseSeatInput,
): Promise<SeatReleaseRow[]> {
  const { db, clock, actor } = ctx;
  assertSignedIn(actor);

  const settings = await getSettings(db);
  const now = clock.now();

  const [seat] = await db
    .select()
    .from(schema.seats)
    .where(eq(schema.seats.seatCode, input.seatCode))
    .limit(1);

  if (!seat) {
    throw new BookingError("SEAT_NOT_FOUND", "That desk is not on the floor plan.");
  }
  assertMayReleaseSeat(actor, seat);

  const holidays = await loadHolidays(db);

  const slots = input.slots?.length
    ? input.slots
    : settings.slotDefinitions.map((d) => d.key);

  // Validate everything before writing anything: a partial release across a
  // week is worse than a refusal, because the owner would believe the rest went
  // through.
  for (const date of input.dates) {
    assertDateBookable(date, now, settings, holidays);
  }
  for (const key of slots) {
    if (!findSlot(settings.slotDefinitions, key)) {
      throw new BookingError("UNKNOWN_SLOT", `${key} is not one of the current slots.`);
    }
  }

  const ownerId = seat.assignedUserId ?? actor.id;
  const created: string[] = [];

  await db.transaction(async (tx) => {
    for (const date of input.dates) {
      for (const key of slots) {
        const { startsAt, endsAt } = deriveSlotBounds(
          date,
          key,
          settings.slotDefinitions,
          settings.timezone,
        );
        const rows = await tx
          .insert(schema.seatReleases)
          .values({
            seatId: seat.id,
            releaseDate: date,
            slot: key,
            startsAt,
            endsAt,
            ownerUserId: ownerId,
            releasedByUserId: actor.id,
            note: input.note ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: schema.seatReleases.id });

        if (rows[0]) created.push(rows[0].id);
      }
    }

    if (created.length > 0) {
      await writeAudit(tx, {
        actorUserId: actor.id,
        entity: "seat_releases",
        entityId: created[0] ?? null,
        action: "release_seat",
        after: {
          seatCode: seat.seatCode,
          dates: input.dates,
          slots,
          count: created.length,
        },
      });
    }
  });

  const rows = await db.execute(sql`
    ${RELEASE_ROW}
    where r.seat_id = ${seat.id}
      and r.release_date = any(${sql.param(input.dates)}::date[])
      and r.slot = any(${sql.param(slots)}::text[])
      and r.revoked_at is null
    order by r.release_date, r.slot`);

  return (rows.rows as Record<string, unknown>[]).map(toRow);
}

export interface RevokeReleaseInput {
  releaseId: string;
  /** Admin only. Cancels whoever took the desk. */
  force?: boolean;
  reason?: string;
}

/**
 * Reclaim a released desk.
 *
 * Refused if somebody has already booked it, unless an admin forces it — the
 * same shape as ADR-025's rule for taking a desk out of service, and for the
 * same reason: refusing outright would be wrong because plans change, and doing
 * it silently would be worse because a colleague has built their day around
 * that desk. `force` is admin-only deliberately: the owner alone does not get
 * to unseat somebody.
 *
 * A forced cancellation goes through the ordinary `cancelBooking`, so it gets
 * its notification, its audit row, and status `cancelled_by_admin` — which is
 * the honest status, and is exactly why ADR-024 kept it separate from a
 * no-show. It was not the occupant's decision and must never count against them
 * in the report.
 */
export async function revokeSeatRelease(
  ctx: ServiceContext,
  input: RevokeReleaseInput,
): Promise<{ releaseId: string; cancelledBookingId: string | null }> {
  const { db, clock, actor } = ctx;
  assertSignedIn(actor);
  const now = clock.now();

  const [release] = await db
    .select()
    .from(schema.seatReleases)
    .where(eq(schema.seatReleases.id, input.releaseId))
    .limit(1);

  if (!release) {
    throw new BookingError("RELEASE_NOT_FOUND", "That release no longer exists.");
  }
  if (release.revokedAt) {
    throw new BookingError("SEAT_NOT_RELEASED", "That desk has already been reclaimed.");
  }

  const [seat] = await db
    .select()
    .from(schema.seats)
    .where(eq(schema.seats.id, release.seatId))
    .limit(1);
  assertMayReleaseSeat(actor, seat!);

  // The conditional UPDATE. It blocks on any concurrent insert holding the row
  // and then re-evaluates against the committed state, so a booking that lands
  // in the same instant is seen. Zero rows back means either already revoked or
  // somebody has it — we then read to say which, which is a message, not a
  // decision.
  const revoke = async (tx: DbLike) =>
    (tx as Db)
      .update(schema.seatReleases)
      .set({ revokedAt: now, revokedByUserId: actor.id, updatedAt: now })
      .where(
        and(
          eq(schema.seatReleases.id, release.id),
          isNull(schema.seatReleases.revokedAt),
          sql`not exists (
            select 1 from bookings b
             where b.release_id = ${release.id}
               and b.status in ('confirmed','checked_in'))`,
        ),
      )
      .returning({ id: schema.seatReleases.id });

  let cancelledBookingId: string | null = null;

  const done = await db.transaction(async (tx) => {
    const first = await revoke(tx);
    if (first.length > 0) return true;

    const [taken] = await (tx as unknown as Db)
      .select({
        id: schema.bookings.id,
        occupantUserId: schema.bookings.occupantUserId,
        occupantName: schema.users.displayName,
        occupantEmail: schema.users.email,
      })
      .from(schema.bookings)
      .innerJoin(schema.users, eq(schema.users.id, schema.bookings.occupantUserId))
      .where(
        and(
          eq(schema.bookings.releaseId, release.id),
          sql`${schema.bookings.status} in ('confirmed','checked_in')`,
        ),
      )
      .limit(1);

    if (!taken) return false; // revoked by somebody else between the two reads

    if (!input.force) {
      throw new BookingError(
        "SEAT_RELEASE_TAKEN",
        `${taken.occupantName} has already booked that desk for ${release.releaseDate}. Reclaiming it would cancel their booking.`,
        {
          bookingId: taken.id,
          occupantName: taken.occupantName,
          occupantEmail: taken.occupantEmail,
          date: release.releaseDate,
          slot: release.slot,
        },
      );
    }
    if (!actor.isAdmin) {
      throw new BookingError(
        "FORBIDDEN",
        "Only an administrator can reclaim a desk somebody has already booked.",
      );
    }

    await cancelBooking(
      { db: tx as unknown as Db, clock, actor },
      {
        bookingId: taken.id,
        force: true,
        byAdmin: true,
        reason:
          input.reason ??
          `${release.slot} on ${release.releaseDate}: the desk's allocated owner reclaimed it.`,
      },
    );
    cancelledBookingId = taken.id;

    const second = await revoke(tx);
    return second.length > 0;
  });

  if (!done) {
    throw new BookingError("SEAT_NOT_RELEASED", "That desk has already been reclaimed.");
  }

  await writeAudit(db, {
    actorUserId: actor.id,
    entity: "seat_releases",
    entityId: release.id,
    action: "revoke_release",
    before: { releaseDate: release.releaseDate, slot: release.slot },
    after: { revoked: true, cancelledBookingId, forced: Boolean(input.force) },
  });

  return { releaseId: release.id, cancelledBookingId };
}

/**
 * Revoke every live future release on a seat. Called by the seat lifecycle when
 * a desk stops being `fixed` or goes out of service — a release on a desk that
 * is no longer allocated is meaningless, and leaving it live would keep adding
 * a phantom desk to capacity.
 */
export async function revokeFutureReleasesForSeat(
  db: DbLike,
  seatId: string,
  from: Date,
  actorUserId: string | null,
): Promise<number> {
  const day = from.toISOString().slice(0, 10);
  const rows = await (db as Db)
    .update(schema.seatReleases)
    .set({ revokedAt: from, revokedByUserId: actorUserId, updatedAt: from })
    .where(
      and(
        eq(schema.seatReleases.seatId, seatId),
        gte(schema.seatReleases.releaseDate, day),
        isNull(schema.seatReleases.revokedAt),
      ),
    )
    .returning({ id: schema.seatReleases.id });
  return rows.length;
}

/** Releases that never got taken up — a real signal, and a gentle nudge. */
export async function unusedReleases(db: Db, from: string, to: string) {
  return db
    .select({
      id: schema.seatReleases.id,
      seatId: schema.seatReleases.seatId,
      releaseDate: schema.seatReleases.releaseDate,
      slot: schema.seatReleases.slot,
    })
    .from(schema.seatReleases)
    .where(
      and(
        gte(schema.seatReleases.releaseDate, from),
        sql`${schema.seatReleases.releaseDate} <= ${to}::date`,
        isNull(schema.seatReleases.revokedAt),
        sql`not exists (select 1 from bookings b where b.release_id = ${schema.seatReleases.id})`,
      ),
    )
    .orderBy(asc(schema.seatReleases.releaseDate));
}
