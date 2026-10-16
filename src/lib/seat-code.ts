/**
 * Ordering seat codes.
 *
 * Under R009 (ADR-049) a seat code is the architect's desk number as a string:
 * "1" … "158". Plain string collation puts "10" and "100" between "1" and "2",
 * so a list sorted with `localeCompare` alone reads 1, 10, 100, 101 … 2, 20.
 * Everything that orders by seat code goes through these two helpers so the
 * floor, the list view, the QR sheet, the inventory and the analytics all
 * agree on 1, 2, 3 … 158 — and would still agree if a future code carried a
 * prefix again.
 *
 * This file is imported by client components, so it must stay free of
 * drizzle (ADR-039); the SQL half lives in `seat-code-sql.ts`.
 */
export function compareSeatCodes(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}
