import { sql, type SQL } from "drizzle-orm";

/**
 * SQL fragment for `order by`: length first, then the text, which is numeric
 * order for pure digits and still a total order for anything else.
 * `column` is the qualified column, e.g. sql`s.seat_code`.
 */
export function seatCodeOrder(column: SQL): SQL {
  return sql`length(${column}), ${column}`;
}
