import { NextResponse } from "next/server";
import { z } from "zod";

import { handle, parseBody, routeContext } from "@/lib/api";
import { createRoomBooking } from "@/lib/rooms/service";
import { dispatchSoon } from "@/lib/notifications/outbox";

export const dynamic = "force-dynamic";

/**
 * Shape only. The rules that make a range legal — office hours, zero length,
 * inverted — live in roomBookingSchema(), because they depend on settings and
 * the service has to apply them whether the call came from here or a test.
 */
const schema = z.object({
  roomId: z.uuid(),
  title: z.string().min(1).max(120),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startHour: z.number().int().min(0).max(24),
  endHour: z.number().int().min(0).max(24),
  attendeeEmails: z.array(z.string()).optional(),
});

export async function POST(request: Request) {
  return handle(async () => {
    const ctx = await routeContext();
    const body = await parseBody(request, schema);
    const result = await createRoomBooking(ctx, body);
    dispatchSoon({ db: ctx.db, clock: ctx.clock });
    return NextResponse.json(
      {
        id: result.booking.id,
        roomName: result.roomName,
        title: result.booking.title,
        startsAt: result.booking.startsAt.toISOString(),
        endsAt: result.booking.endsAt.toISOString(),
        // Surfaced deliberately: the booking is real even when this is false,
        // and the retry job will pick it up.
        calendarSynced: result.calendarSynced,
        syncStatus: result.calendarSynced ? "synced" : "failed",
        attendees: result.attendees.map((a) => ({ name: a.name, email: a.email, isStaff: a.userId !== null })),
      },
      { status: 201 },
    );
  });
}
