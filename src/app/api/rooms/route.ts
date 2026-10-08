import { NextResponse } from "next/server";

import { handle, routeContext } from "@/lib/api";
import { canBookMeetingRooms } from "@/lib/booking/authorise";
import { roomDay } from "@/lib/rooms/service";
import { formatInTimeZone } from "date-fns-tz";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** One day of the room grid. Defaults to today, from the shared Clock. */
export async function GET(request: Request) {
  return handle(async () => {
    const ctx = await routeContext();
    const settings = await getSettings(ctx.db);
    const requested = new URL(request.url).searchParams.get("date");
    const date =
      requested && /^\d{4}-\d{2}-\d{2}$/.test(requested)
        ? requested
        : formatInTimeZone(ctx.clock.now(), settings.timezone, "yyyy-MM-dd");

    const grid = await roomDay(ctx.db, date);
    return NextResponse.json({
      ...grid,
      now: ctx.clock.now().toISOString(),
      officeHours: settings.officeHours,
      viewerId: ctx.actor.id,
      viewerIsAdmin: ctx.actor.isAdmin,
      /** Managers and above. Everyone can view the grid; only they can book. */
      viewerCanBook: canBookMeetingRooms(ctx.actor),
    });
  });
}
