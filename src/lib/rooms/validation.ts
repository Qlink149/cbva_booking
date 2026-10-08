/**
 * Room booking input, rejected at the Zod layer.
 *
 * EDGE CASE 15 lives here: a range outside office hours, a zero-length range,
 * and a range that ends before it starts must all be refused before anything
 * touches the database.
 *
 * The zero-length case is not pedantry. `no_room_overlap` is an exclusion
 * constraint over `tstzrange(starts_at, ends_at, '[)')`, and an EMPTY range
 * overlaps nothing by definition — so a zero-length booking sails straight past
 * the constraint that exists to stop double-booking, and is then a perfectly
 * legal way to hold a room twice. ADR-004 added a CHECK for it at the database
 * level; this rejects it one layer earlier, with a sentence instead of a 23514.
 */
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";

import { isWeekend, isWorkingDay } from "@/lib/booking-days";
import { minutesOfDay } from "@/lib/slots";
import type { OfficeHours } from "@/lib/settings";

export interface RoomBookingRequest {
  roomId: string;
  title: string;
  /** yyyy-MM-dd in the office's timezone. */
  date: string;
  /** Whole hours, local. The grid is hourly; 9 to 11 is a two-hour meeting. */
  startHour: number;
  endHour: number;
}

/**
 * A factory rather than a constant, because "outside office hours" is a
 * settings value. Handing the schema its bounds keeps the rule in one place
 * instead of duplicating it as a second check after parsing.
 */
export function roomBookingSchema(officeHours: OfficeHours) {
  const openHour = minutesOfDay(officeHours.start) / 60;
  const closeHour = minutesOfDay(officeHours.end) / 60;

  return z
    .object({
      roomId: z.uuid("Pick a room."),
      title: z
        .string()
        .trim()
        .min(1, "Give the meeting a name so colleagues know what the room is for.")
        .max(120, "Keep the meeting name under 120 characters."),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be yyyy-MM-dd"),
      startHour: z.number().int().min(0).max(24),
      endHour: z.number().int().min(0).max(24),
    })
    .superRefine((v, ctx) => {
      if (v.endHour === v.startHour) {
        ctx.addIssue({
          code: "custom",
          path: ["endHour"],
          message: "A meeting has to be at least an hour long.",
        });
      } else if (v.endHour < v.startHour) {
        ctx.addIssue({
          code: "custom",
          path: ["endHour"],
          message: "The meeting ends before it starts.",
        });
      }
      if (v.startHour < openHour || v.endHour > closeHour) {
        ctx.addIssue({
          code: "custom",
          path: ["startHour"],
          message: `Rooms can be booked between ${officeHours.start} and ${officeHours.end}.`,
        });
      }
    });
}

export type RoomBookingSchema = ReturnType<typeof roomBookingSchema>;

/** Is "yyyy-MM-dd" a date that exists? "2099-02-30" matches the regex but isn't. */
function isRealDate(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/**
 * The first hour on `date` that can still be booked, in the firm's timezone:
 * 0 for a future date (every hour open), 24 for a past date (none open), and
 * the current hour for today. THE one definition of "this hour is over" — the
 * server refuses with it and /api/rooms sends it to the grid, so the two can't
 * drift.
 *
 * The current hour stays open, mirroring desks, which keep the current slot
 * bookable for somebody who walks in: at 10:05 the 10:00 hour is bookable,
 * 09:00 is over.
 */
export function firstOpenHour(date: string, now: Date, timezone: string): number {
  const [today, hour] = formatInTimeZone(now, timezone, "yyyy-MM-dd|H").split("|");
  if (date > today!) return 0;
  if (date < today!) return 24;
  return Number(hour);
}

/**
 * Whether a room booking's date and start hour are ones the product accepts.
 *
 * Rooms had none of the desk-side date rules: a room could be booked for a
 * weekend, a public holiday, or a time already gone (adapted from PR #4).
 * Booking an hour that is already over is a data-entry error, and it would land
 * in the room analytics as time the room was held.
 *
 * Deliberately NOT the desks' five-working-day window (ASSUMPTIONS A31).
 * Pure and clock-injected, so it's unit-testable without a database.
 */
export function roomDateIssue(
  date: string,
  startHour: number,
  now: Date,
  holidays: ReadonlySet<string>,
  timezone: string,
): string | null {
  if (!isRealDate(date)) return "That date does not exist.";
  if (!isWorkingDay(date, holidays)) {
    return isWeekend(date)
      ? "Rooms cannot be booked on a weekend."
      : "Rooms cannot be booked on a public holiday.";
  }
  if (startHour < firstOpenHour(date, now, timezone)) {
    return "That hour is already over. Choose the current hour or a later one.";
  }
  return null;
}

/** The hour columns the grid draws, from the same settings value. */
export function officeHourColumns(officeHours: OfficeHours): number[] {
  const open = minutesOfDay(officeHours.start) / 60;
  const close = minutesOfDay(officeHours.end) / 60;
  return Array.from({ length: Math.max(0, Math.ceil(close) - Math.floor(open)) }, (_, i) =>
    Math.floor(open) + i,
  );
}
