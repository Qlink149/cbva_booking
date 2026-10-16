import { compareSeatCodes } from "@/lib/seat-code";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/adapters";
import { serverEnv } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { floorplanSeatAnchors, seatAnchor } from "@/lib/floorplan";
import type { SeatAnchor } from "@/lib/floorplan-schema";

export const dynamic = "force-dynamic";

/**
 * Write the live seat geometry back to src/data/floorplan/seats.json.
 *
 * This is what makes the editor more than a scratchpad. seats.json is the
 * source of truth the seed reads, so without an export a corrected floor is
 * one `npm run db:reset` away from reverting to whatever detection produced.
 * With it, fifteen minutes of dragging becomes a committed artefact.
 *
 * A seat that has moved is marked `manual`, so the detection provenance stays
 * honest: it stops claiming the drawing put the desk there once a human has
 * overruled it.
 */
export async function POST() {
  const viewer = await auth().currentUser();
  if (!viewer?.isAdmin) {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  if (serverEnv().appMode === "production") {
    // In production the app runs from a read-only build; regenerating the
    // committed geometry is a development-time act, not a runtime one.
    return NextResponse.json(
      { error: "Export is a development action and is disabled in production mode." },
      { status: 403 },
    );
  }

  const rows = await db()
    .select({
      seatCode: schema.seats.seatCode,
      bay: schema.seats.bay,
      zone: schema.zones.code,
      planX: schema.seats.planX,
      planY: schema.seats.planY,
      rotationDeg: schema.seats.rotationDeg,
    })
    .from(schema.seats)
    .innerJoin(schema.zones, eq(schema.seats.zoneId, schema.zones.id));

  let moved = 0;
  const seats: SeatAnchor[] = rows
    .map((row) => {
      const planX = Number(row.planX);
      const planY = Number(row.planY);
      const original = seatAnchor(row.seatCode);
      const changed =
        original === undefined ||
        Math.abs(original.planX - planX) > 0.01 ||
        Math.abs(original.planY - planY) > 0.01 ||
        original.rotationDeg !== row.rotationDeg;
      if (changed) moved += 1;
      return {
        seatCode: row.seatCode,
        bay: row.bay,
        zone: row.zone as SeatAnchor["zone"],
        planX: Number(planX.toFixed(2)),
        planY: Number(planY.toFixed(2)),
        rotationDeg: row.rotationDeg,
        source: changed ? ("manual" as const) : (original?.source ?? "manual"),
      };
    })
    .sort((a, b) => compareSeatCodes(a.seatCode, b.seatCode));

  const dest = path.join(process.cwd(), "src", "data", "floorplan", "seats.json");
  await writeFile(
    dest,
    `${JSON.stringify({ viewBox: floorplanSeatAnchors.viewBox, seats })}\n`,
    "utf8",
  );

  return NextResponse.json({
    written: dest,
    seats: seats.length,
    manual: seats.filter((s) => s.source === "manual").length,
    changedInThisExport: moved,
  });
}
