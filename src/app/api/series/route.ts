import { NextResponse } from "next/server";
import { z } from "zod";

import { handle, parseBody, routeContext } from "@/lib/api";
import { createSeries, mySeries } from "@/lib/booking/series";
import { myReleases } from "@/lib/booking/seat-release";

export const dynamic = "force-dynamic";

/** A person's recurring bookings, and the fixed desks they have given up. */
export async function GET() {
  return handle(async () => {
    const ctx = await routeContext();
    const now = ctx.clock.now();
    const [series, releases] = await Promise.all([
      mySeries(ctx.db, ctx.actor.id, now),
      myReleases(ctx.db, ctx.actor.id, now),
    ]);
    return NextResponse.json({ now: now.toISOString(), series, releases });
  });
}

const postSchema = z.object({
  seatCode: z.string().min(2).max(16),
  slot: z.string().min(1).max(12),
  /** ISO weekdays, 1 = Monday, matching extract(isodow). */
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** Must be your own id, or omitted — see the same field on /api/bookings. */
  occupantUserId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  return handle(async () => {
    const ctx = await routeContext();
    const body = await parseBody(request, postSchema);
    const { series, firstOccurrences } = await createSeries(ctx, body);

    return NextResponse.json(
      {
        series,
        // What actually landed, and what did not. A series whose first three
        // days were already taken is a normal outcome, and saying so at
        // creation is much better than letting the person find out by looking.
        created: firstOccurrences.created,
        failed: firstOccurrences.failed,
        windowDates: firstOccurrences.windowDates,
      },
      { status: 201 },
    );
  });
}
