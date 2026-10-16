/**
 * The analytics reads.
 *
 * Every function here is a pure read — no writes, no authorisation of its own
 * beyond what the route does. All of them build on the expressions in
 * measures.ts rather than re-deriving occupancy, so the three measures cannot
 * drift apart between the Today screen, the Trends screen and the CSV export.
 *
 * Written as `sql` templates rather than the query builder because every one of
 * these is an aggregate with `filter (where …)` clauses, which the builder
 * cannot express without being harder to read than the SQL it produces. The
 * shapes are narrow and the parameters are all bound.
 */
import { seatCodeOrder } from "@/lib/seat-code-sql";
import { sql } from "drizzle-orm";

import {
  ATTENDED,
  BOOKED,
  autoReleased,
  cancellations,
  claims,
  desksAttended,
  desksClaimed,
  deskVerifiedAttended,
  badgeOnlyAttended,
  noShows,
  peopleAttended,
  peopleClaiming,
  seatHoursConsumed,
  seatHoursIfNoShowWereFree,
} from "./measures";
import { minutesOfDay, type SlotDefinition } from "@/lib/slots";
import { schema, type Db } from "@/lib/db";
import type {
  AnalyticsFilters, CapacityRow, DaySlotRow, DimensionRow, HeatCell, Headline,
  BookingExportRow, SeatUtilisationRow, WeekdayRow, MeasureRow,
} from "./types";

export * from "./types";

/* ------------------------------------------------------------------ filters */


/**
 * The one WHERE clause every measure shares. Filters are applied to the JOINED
 * rows, so "zone C" narrows seats and "tax team" narrows occupants — which is
 * why the seat filters and the people filter can be combined.
 */
function whereClause(f: AnalyticsFilters) {
  const parts = [sql`b.booking_date between ${f.from}::date and ${f.to}::date`];
  if (f.zone) parts.push(sql`z.code = ${f.zone}`);
  if (f.bay) parts.push(sql`s.bay = ${f.bay}`);
  if (f.team) parts.push(sql`u.team = ${f.team}`);
  if (f.slot) parts.push(sql`b.slot = ${f.slot}`);
  return sql.join(parts, sql` and `);
}

/** bookings ⋈ seats ⋈ zones ⋈ occupant. The occupant, never the booker. */
const FROM = sql`
  from bookings b
  join seats s on s.id = b.seat_id
  join zones z on z.id = s.zone_id
  join users u on u.id = b.occupant_user_id`;

/** Every measure, in one row. Reused by every grouping below. */
function measureColumns(now: Date) {
  return sql`
    ${desksClaimed}                as desks_claimed,
    ${claims}                      as claims,
    ${peopleClaiming}              as people_claiming,
    ${desksAttended}               as desks_attended,
    ${peopleAttended}              as people_attended,
    ${deskVerifiedAttended}        as desk_verified,
    ${badgeOnlyAttended}           as badge_only,
    ${noShows}                     as no_shows,
    ${autoReleased}                as auto_released,
    ${cancellations}               as cancellations,
    ${seatHoursConsumed(now)}      as seat_hours,
    ${seatHoursIfNoShowWereFree(now)} as seat_hours_no_show_free`;
}


function toMeasureRow(r: Record<string, unknown>): MeasureRow {
  return {
    desksClaimed: Number(r.desks_claimed ?? 0),
    claims: Number(r.claims ?? 0),
    peopleClaiming: Number(r.people_claiming ?? 0),
    desksAttended: Number(r.desks_attended ?? 0),
    peopleAttended: Number(r.people_attended ?? 0),
    deskVerified: Number(r.desk_verified ?? 0),
    badgeOnly: Number(r.badge_only ?? 0),
    noShows: Number(r.no_shows ?? 0),
    autoReleased: Number(r.auto_released ?? 0),
    cancellations: Number(r.cancellations ?? 0),
    seatHours: Number(r.seat_hours ?? 0),
    seatHoursNoShowFree: Number(r.seat_hours_no_show_free ?? 0),
  };
}

/* ----------------------------------------------------------------- capacity */


/**
 * Capacity per date and slot.
 *
 * Date-aware (a desk added or retired mid-period counts only while it existed),
 * blocked and decommissioned excluded, and fixed desks counted only for the
 * exact date and slot their owner released them.
 *
 * Slot length is injected from `settings.slot_definitions` as a VALUES list
 * rather than derived from `ends_at - starts_at`, for a reason that is easy to
 * miss: a slot with zero bookings has no row to derive a length from, and its
 * capacity would silently become zero — making an empty day look like a day
 * with no desks rather than a day nobody came in.
 */
export async function capacityByDaySlot(
  db: Db,
  dates: string[],
  slotDefinitions: SlotDefinition[],
  filters: Pick<AnalyticsFilters, "zone" | "bay" | "slot"> = {},
): Promise<CapacityRow[]> {
  if (dates.length === 0 || slotDefinitions.length === 0) return [];

  const wanted = filters.slot
    ? slotDefinitions.filter((d) => d.key === filters.slot)
    : slotDefinitions;
  if (wanted.length === 0) return [];

  const dateValues = sql.join(
    dates.map((d) => sql`(${d}::date)`),
    sql`, `,
  );
  const slotValues = sql.join(
    wanted.map(
      (d) =>
        sql`(${d.key}, ${((minutesOfDay(d.end) - minutesOfDay(d.start)) / 60).toFixed(4)}::numeric)`,
    ),
    sql`, `,
  );

  const seatFilters = [sql`s.status not in ('blocked','decommissioned')`];
  if (filters.zone) seatFilters.push(sql`z.code = ${filters.zone}`);
  if (filters.bay) seatFilters.push(sql`s.bay = ${filters.bay}`);

  const rows = await db.execute(sql`
    with d(day) as (values ${dateValues}),
         sl(slot, hours) as (values ${slotValues}),
         grid as (select d.day, sl.slot, sl.hours from d cross join sl)
    select
      to_char(g.day, 'YYYY-MM-DD') as date,
      g.slot,
      g.hours::float8 as slot_hours,
      count(*) filter (
        where s.status = 'bookable'
      )::int as pool,
      count(*) filter (
        where s.status = 'fixed' and r.id is not null
      )::int as released_fixed
    from grid g
    left join seats s
      on s.active_from <= g.day
     and (s.active_to is null or s.active_to >= g.day)
     and ${sql.join(seatFilters, sql` and `)}
    left join zones z on z.id = s.zone_id
    left join seat_releases r
      on r.seat_id = s.id
     and r.release_date = g.day
     and r.slot = g.slot
     and r.revoked_at is null
    group by g.day, g.slot, g.hours
    order by g.day, g.slot`);

  return (rows.rows as Record<string, unknown>[]).map((r) => {
    const pool = Number(r.pool ?? 0);
    const releasedFixed = Number(r.released_fixed ?? 0);
    const slotHours = Number(r.slot_hours ?? 0);
    return {
      date: String(r.date),
      slot: String(r.slot),
      pool,
      releasedFixed,
      capacity: pool + releasedFixed,
      slotHours,
      seatHourCapacity: Number(((pool + releasedFixed) * slotHours).toFixed(2)),
    };
  });
}

/* -------------------------------------------------------------- by day/slot */


export async function occupancyByDaySlot(
  db: Db,
  f: AnalyticsFilters,
  now: Date,
): Promise<DaySlotRow[]> {
  const rows = await db.execute(sql`
    select
      to_char(b.booking_date, 'YYYY-MM-DD') as date,
      b.slot,
      extract(isodow from b.booking_date)::int as weekday,
      ${measureColumns(now)}
    ${FROM}
    where ${whereClause(f)}
    group by b.booking_date, b.slot
    order by b.booking_date, b.slot`);

  return (rows.rows as Record<string, unknown>[]).map((r) => ({
    date: String(r.date),
    slot: String(r.slot),
    weekday: Number(r.weekday),
    ...toMeasureRow(r),
  }));
}

/* ------------------------------------------------------------- by dimension */

/** The dimensions the report can group by, and the column each one reads. */
const DIMENSIONS = {
  zone: sql`z.code`,
  bay: sql`s.bay`,
  team: sql`coalesce(u.team, 'Unassigned')`,
  weekday: sql`extract(isodow from b.booking_date)::int::text`,
  slot: sql`b.slot`,
  grade: sql`u.grade::text`,
  status: sql`b.status::text`,
} as const;

export type Dimension = keyof typeof DIMENSIONS;


export async function occupancyBy(
  db: Db,
  dimension: Dimension,
  f: AnalyticsFilters,
  now: Date,
): Promise<DimensionRow[]> {
  const col = DIMENSIONS[dimension];
  const rows = await db.execute(sql`
    select ${col} as key, ${measureColumns(now)}
    ${FROM}
    where ${whereClause(f)}
    group by ${col}
    order by ${col}`);

  return (rows.rows as Record<string, unknown>[]).map((r) => ({
    key: String(r.key ?? ""),
    ...toMeasureRow(r),
  }));
}

/* ----------------------------------------------------------------- heat map */


/**
 * Bay × weekday. The visual that makes the Monday-and-Friday argument in one
 * glance, which is the whole reason CBVA is paying for this.
 *
 * `observedDays` is returned so the UI can show a MEAN rather than a sum — a
 * period containing nine Mondays and eight Fridays would otherwise make Monday
 * look busier purely because there was more of it.
 */
export async function heatmapByBayWeekday(
  db: Db,
  f: AnalyticsFilters,
  now: Date,
): Promise<HeatCell[]> {
  /**
   * PER (bay, date, slot) FIRST, THEN AVERAGED — and this is the whole
   * correctness of the chart.
   *
   * `count(distinct seat_id)` grouped straight to (bay, weekday) counts every
   * desk that was used on ANY Monday in the period, which over eight weeks is
   * very nearly all of them. Every cell then saturates to the bay's own size
   * and the heat map renders a picture of which bays are biggest — a floor
   * plan, not a finding. The same trap as occupancyByWeekday, and it is easy to
   * fall into twice.
   *
   * `desksClaimed` here is therefore the MEAN desks in use in a single slot of
   * that weekday, which is directly comparable to the bay's desk count.
   */
  const rows = await db.execute(sql`
    with per_slot as (
      select
        s.bay,
        z.code as zone,
        b.booking_date as day,
        b.slot,
        extract(isodow from b.booking_date)::int as weekday,
        count(distinct b.seat_id) filter (where ${BOOKED}) as desks,
        count(distinct b.seat_id) filter (where ${ATTENDED}) as attended,
        ${seatHoursConsumed(now)} as hours
      ${FROM}
      where ${whereClause(f)}
      group by s.bay, z.code, b.booking_date, b.slot
    )
    select
      bay, zone, weekday,
      round(avg(desks), 2)::float8    as desks_claimed,
      round(avg(attended), 2)::float8 as desks_attended,
      round(avg(hours), 2)::float8    as seat_hours,
      count(distinct day)::int        as observed_days
    from per_slot
    group by bay, zone, weekday
    order by zone, bay, weekday`);

  return (rows.rows as Record<string, unknown>[]).map((r) => ({
    bay: String(r.bay),
    zone: String(r.zone),
    weekday: Number(r.weekday),
    desksClaimed: Number(r.desks_claimed ?? 0),
    desksAttended: Number(r.desks_attended ?? 0),
    seatHours: Number(r.seat_hours ?? 0),
    observedDays: Number(r.observed_days ?? 0),
  }));
}

/* ----------------------------------------------------------------- headline */


/**
 * The business case, in one sentence: "peak demand over 8 weeks was N desks
 * against a pool of 94."
 *
 * Peak, p95 and median are reported TOGETHER on purpose. A single maximum is
 * one anecdote and it is the number a room will anchor on; p95 is the figure
 * you would actually size a floor against, and showing both is the difference
 * between a finding and a headline.
 */
export async function headline(db: Db, f: AnalyticsFilters, now: Date): Promise<Headline> {
  void now;
  const rows = await db.execute(sql`
    with per_slot as (
      select b.booking_date as day, b.slot,
             count(distinct b.seat_id) filter (where ${BOOKED}) as desks
      ${FROM}
      where ${whereClause(f)}
      group by b.booking_date, b.slot
    )
    select
      coalesce(max(desks), 0)::int as peak,
      to_char((array_agg(day order by desks desc, day desc))[1], 'YYYY-MM-DD') as peak_date,
      (array_agg(slot order by desks desc, day desc))[1] as peak_slot,
      coalesce(percentile_disc(0.95) within group (order by desks), 0)::int as p95,
      coalesce(percentile_disc(0.50) within group (order by desks), 0)::int as median,
      count(*)::int as observed_slots
    from per_slot`);

  const r = (rows.rows[0] ?? {}) as Record<string, unknown>;
  const peakDate = r.peak_date ? String(r.peak_date) : null;

  const [poolRow] = (
    await db.execute(sql`
      select count(*)::int as pool
      from seats s
      where s.status = 'bookable'
        and s.active_from <= ${peakDate ?? f.to}::date
        and (s.active_to is null or s.active_to >= ${peakDate ?? f.to}::date)`)
  ).rows as Record<string, unknown>[];

  const [peopleRow] = (
    await db.execute(sql`
      select count(distinct b.occupant_user_id)::int as people
      ${FROM}
      where ${whereClause(f)} and ${BOOKED}`)
  ).rows as Record<string, unknown>[];

  return {
    peak: Number(r.peak ?? 0),
    peakDate,
    peakSlot: r.peak_slot ? String(r.peak_slot) : null,
    p95: Number(r.p95 ?? 0),
    median: Number(r.median ?? 0),
    pool: Number(poolRow?.pool ?? 0),
    distinctPeople: Number(peopleRow?.people ?? 0),
    observedSlots: Number(r.observed_slots ?? 0),
    from: f.from,
    to: f.to,
  };
}

/* ------------------------------------------------------------- the raw rows */


/** Every booking behind the numbers, for the CSV export. */
export async function bookingRows(
  db: Db,
  f: AnalyticsFilters,
  now: Date,
  limit = 20000,
): Promise<BookingExportRow[]> {
  const rows = await db.execute(sql`
    select
      to_char(b.booking_date, 'YYYY-MM-DD') as booking_date,
      b.slot, s.seat_code, s.bay, z.code as zone,
      u.display_name as occupant_name, u.email as occupant_email,
      u.grade::text as grade, u.team,
      b.status::text as status, b.source::text as source,
      b.checked_in_at, b.check_in_method, b.released_at, b.cancelled_at,
      greatest(0, extract(epoch from (
        least(
          case b.status
            when 'auto_released'            then coalesce(b.released_at,  b.ends_at)
            when 'cancelled_after_check_in' then coalesce(b.cancelled_at, b.starts_at)
            when 'cancelled_by_admin'       then coalesce(b.cancelled_at, b.starts_at)
            when 'cancelled_by_user'        then coalesce(b.cancelled_at, b.starts_at)
            when 'confirmed'                then ${now}::timestamptz
            when 'checked_in'               then ${now}::timestamptz
            else b.ends_at
          end, b.ends_at) - b.starts_at)) / 3600.0)::numeric(10,2) as seat_hours,
      (b.release_id is not null) as from_release,
      (b.series_id is not null) as recurring
    ${FROM}
    where ${whereClause(f)}
    order by b.booking_date desc, b.slot, ${seatCodeOrder(sql`s.seat_code`)}
    limit ${limit}`);

  return (rows.rows as Record<string, unknown>[]).map((r) => ({
    bookingDate: String(r.booking_date),
    slot: String(r.slot),
    seatCode: String(r.seat_code),
    bay: String(r.bay),
    zone: String(r.zone),
    occupantName: String(r.occupant_name),
    occupantEmail: String(r.occupant_email),
    grade: String(r.grade),
    team: r.team ? String(r.team) : null,
    status: String(r.status),
    source: String(r.source),
    checkedInAt: r.checked_in_at ? new Date(r.checked_in_at as string).toISOString() : null,
    checkInMethod: r.check_in_method ? String(r.check_in_method) : null,
    releasedAt: r.released_at ? new Date(r.released_at as string).toISOString() : null,
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at as string).toISOString() : null,
    seatHours: Number(r.seat_hours ?? 0),
    fromReleasedFixedSeat: Boolean(r.from_release),
    recurring: Boolean(r.recurring),
  }));
}

/* ------------------------------------------------------- per-seat utilisation */


/**
 * Per-desk utilisation across the period. This is the table that answers
 * "which desks could we give up" — and it is deliberately per SEAT rather than
 * per bay, because the decision CBVA has to make is about physical desks.
 */
export async function seatUtilisation(
  db: Db,
  f: AnalyticsFilters,
  now: Date,
  slotDefinitions: SlotDefinition[],
  workingDays: number,
): Promise<SeatUtilisationRow[]> {
  const slotsPerDay = f.slot ? 1 : slotDefinitions.length;
  const slotsAvailable = Math.max(workingDays * slotsPerDay, 0);

  const seatFilters = [sql`s.status <> 'decommissioned'`];
  if (f.zone) seatFilters.push(sql`z.code = ${f.zone}`);
  if (f.bay) seatFilters.push(sql`s.bay = ${f.bay}`);

  const bookingFilters = [
    sql`b.booking_date between ${f.from}::date and ${f.to}::date`,
  ];
  if (f.slot) bookingFilters.push(sql`b.slot = ${f.slot}`);
  if (f.team) bookingFilters.push(sql`bu.team = ${f.team}`);

  const rows = await db.execute(sql`
    select
      s.seat_code, s.bay, z.code as zone, s.status::text as seat_status,
      count(*) filter (where ${BOOKED})::int as slots_claimed,
      count(*) filter (where ${ATTENDED})::int as slots_attended,
      coalesce(sum(
        greatest(0, extract(epoch from (
          least(
            case b.status
              when 'auto_released'            then coalesce(b.released_at,  b.ends_at)
              when 'cancelled_after_check_in' then coalesce(b.cancelled_at, b.starts_at)
              when 'cancelled_by_admin'       then coalesce(b.cancelled_at, b.starts_at)
              when 'cancelled_by_user'        then coalesce(b.cancelled_at, b.starts_at)
              when 'confirmed'                then ${now}::timestamptz
              when 'checked_in'               then ${now}::timestamptz
              else b.ends_at
            end, b.ends_at) - b.starts_at)) / 3600.0)), 0)::numeric(10,2) as seat_hours
    from seats s
    join zones z on z.id = s.zone_id
    left join bookings b
      on b.seat_id = s.id and ${sql.join(bookingFilters, sql` and `)}
    left join users bu on bu.id = b.occupant_user_id
    where ${sql.join(seatFilters, sql` and `)}
    group by s.seat_code, s.bay, z.code, s.status
    order by z.code, s.bay, ${seatCodeOrder(sql`s.seat_code`)}`);

  return (rows.rows as Record<string, unknown>[]).map((r) => {
    const slotsClaimed = Number(r.slots_claimed ?? 0);
    return {
      seatCode: String(r.seat_code),
      bay: String(r.bay),
      zone: String(r.zone),
      seatStatus: String(r.seat_status),
      slotsClaimed,
      slotsAttended: Number(r.slots_attended ?? 0),
      seatHours: Number(r.seat_hours ?? 0),
      slotsAvailable,
      utilisationPct:
        slotsAvailable > 0 ? Number(((slotsClaimed / slotsAvailable) * 100).toFixed(1)) : 0,
    };
  });
}

/* --------------------------------------------------------------- dimensions */

/** The filter values a screen can offer, read from what actually exists. */
export async function filterOptions(db: Db): Promise<{
  zones: Array<{ code: string; displayName: string }>;
  bays: string[];
  teams: string[];
}> {
  const [zoneRows, bayRows, teamRows] = await Promise.all([
    db
      .select({ code: schema.zones.code, displayName: schema.zones.displayName })
      .from(schema.zones)
      .orderBy(schema.zones.sortOrder),
    db.execute(sql`select distinct bay from seats order by bay`),
    db.execute(sql`select distinct team from users where team is not null order by team`),
  ]);

  return {
    zones: zoneRows,
    bays: (bayRows.rows as Record<string, unknown>[]).map((r) => String(r.bay)),
    teams: (teamRows.rows as Record<string, unknown>[]).map((r) => String(r.team)),
  };
}

/* ------------------------------------------------------- weekday, correctly */


/**
 * Day-of-week pattern — the Mondays-and-Fridays-are-dead chart.
 *
 * This has to average PER DAY and cannot reuse occupancyBy("weekday"), which
 * would be quietly and badly wrong. `count(distinct seat_id)` grouped over an
 * eight-week period saturates: nearly every desk gets used on some Monday
 * eventually, so every weekday returns ~110 and the chart renders flat — hiding
 * the exact finding it exists to show.
 *
 * So: aggregate per (date, slot) first, then average those daily figures across
 * the weekday. `observedDays` is returned as well, because a period containing
 * nine Mondays and eight Fridays would otherwise let a sum favour Monday for no
 * reason but the calendar.
 */
export async function occupancyByWeekday(
  db: Db,
  f: AnalyticsFilters,
  now: Date,
): Promise<WeekdayRow[]> {
  const rows = await db.execute(sql`
    with per_day as (
      select
        b.booking_date as day,
        b.slot,
        extract(isodow from b.booking_date)::int as weekday,
        count(distinct b.seat_id) filter (where ${BOOKED}) as desks,
        count(distinct b.seat_id) filter (where ${ATTENDED}) as attended,
        ${seatHoursConsumed(now)} as hours
      ${FROM}
      where ${whereClause(f)}
      group by b.booking_date, b.slot
    )
    select
      weekday, slot,
      round(avg(desks), 1)::float8    as mean_desks,
      round(avg(attended), 1)::float8 as mean_attended,
      round(avg(hours), 1)::float8    as mean_hours,
      max(desks)::int                 as peak_desks,
      min(desks)::int                 as min_desks,
      count(*)::int                   as observed_days
    from per_day
    group by weekday, slot
    order by weekday, slot`);

  return (rows.rows as Record<string, unknown>[]).map((r) => ({
    weekday: Number(r.weekday),
    slot: String(r.slot),
    meanDesks: Number(r.mean_desks ?? 0),
    meanAttended: Number(r.mean_attended ?? 0),
    meanSeatHours: Number(r.mean_hours ?? 0),
    peakDesks: Number(r.peak_desks ?? 0),
    minDesks: Number(r.min_desks ?? 0),
    observedDays: Number(r.observed_days ?? 0),
  }));
}

