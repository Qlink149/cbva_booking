import { NextResponse } from "next/server";

import { bookableDays } from "@/lib/booking-days";
import { getClock } from "@/lib/clock";
import { db } from "@/lib/db";
import { loadHolidays } from "@/lib/holidays";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * The date strip and the slot definitions behind it.
 *
 * Both come from `settings`, never from constants: the working-day window
 * bounds how far ahead the strip runs and the write path enforces the same
 * list, and slot_definitions supplies the keys, labels and times — so
 * reconfiguring the firm to hourly booking changes this response with no code
 * change. "Today" comes from the Clock, so advancing the demo clock past
 * midnight moves the strip along with it.
 */
export async function GET() {
  const clock = await getClock();
  const database = db();

  const settings = await getSettings(database);
  const holidays = await loadHolidays(database);

  return NextResponse.json({
    timezone: settings.timezone,
    bookingWindowDays: settings.bookingWindowDays,
    bookingWindowWorkingDays: settings.bookingWindowWorkingDays,
    // The dialog counts down to this; it is a settings value, never a constant.
    cutoffMinutes: settings.cutoffMinutes,
    autoReleaseMinutes: settings.autoReleaseMinutes,
    days: bookableDays({
      now: clock.now(),
      workingDays: settings.bookingWindowWorkingDays,
      calendarBound: settings.bookingWindowDays,
      // `date` columns come back from pg as strings, deliberately.
      holidays,
      timezone: settings.timezone,
    }),
    slots: settings.slotDefinitions,
  });
}
