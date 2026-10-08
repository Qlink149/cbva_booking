/**
 * The public holiday list, as a set of "yyyy-MM-dd" strings.
 *
 * One reader for desks, seat releases and meeting rooms, so "is this a
 * holiday" can't answer differently depending on which write path asks.
 */
import { schema, type DbLike } from "@/lib/db";

export async function loadHolidays(db: DbLike): Promise<Set<string>> {
  const rows = await db.select({ d: schema.holidays.holidayDate }).from(schema.holidays);
  return new Set(rows.map((r) => r.d));
}
