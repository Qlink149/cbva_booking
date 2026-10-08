import { describe, expect, it } from "vitest";

import { roomDateIssue } from "@/lib/rooms/validation";

/**
 * Rooms refuse a weekend, a public holiday, or an hour that is already over —
 * and, like desks, keep the CURRENT hour bookable. Adapted from PR #4, with the
 * current-hour rule changed: PR #4 refused any hour that had already started,
 * which turned away a team wanting an empty room right now.
 */
describe("roomDateIssue", () => {
  // Thursday 8 January 2099, 04:35Z (= 10:05 IST).
  const now = new Date("2099-01-08T04:35:00Z");
  const noHolidays = new Set<string>();
  const at = (iso: string) => new Date(iso);

  it("accepts a future weekday that isn't a holiday", () => {
    expect(roomDateIssue("2099-01-09", at("2099-01-09T05:30:00Z"), now, noHolidays)).toBeNull();
  });

  it("refuses Saturday and Sunday", () => {
    expect(roomDateIssue("2099-01-10", at("2099-01-10T05:30:00Z"), now, noHolidays)).toMatch(/weekend/i);
    expect(roomDateIssue("2099-01-11", at("2099-01-11T05:30:00Z"), now, noHolidays)).toMatch(/weekend/i);
  });

  it("refuses a public holiday on a weekday", () => {
    const holidays = new Set(["2099-01-09"]);
    expect(roomDateIssue("2099-01-09", at("2099-01-09T05:30:00Z"), now, holidays)).toMatch(/holiday/i);
  });

  it("keeps the current hour bookable: at 10:05, the 10:00 hour is open", () => {
    // 10:00 IST = 04:30Z, started five minutes ago.
    expect(roomDateIssue("2099-01-08", at("2099-01-08T04:30:00Z"), now, noHolidays)).toBeNull();
  });

  it("refuses an hour that is over: at 10:05, the 09:00 hour has ended", () => {
    // 09:00 IST = 03:30Z, ended at 10:00 IST.
    expect(roomDateIssue("2099-01-08", at("2099-01-08T03:30:00Z"), now, noHolidays)).toMatch(
      /already over/i,
    );
  });

  it("refuses the previous hour at the exact instant it ends", () => {
    const tenOClock = at("2099-01-08T04:30:00Z");
    expect(roomDateIssue("2099-01-08", at("2099-01-08T03:30:00Z"), tenOClock, noHolidays)).toMatch(
      /already over/i,
    );
  });

  it("refuses a date in the past", () => {
    expect(roomDateIssue("2099-01-07", at("2099-01-07T05:30:00Z"), now, noHolidays)).not.toBeNull();
  });

  it("names the weekend, not the past, for a past Saturday", () => {
    expect(roomDateIssue("2099-01-03", at("2099-01-03T05:30:00Z"), now, noHolidays)).toMatch(/weekend/i);
  });
});
