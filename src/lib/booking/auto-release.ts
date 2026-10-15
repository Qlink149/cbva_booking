/**
 * Auto-release: the rule the brief is actually about.
 *
 * A booking nobody checks into within `settings.auto_release_minutes` of its
 * start is a desk being held by somebody who is not there. Releasing it is what
 * turns booking data into occupancy data — without it every no-show inflates
 * utilisation and the partners right-size the floor against a number that
 * counts empty chairs as full ones.
 *
 * THE SHAPE OF THIS FILE IS THE CORRECTNESS ARGUMENT.
 *
 * Each transition is ONE conditional `UPDATE … RETURNING`. Everything the brief
 * asks for falls out of that:
 *
 * - **Idempotent** (edge case 2): the second run's predicate no longer matches,
 *   because the first run moved the row out of `confirmed`. Zero rows updated,
 *   zero notifications.
 * - **Safe to run concurrently**: under READ COMMITTED a second runner blocks
 *   on the row the first has locked, then re-evaluates the predicate against
 *   the committed row and finds it no longer qualifies. No advisory lock, no
 *   job table, no leader election.
 * - **Only this run notifies**: `RETURNING` hands back exactly the rows this
 *   statement transitioned, so the notification loop cannot pick up somebody
 *   else's work.
 * - **Never touches the wrong row** (edge case 4): `checked_in` and every
 *   cancelled state are outside every predicate, by name.
 *
 * And it reads `clock.now()`, never the system clock — which is what makes the
 * demo honest. Advancing the demo clock two hours makes the REAL job run the
 * REAL rule against REAL rows and really release the desk.
 *
 * THE BLAST RADIUS IS NOW BOUNDED — ASSUMPTIONS A22, closed in Phase 5.
 *
 * These were unbounded UPDATEs, which is correct when the clock is right and
 * catastrophic when it is not: a test driving the job from 2099 settled 577
 * real bookings in one run during Phase 3 and emptied the demo floor. Nothing
 * complained; it was noticed because the floor plan looked wrong afterwards.
 *
 * Three bounds now, and one of them is a deliberate design choice rather than
 * an obvious one:
 *
 * - **A batch cap that applies NOTHING when it trips**, not a partial batch. A
 *   plain `LIMIT 250` would have settled those 577 rows over three cron ticks
 *   instead of one — the same catastrophe, three minutes slower, and now
 *   indistinguishable from normal operation in the audit log. A bound that only
 *   slows a runaway down is not a bound.
 * - **A horizon**, so a backlog older than a few days is left for a human
 *   rather than settled silently. It is counted, not ignored.
 * - **A dry run**, so the cron's effect is inspectable before it is trusted.
 *
 * The cause is bounded too, upstream: `demo_offset_seconds` is CHECKed to ±30
 * days in the database and clamped at POST /api/clock. No downstream bound can
 * do that, because from a bad clock's point of view the job is behaving
 * perfectly.
 */
import { and, asc, eq, gt, gte, inArray, lte } from "drizzle-orm";

import { writeAudit, writeAuditMany } from "@/lib/audit";
import type { Clock } from "@/lib/clock";
import { schema, type Db } from "@/lib/db";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { renderSeatNotification } from "@/lib/notifications/render";
import { getSettings } from "@/lib/settings";
import type { SlotDefinition } from "@/lib/slots";

export interface AutoReleaseResult {
  /** Grace window expired while the slot was still running. Desk goes back. */
  released: number;
  /** Slot finished with nobody ever checking in. Nothing left to release. */
  markedNoShow: number;
  /** Slot finished normally after a check-in. Settles the row for analytics. */
  completed: number;
  /** Nudged halfway through the grace window, before anything was taken away. */
  remindersQueued: number;
  releasedSeatCodes: string[];
  /**
   * A transition had more candidates than the cap allows, so it applied
   * NOTHING. Surfaced on /admin/jobs and in the cron response body, not only in
   * a log line — a bound nobody sees trip is a job that has quietly stopped.
   */
  capTripped: boolean;
  cappedTransitions: Array<{
    transition: "release" | "no_show" | "complete";
    candidates: number;
    cap: number;
  }>;
  /** Older than the horizon and deliberately left alone. Visible, not ignored. */
  beyondHorizon: number;
  dryRun: boolean;
}

export interface AutoReleaseOptions {
  db: Db;
  clock: Clock;
  /**
   * Restricts the run to bookings on these desks.
   *
   * THE JOB IS GLOBAL BY DESIGN — it has to be, because it settles every
   * booking whose grace window has expired, and a per-tenant or per-floor scope
   * would just be a way to forget one. That is also a trap for tests: a spec
   * that drives it from a fixed clock set years away will settle the ENTIRE
   * seeded database, because from that clock's point of view every real booking
   * finished long ago. This is what those tests pass, and it is why it exists.
   *
   * Production never sets it.
   */
  onlySeatIds?: string[];
  /**
   * Most rows ONE transition may settle in ONE run. Defaults to
   * `settings.auto_release_batch_cap`.
   *
   * A single run legitimately settling more bookings than the floor has desks
   * is not a real workload — with 110 bookable desks and two slots, a cron that
   * has been down for a whole day settles at most ~186 in one transition. The
   * default of 250 clears that with headroom and trips on the 577-row incident.
   */
  batchCap?: number;
  /**
   * Ignore bookings whose slot ended more than this many days ago. Defaults to
   * `settings.auto_release_horizon_days`. Anything older is a backlog to be
   * settled deliberately, not silently.
   */
  horizonDays?: number;
  /** Compute what would change and change nothing. */
  dryRun?: boolean;
}

export async function runAutoRelease(options: AutoReleaseOptions): Promise<AutoReleaseResult> {
  const { db, clock, dryRun = false } = options;
  const now = clock.now();
  const settings = await getSettings(db);
  const graceMs = settings.autoReleaseMinutes * 60_000;
  const cap = options.batchCap ?? settings.autoReleaseBatchCap;
  const horizonDays = options.horizonDays ?? settings.autoReleaseHorizonDays;
  const horizonStart = new Date(now.getTime() - horizonDays * 86_400_000);
  const scope = options.onlySeatIds
    ? inArray(schema.bookings.seatId, options.onlySeatIds)
    : undefined;

  const result: AutoReleaseResult = {
    released: 0,
    markedNoShow: 0,
    completed: 0,
    remindersQueued: 0,
    releasedSeatCodes: [],
    capTripped: false,
    cappedTransitions: [],
    beyondHorizon: 0,
    dryRun,
  };

  /**
   * Select the ids this transition would settle, `cap + 1` of them so an
   * overflow is detectable in a single round trip.
   *
   * Counting first is safe here in a way a "is this seat free?" pre-check is
   * not, and the difference is worth stating: the cap is a SAFETY VALVE, not a
   * uniqueness rule. A couple of rows appearing between the count and the
   * UPDATE changes nothing that matters, whereas a row appearing between a
   * freeness check and an INSERT is a double booking. The uniqueness argument
   * still lives entirely in the `eq(status, …)` inside each UPDATE.
   */
  async function candidates(where: ReturnType<typeof and>): Promise<string[]> {
    const rows = await db
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(where)
      .orderBy(asc(schema.bookings.startsAt))
      .limit(cap + 1);
    return rows.map((r) => r.id);
  }

  function trips(
    transition: "release" | "no_show" | "complete",
    ids: string[],
  ): boolean {
    if (ids.length <= cap) return false;
    result.capTripped = true;
    result.cappedTransitions.push({ transition, candidates: ids.length, cap });
    console.error(
      `[auto-release] ${transition} matched more than ${cap} bookings and was NOT applied. ` +
        `This is the A22 bound. Check the clock (demo offset ${settings.demoOffsetSeconds}s) ` +
        `before raising the cap.`,
    );
    return true;
  }

  /* --------------------------------------------------------------- remind
   *
   * Halfway through the grace window, tell people their desk is about to go.
   *
   * Taking a desk away from somebody who simply forgot to scan is a poor
   * outcome for them and a poor number for us — it lands in the analytics as a
   * no-show, which is supposed to mean "did not come in". One nudge before the
   * release turns some of those back into real check-ins, which is the entire
   * point of measuring occupancy rather than intent.
   *
   * The window is strictly between the halfway mark and the release threshold,
   * so it cannot overlap the release below. `reminder` also carries the partial
   * unique index on (kind, booking_id, recipient_email), so a job running every
   * sixty seconds across that window sends exactly one.
   */
  result.remindersQueued = await queueReminders(
    db, now, graceMs, scope, settings.slotDefinitions, dryRun,
  );

  /* ---------------------------------------------------------------- release
   *
   * Confirmed, the grace window has expired, and the slot is STILL RUNNING.
   * The last clause is the point of edge case 3: releasing a desk for a slot
   * that already finished would be theatre — there is no remaining time for
   * anybody to use it — so that case is handled separately below.
   */
  const releaseWhere = and(
    eq(schema.bookings.status, "confirmed"),
    lte(schema.bookings.startsAt, new Date(now.getTime() - graceMs)),
    // NOTE: the horizon is deliberately NOT applied to this transition. Its
    // predicate already carries `ends_at > now`, so every candidate is by
    // definition a slot still running — nothing here can be older than the
    // horizon. Adding the clause would be dead code that looks load-bearing.
    gt(schema.bookings.endsAt, now),
    scope,
  );
  const releaseIds = await candidates(releaseWhere);

  const released =
    trips("release", releaseIds) || dryRun || releaseIds.length === 0
      ? []
      : await db
          .update(schema.bookings)
          .set({ status: "auto_released", releasedAt: now, updatedAt: now })
          .where(
            and(
              inArray(schema.bookings.id, releaseIds),
              // Load-bearing, and it must survive any future refactor: this is
              // what makes a concurrent second runner a no-op rather than a
              // double release. ADR-027.
              eq(schema.bookings.status, "confirmed"),
            ),
          )
          .returning();

  /* --------------------------------------------------------------- no-show
   *
   * EDGE CASE 3. The slot is over and nobody ever checked in. The desk is not
   * "released" — there is nothing left to give anybody — it is settled as a
   * no-show, which is the row analytics counts against the person's attendance
   * rather than against the desk's availability.
   */
  const noShowIds = await candidates(
    and(
      eq(schema.bookings.status, "confirmed"),
      lte(schema.bookings.endsAt, now),
      gte(schema.bookings.endsAt, horizonStart),
      scope,
    ),
  );
  const noShow =
    trips("no_show", noShowIds) || dryRun || noShowIds.length === 0
      ? []
      : await db
          .update(schema.bookings)
          .set({ status: "completed_no_show", releasedAt: now, updatedAt: now })
          .where(
            and(
              inArray(schema.bookings.id, noShowIds),
              eq(schema.bookings.status, "confirmed"),
            ),
          )
          .returning({ id: schema.bookings.id, seatId: schema.bookings.seatId });

  /* -------------------------------------------------------------- complete
   *
   * Somebody checked in and the slot has finished. Not in the brief's list, but
   * without it `checked_in` rows accumulate forever and the floor plan shows
   * last Tuesday as still occupied. `completed` is the terminal state that says
   * "this desk was genuinely used".
   */
  const completedIds = await candidates(
    and(
      eq(schema.bookings.status, "checked_in"),
      lte(schema.bookings.endsAt, now),
      gte(schema.bookings.endsAt, horizonStart),
      scope,
    ),
  );
  const completed =
    trips("complete", completedIds) || dryRun || completedIds.length === 0
      ? []
      : await db
          .update(schema.bookings)
          .set({ status: "completed", updatedAt: now })
          .where(
            and(
              inArray(schema.bookings.id, completedIds),
              eq(schema.bookings.status, "checked_in"),
            ),
          )
          .returning({ id: schema.bookings.id });

  /* -------------------------------------------------------------- horizon
   *
   * What was left alone because it is older than the horizon. Counted rather
   * than ignored: a backlog nobody can see is a backlog nobody clears, and
   * these rows are unsettled attendance history — exactly the data the product
   * is selling.
   */
  result.beyondHorizon = await countBeyondHorizon(db, now, horizonStart, scope);

  result.released = released.length;
  result.markedNoShow = noShow.length;
  result.completed = completed.length;

  if (dryRun) {
    // Report what WOULD have happened, having changed nothing.
    result.released = result.capTripped ? 0 : releaseIds.length;
    result.markedNoShow = result.capTripped ? 0 : noShowIds.length;
    result.completed = result.capTripped ? 0 : completedIds.length;
    return result;
  }

  if (result.capTripped) {
    await writeAudit(db, {
      actorUserId: null,
      entity: "bookings",
      entityId: null,
      action: "auto_release_capped",
      after: {
        cap,
        transitions: result.cappedTransitions,
        demoOffsetSeconds: settings.demoOffsetSeconds,
        now: now.toISOString(),
      },
    });
  }

  if (released.length > 0) {
    await notifyReleased(db, released, settings.slotDefinitions);
    result.releasedSeatCodes = await seatCodesFor(db, released.map((b) => b.seatId));
  }

  const auditRows = [
    ...released.map((b) => ({
      actorUserId: null,
      entity: "bookings" as const,
      entityId: b.id,
      action: "auto_release" as const,
      before: { status: "confirmed" },
      after: { status: "auto_released", releasedAt: now.toISOString() },
    })),
    ...noShow.map((b) => ({
      actorUserId: null,
      entity: "bookings" as const,
      entityId: b.id,
      action: "no_show" as const,
      before: { status: "confirmed" },
      after: { status: "completed_no_show" },
    })),
    ...completed.map((b) => ({
      actorUserId: null,
      entity: "bookings" as const,
      entityId: b.id,
      action: "complete" as const,
      before: { status: "checked_in" },
      after: { status: "completed" },
    })),
  ];
  await writeAuditMany(db, auditRows);

  return result;
}

/**
 * Bookings the horizon excluded: still `confirmed` or `checked_in`, with a slot
 * that ended before the horizon. A non-zero number here means somebody needs to
 * settle a backlog deliberately, through POST /api/admin/jobs/settle.
 */
async function countBeyondHorizon(
  db: Db,
  now: Date,
  horizonStart: Date,
  scope: ReturnType<typeof inArray> | undefined,
): Promise<number> {
  const rows = await db
    .select({ id: schema.bookings.id })
    .from(schema.bookings)
    .where(
      and(
        inArray(schema.bookings.status, ["confirmed", "checked_in"]),
        lte(schema.bookings.endsAt, now),
        lte(schema.bookings.endsAt, horizonStart),
        scope,
      ),
    )
    .limit(1000);
  return rows.length;
}

async function seatCodesFor(db: Db, seatIds: string[]): Promise<string[]> {
  if (seatIds.length === 0) return [];
  const rows = await db
    .select({ seatCode: schema.seats.seatCode })
    .from(schema.seats)
    .where(inArray(schema.seats.id, seatIds));
  return rows.map((r) => r.seatCode).sort();
}

/**
 * One message per released booking, to the occupant and — when somebody else
 * booked it for them — to the booker too.
 *
 * `auto_released` carries the partial unique index on
 * (kind, booking_id, recipient_email), so even if this loop were somehow
 * reached twice for the same booking the second insert is a no-op rather than a
 * duplicate email.
 */
async function notifyReleased(
  db: Db,
  released: Array<typeof schema.bookings.$inferSelect>,
  slotDefinitions: readonly SlotDefinition[],
): Promise<void> {
  const rows = await db
    .select({
      bookingId: schema.bookings.id,
      seatCode: schema.seats.seatCode,
      bay: schema.seats.bay,
      zoneCode: schema.zones.code,
      bookingDate: schema.bookings.bookingDate,
      slot: schema.bookings.slot,
      occupantEmail: schema.users.email,
      occupantName: schema.users.displayName,
      bookedByUserId: schema.bookings.bookedByUserId,
      occupantUserId: schema.bookings.occupantUserId,
    })
    .from(schema.bookings)
    .innerJoin(schema.seats, eq(schema.bookings.seatId, schema.seats.id))
    .innerJoin(schema.zones, eq(schema.seats.zoneId, schema.zones.id))
    .innerJoin(schema.users, eq(schema.bookings.occupantUserId, schema.users.id))
    .where(inArray(schema.bookings.id, released.map((b) => b.id)));

  const bookerEmails = await bookerEmailsFor(db, rows);

  for (const row of rows) {
    const slot = slotDefinitions.find((d) => d.key === row.slot) ?? {
      key: row.slot,
      label: row.slot,
      start: "",
      end: "",
    };

    const rendered = renderSeatNotification("auto_released", {
      occupantName: row.occupantName,
      bookerName: row.occupantName,
      onBehalf: false,
      seatCode: row.seatCode,
      zone: row.zoneCode,
      bay: row.bay,
      bookingDate: row.bookingDate,
      slot,
    });

    await enqueueNotification(db, {
      kind: "auto_released",
      to: row.occupantEmail,
      bookingId: row.bookingId,
      rendered,
    });

    const bookerEmail = bookerEmails.get(row.bookedByUserId);
    if (row.bookedByUserId !== row.occupantUserId && bookerEmail) {
      await enqueueNotification(db, {
        kind: "auto_released",
        to: bookerEmail,
        bookingId: row.bookingId,
        rendered,
      });
    }
  }
}

async function bookerEmailsFor(
  db: Db,
  rows: Array<{ bookedByUserId: string }>,
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.bookedByUserId))];
  if (ids.length === 0) return new Map();
  const users = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  return new Map(users.map((u) => [u.id, u.email]));
}

/**
 * One nudge per booking, halfway through its grace window.
 *
 * Deliberately a select-then-enqueue rather than an UPDATE: nothing about the
 * booking changes, so there is no status to move. Idempotency comes from the
 * database instead — `notification_log_job_kind_once` covers `reminder`, and
 * `enqueueNotification` swallows that conflict because "already queued" is the
 * right outcome for a job that runs every minute, not an error.
 */
async function queueReminders(
  db: Db,
  now: Date,
  graceMs: number,
  scope: ReturnType<typeof inArray> | undefined,
  slotDefinitions: readonly SlotDefinition[],
  dryRun: boolean,
): Promise<number> {
  const rows = await db
    .select({
      bookingId: schema.bookings.id,
      bookingDate: schema.bookings.bookingDate,
      slot: schema.bookings.slot,
      seatCode: schema.seats.seatCode,
      bay: schema.seats.bay,
      zoneCode: schema.zones.code,
      occupantEmail: schema.users.email,
      occupantName: schema.users.displayName,
    })
    .from(schema.bookings)
    .innerJoin(schema.seats, eq(schema.bookings.seatId, schema.seats.id))
    .innerJoin(schema.zones, eq(schema.seats.zoneId, schema.zones.id))
    .innerJoin(schema.users, eq(schema.bookings.occupantUserId, schema.users.id))
    .where(
      and(
        eq(schema.bookings.status, "confirmed"),
        // Past halfway...
        lte(schema.bookings.startsAt, new Date(now.getTime() - graceMs / 2)),
        // ...but not yet due for release, which the statement below handles.
        gt(schema.bookings.startsAt, new Date(now.getTime() - graceMs)),
        gt(schema.bookings.endsAt, now),
        scope,
      ),
    )
    .limit(200);

  // A dry run counts the nudges it would send and sends none. Enqueuing them
  // would be a write, and the whole point of the mode is that it is not one.
  if (dryRun) return rows.length;

  for (const row of rows) {
    const slot = slotDefinitions.find((d) => d.key === row.slot) ?? {
      key: row.slot,
      label: row.slot,
      start: "",
      end: "",
    };
    await enqueueNotification(db, {
      kind: "reminder",
      to: row.occupantEmail,
      bookingId: row.bookingId,
      rendered: renderSeatNotification("reminder", {
        occupantName: row.occupantName,
        bookerName: row.occupantName,
        onBehalf: false,
        seatCode: row.seatCode,
        zone: row.zoneCode,
        bay: row.bay,
        bookingDate: row.bookingDate,
        slot,
      }),
    });
  }
  return rows.length;
}
