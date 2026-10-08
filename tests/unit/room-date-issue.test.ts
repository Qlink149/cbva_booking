import { describe, expect, it } from "vitest";

import { firstOpenHour, roomDateIssue } from "@/lib/rooms/validation";

/**
 * Rooms refuse an impossible date, a weekend, a public holiday, or an hour that
 * is already over — and, like desks, keep the CURRENT hour bookable. Adapted
 * from PR #4, with the current-hour rule changed: PR #4 refused any hour that
 * had already started, which turned away a team wanting an empty room right now.
 */
const TZ = "Asia/Kolkata";
// Thursday 8 January 2099, 04:35Z = 10:05 IST.
const now = new Date("2099-01-08T04:35:00Z");
const noHolidays = new Set<string>();

describe("firstOpenHour — the one definition of 'this hour is over'", () => {
  it("is the current hour today: at 10:05 IST, 10:00 is still open", () => {
    expect(firstOpenHour("2099-01-08", now, TZ)).toBe(10);
  });

  it("opens every hour of a future date, and none of a past one", () => {
    expect(firstOpenHour("2099-01-09", now, TZ)).toBe(0);
    expect(firstOpenHour("2099-01-07", now, TZ)).toBe(24);
  });

  it("reads 'today' in the firm's timezone, not UTC", () => {
    // 20:00Z on the 7th is already 01:30 on the 8th in IST.
    const lateUtc = new Date("2099-01-07T20:00:00Z");
    expect(firstOpenHour("2099-01-08", lateUtc, TZ)).toBe(1);
    expect(firstOpenHour("2099-01-07", lateUtc, TZ)).toBe(24);
  });
});

describe("roomDateIssue", () => {
  it("accepts a future weekday that isn't a holiday", () => {
    expect(roomDateIssue("2099-01-09", 11, now, noHolidays, TZ)).toBeNull();
  });

  it("refuses a date that doesn't exist, instead of letting it reach the database", () => {
    expect(roomDateIssue("2099-02-30", 11, now, noHolidays, TZ)).toMatch(/does not exist/i);
    expect(roomDateIssue("2099-13-01", 11, now, noHolidays, TZ)).toMatch(/does not exist/i);
  });

  it("refuses Saturday and Sunday", () => {
    expect(roomDateIssue("2099-01-10", 11, now, noHolidays, TZ)).toMatch(/weekend/i);
    expect(roomDateIssue("2099-01-11", 11, now, noHolidays, TZ)).toMatch(/weekend/i);
  });

  it("refuses a public holiday on a weekday", () => {
    expect(roomDateIssue("2099-01-09", 11, now, new Set(["2099-01-09"]), TZ)).toMatch(/holiday/i);
  });

  it("keeps the current hour bookable and refuses the one that's over", () => {
    expect(roomDateIssue("2099-01-08", 10, now, noHolidays, TZ)).toBeNull();
    expect(roomDateIssue("2099-01-08", 9, now, noHolidays, TZ)).toMatch(/already over/i);
  });

  it("refuses any hour of a past date", () => {
    expect(roomDateIssue("2099-01-07", 16, now, noHolidays, TZ)).toMatch(/already over/i);
  });

  it("names the weekend, not the past, for a past Saturday", () => {
    expect(roomDateIssue("2099-01-03", 11, now, noHolidays, TZ)).toMatch(/weekend/i);
  });
});
