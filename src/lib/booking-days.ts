/**
 * Which days may be booked.
 *
 * One function answers this, and both the date strip and the write path call
 * it. That is deliberate: before Phase 3 the strip offered days and nothing
 * enforced them, so a hand-edited URL could book any date at all. An offer and
 * a rule that can drift apart is not a rule.
 *
 * Pure and clock-injected, so it is unit-testable and so the demo clock moves
 * the date strip along with everything else. Never reads the system clock.
 */
import { addDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

import type { BookableDay } from "@/components/floor-plan/types";
import { APP_TIMEZONE } from "@/lib/config";

/**
 * Saturday and Sunday. The firm does not book desks at the weekend.
 *
 * The weekday of a "yyyy-MM-dd" is a calendar fact, so it is read in UTC. Doing
 * it in the server's local zone would slip a day whenever the server is not in
 * Asia/Kolkata, which in practice it never is.
 */
export function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** A weekday that isn't a public holiday. One definition for desks and rooms. */
export function isWorkingDay(date: string, holidays: ReadonlySet<string>): boolean {
  return !isWeekend(date) && !holidays.has(date);
}

export interface BookingWindowOptions {
  /** "Now", from the Clock — never from the system. */
  now: Date;
  /** settings.booking_window_working_days. The rule. */
  workingDays: number;
  /**
   * settings.booking_window_days. A calendar-day ceiling on the scan, so an
   * unusual run of holidays cannot walk it forward indefinitely.
   */
  calendarBound: number;
  /** yyyy-MM-dd rows from the holidays table. */
  holidays: ReadonlySet<string>;
  timezone?: string;
}

/**
 * The authoritative list of bookable dates: today plus the next working days,
 * skipping weekends and holidays.
 *
 * Today is included even if its slots have already started — whether a
 * particular SLOT is still bookable is the cut-off's job, not the calendar's.
 */
export function bookableDates({
  now,
  workingDays,
  calendarBound,
  holidays,
  timezone = APP_TIMEZONE,
}: BookingWindowOptions): string[] {
  const out: string[] = [];
  for (let offset = 0; offset <= calendarBound && out.length < workingDays; offset += 1) {
    const date = formatInTimeZone(addDays(now, offset), timezone, "yyyy-MM-dd");
    if (!isWorkingDay(date, holidays)) continue;
    out.push(date);
  }
  return out;
}

/** Is this exact date one the product will accept a booking for? */
export function isBookableDate(date: string, options: BookingWindowOptions): boolean {
  return bookableDates(options).includes(date);
}

/** The same dates, decorated for the date strip. */
export function bookableDays(options: BookingWindowOptions): BookableDay[] {
  const timezone = options.timezone ?? APP_TIMEZONE;
  const today = formatInTimeZone(options.now, timezone, "yyyy-MM-dd");
  return bookableDates(options).map((date) => ({
    date,
    weekdayLabel: formatInTimeZone(`${date}T00:00:00Z`, "UTC", "EEE"),
    dayLabel: formatInTimeZone(`${date}T00:00:00Z`, "UTC", "d"),
    monthLabel: formatInTimeZone(`${date}T00:00:00Z`, "UTC", "MMM"),
    isToday: date === today,
  }));
}
