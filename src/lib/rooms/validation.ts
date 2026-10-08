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
import { z } from "zod";

import { isWeekend } from "@/lib/booking-days";
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

/** The room grid is hourly, so an hour is the unit a booking starts on. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * Whether a room booking's date and start are ones the product accepts.
 *
 * Rooms had none of the desk-side date rules: a room could be booked for a
 * weekend, a public holiday, or a time already gone. (Adapted from PR #4.)
 *
 * The past rule mirrors desks, which refuse only a slot that has FINISHED and
 * keep the current one open for somebody who walks in. Here the unit is an
 * hour: at 10:05 the 10:00 hour is still bookable — the room is empty right
 * now and a team wants it — but 09:00 is over and is refused. Booking an hour
 * that is already gone is a data-entry error, and it would land in the room
 * analytics as time the room was held.
 *
 * Deliberately NOT the desks' five-working-day window: nobody has asked for
 * rooms to be capped, and adding one here would be a behaviour change dressed
 * as a fix.
 *
 * Pure and clock-injected, so it's unit-testable without a database.
 */
export function roomDateIssue(
  date: string,
  startsAt: Date,
  now: Date,
  holidays: ReadonlySet<string>,
): string | null {
  if (isWeekend(date)) return "Rooms cannot be booked on a weekend.";
  if (holidays.has(date)) return "Rooms cannot be booked on a public holiday.";
  if (startsAt.getTime() + HOUR_MS <= now.getTime()) {
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
