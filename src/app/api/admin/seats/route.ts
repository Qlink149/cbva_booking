import { seatCodeOrder } from "@/lib/seat-code-sql";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { handle, routeContext } from "@/lib/api";
import { assertAdmin } from "@/lib/booking/authorise";
import { releasesBetween } from "@/lib/booking/seat-release";
import { shiftDays } from "@/lib/analytics/filters";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().max(40).nullable().optional(),
  zone: z.string().max(4).nullable().optional(),
  bay: z.string().max(12).nullable().optional(),
  status: z.enum(["all", "bookable", "fixed", "blocked", "decommissioned"]).default("all"),
});

/**
 * The desk inventory.
 *
 * Each row carries what an admin needs before changing anything: who it is
 * allocated to, how many bookings are still ahead of it, and whether its
 * position on the plan came from the drawing or from an interpolation. That
 * last one matters because eleven desks are still on inferred positions
 * (ASSUMPTIONS A24) and an admin correcting the floor should be able to see
 * which ones deserve attention.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const ctx = await routeContext();
    assertAdmin(ctx.actor);

    const url = new URL(request.url);
    const q = querySchema.parse({
      q: url.searchParams.get("q"),
      zone: url.searchParams.get("zone"),
      bay: url.searchParams.get("bay"),
      status: url.searchParams.get("status") ?? undefined,
    });

    const filters = [sql`true`];
    if (q.q) filters.push(sql`lower(s.seat_code) like ${`%${q.q.toLowerCase()}%`}`);
    if (q.zone) filters.push(sql`z.code = ${q.zone}`);
    if (q.bay) filters.push(sql`s.bay = ${q.bay}`);
    if (q.status !== "all") filters.push(sql`s.status::text = ${q.status}`);

    const now = ctx.clock.now();
    const today = now.toISOString().slice(0, 10);

    const [rows, releases] = await Promise.all([
      ctx.db.execute(sql`
        select
          s.id, s.seat_code, s.bay, z.code as zone,
          s.seat_type::text as seat_type, s.status::text as status,
          s.plan_x, s.plan_y, s.rotation_deg,
          to_char(s.active_from, 'YYYY-MM-DD') as active_from,
          to_char(s.active_to,   'YYYY-MM-DD') as active_to,
          s.assigned_user_id,
          u.display_name as assigned_name,
          (select count(*)::int from bookings b
            where b.seat_id = s.id
              and b.status in ('confirmed','checked_in')
              and b.ends_at > ${now}::timestamptz) as upcoming_bookings
        from seats s
        join zones z on z.id = s.zone_id
        left join users u on u.id = s.assigned_user_id
        where ${sql.join(filters, sql` and `)}
        order by z.code, s.bay, ${seatCodeOrder(sql`s.seat_code`)}`),
      // The next fortnight of releases, so the inventory can show which
      // allocated desks are temporarily in the pool.
      releasesBetween(ctx.db, today, shiftDays(today, 14)),
    ]);

    const releasesBySeat = new Map<string, number>();
    for (const r of releases) {
      releasesBySeat.set(r.seatCode, (releasesBySeat.get(r.seatCode) ?? 0) + 1);
    }

    return NextResponse.json({
      today,
      seats: (rows.rows as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        seatCode: String(r.seat_code),
        bay: String(r.bay),
        zone: String(r.zone),
        seatType: String(r.seat_type),
        status: String(r.status),
        planX: Number(r.plan_x),
        planY: Number(r.plan_y),
        rotationDeg: Number(r.rotation_deg),
        activeFrom: String(r.active_from),
        activeTo: r.active_to ? String(r.active_to) : null,
        assignedUserId: r.assigned_user_id ? String(r.assigned_user_id) : null,
        assignedName: r.assigned_name ? String(r.assigned_name) : null,
        upcomingBookings: Number(r.upcoming_bookings ?? 0),
        upcomingReleases: releasesBySeat.get(String(r.seat_code)) ?? 0,
      })),
    });
  });
}
