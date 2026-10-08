import type { Metadata } from "next";

import { BookingsClient } from "@/app/bookings/bookings-client";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/adapters";
import { db, schema } from "@/lib/db";
import { getSettings } from "@/lib/settings";

export const metadata: Metadata = { title: "My Bookings" };
export const dynamic = "force-dynamic";

/**
 * Slot definitions and the cut-off are read on the server and handed down.
 *
 * They are settings, not constants, and every label and countdown on this page
 * derives from them — so a firm that switches to hourly booking gets a correct
 * page with no code change.
 */
export default async function Page() {
  const settings = await getSettings(db());

  // The viewer's allocated desk, if they have one. Read here rather than in the
  // client so the "release my desk" panel does not flash in after a round trip.
  const viewer = await auth().currentUser();
  const [allocated] = viewer?.fixedSeatId
    ? await db()
        .select({ seatCode: schema.seats.seatCode })
        .from(schema.seats)
        .where(eq(schema.seats.id, viewer.fixedSeatId))
        .limit(1)
    : [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl">My Bookings</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          The desks you have booked. Check in when you arrive — a desk nobody
          checks into within{" "}
          {settings.autoReleaseMinutes} minutes is released back to the floor.
        </p>
      </header>

      <BookingsClient
        fixedSeatCode={allocated?.seatCode ?? null}
        slots={settings.slotDefinitions}
        cutoffMinutes={settings.cutoffMinutes}
      />
    </div>
  );
}
