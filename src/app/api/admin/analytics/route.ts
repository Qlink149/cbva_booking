import { NextResponse } from "next/server";

import { handle, routeContext } from "@/lib/api";
import { assertAdmin } from "@/lib/booking/authorise";
import { parseFilters, workingDaysBetween } from "@/lib/analytics/filters";
import {
  capacityByDaySlot,
  filterOptions,
  headline,
  heatmapByBayWeekday,
  occupancyBy,
  occupancyByDaySlot,
  occupancyByWeekday,
  seatUtilisation,
} from "@/lib/analytics/queries";
import { bookableDates, isWeekend } from "@/lib/booking-days";
import { loadHolidays } from "@/lib/holidays";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Everything the three analytics screens read, in one response.
 *
 * One round trip rather than six, because every panel on a screen has to agree:
 * a headline computed from one request and a chart from another, half a second
 * apart with a demo clock in play, is how a partner ends up looking at two
 * numbers that cannot both be true.
 *
 * `view` narrows the work rather than the meaning — the filters, the measures
 * and the capacity are identical whichever screen asked.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const ctx = await routeContext();
    assertAdmin(ctx.actor);

    const url = new URL(request.url);
    const now = ctx.clock.now();
    const today = now.toISOString().slice(0, 10);
    const f = parseFilters(url, today);
    const view = url.searchParams.get("view") ?? "trends";

    const settings = await getSettings(ctx.db);

    if (view === "today") {
      const holidays = await loadHolidays(ctx.db);

      // "Today" means the demo clock's today, not the server's — otherwise the
      // one screen a partner is watching while somebody advances the clock is
      // the one screen that does not move.
      const day = { ...f, from: today, to: today };
      const [days, capacity, byZone, byBay, byStatus] = await Promise.all([
        occupancyByDaySlot(ctx.db, day, now),
        capacityByDaySlot(ctx.db, [today], settings.slotDefinitions, f),
        occupancyBy(ctx.db, "zone", day, now),
        occupancyBy(ctx.db, "bay", day, now),
        occupancyBy(ctx.db, "status", day, now),
      ]);

      return NextResponse.json({
        view,
        now: now.toISOString(),
        today,
        // Weekends AND holidays. `isWeekend` is the same predicate
        // bookableDates uses, so "today is not bookable" means exactly what it
        // means everywhere else — a Saturday reading "the floor is entirely
        // free" is technically true and completely misleading.
        isWorkingDay: !holidays.has(today) && !isWeekend(today),
        slots: settings.slotDefinitions,
        filters: f,
        days,
        capacity,
        byZone,
        byBay,
        byStatus,
      });
    }

    if (view === "forecast") {
      const holidays = await loadHolidays(ctx.db);

      // The same function the date strip renders and the write path enforces.
      // A forecast for a day nobody can book is not a forecast.
      const dates = bookableDates({
        now,
        workingDays: settings.bookingWindowWorkingDays,
        calendarBound: settings.bookingWindowDays,
        holidays,
        timezone: settings.timezone,
      });

      const range = { ...f, from: dates[0] ?? today, to: dates[dates.length - 1] ?? today };
      const [days, capacity] = await Promise.all([
        occupancyByDaySlot(ctx.db, range, now),
        capacityByDaySlot(ctx.db, dates, settings.slotDefinitions, f),
      ]);

      return NextResponse.json({
        view,
        now: now.toISOString(),
        dates,
        slots: settings.slotDefinitions,
        filters: { ...f, from: range.from, to: range.to },
        days,
        capacity,
      });
    }

    /* ------------------------------------------------------------- trends */

    const workingDays = workingDaysBetween(f.from, f.to);
    const [
      head,
      days,
      weekday,
      byZone,
      byBay,
      byTeam,
      byStatus,
      byGrade,
      heat,
      utilisation,
      options,
    ] = await Promise.all([
      headline(ctx.db, f, now),
      occupancyByDaySlot(ctx.db, f, now),
      occupancyByWeekday(ctx.db, f, now),
      occupancyBy(ctx.db, "zone", f, now),
      occupancyBy(ctx.db, "bay", f, now),
      occupancyBy(ctx.db, "team", f, now),
      occupancyBy(ctx.db, "status", f, now),
      occupancyBy(ctx.db, "grade", f, now),
      heatmapByBayWeekday(ctx.db, f, now),
      seatUtilisation(ctx.db, f, now, settings.slotDefinitions, workingDays),
      filterOptions(ctx.db),
    ]);

    // Capacity for the whole range would be one row per day per slot, which is
    // 112 rows over eight weeks and nothing reads them individually. The two
    // ends are enough to show whether the pool moved during the period.
    const capacity = await capacityByDaySlot(
      ctx.db,
      [f.from, f.to],
      settings.slotDefinitions,
      f,
    );

    return NextResponse.json({
      view: "trends",
      now: now.toISOString(),
      filters: f,
      slots: settings.slotDefinitions,
      workingDays,
      headline: head,
      days,
      weekday,
      byZone,
      byBay,
      byTeam,
      byStatus,
      byGrade,
      heat,
      utilisation,
      capacity,
      options,
    });
  });
}
