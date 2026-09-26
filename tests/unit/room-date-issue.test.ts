import { describe, expect, it } from "vitest";

import { roomDateIssue } from "@/lib/rooms/validation";

/**
 * PROVES: rooms reject a weekend, a public holiday, or a start time already
 * behind "now" — none of these were checked before this change, and a room
 * could be booked for a Saturday, a holiday, or yesterday.
 */
describe("roomDateIssue", () => {
  const now = new Date("2099-01-08T04:00:00Z"); // Thursday
  const noHolidays = new Set<string>();

  it("accepts a normal weekday with no holiday, in the future", () => {
    expect(roomDateIssue("2099-01-09", new Date("2099-01-09T05:00:00Z"), now, noHolidays)).toBeNull();
  });

  it("rejects a Saturday", () => {
    expect(roomDateIssue("2099-01-10", new Date("2099-01-10T05:00:00Z"), now, noHolidays)).toMatch(
      /weekend/i,
    );
  });

  it("rejects a Sunday", () => {
    expect(roomDateIssue("2099-01-11", new Date("2099-01-11T05:00:00Z"), now, noHolidays)).toMatch(
      /weekend/i,
    );
  });

  it("rejects a public holiday even on a weekday", () => {
    const holidays = new Set(["2099-01-09"]);
    expect(roomDateIssue("2099-01-09", new Date("2099-01-09T05:00:00Z"), now, holidays)).toMatch(
      /holiday/i,
    );
  });

  it("rejects a start time already behind now, same day", () => {
    // now is 04:00Z on the 8th; 03:00Z on the 8th has already started.
    expect(roomDateIssue("2099-01-08", new Date("2099-01-08T03:00:00Z"), now, noHolidays)).toMatch(
      /already/i,
    );
  });

  it("rejects a date entirely in the past", () => {
    expect(roomDateIssue("2099-01-01", new Date("2099-01-01T05:00:00Z"), now, noHolidays)).not.toBeNull();
  });

  it("accepts the exact current instant as not-yet-past (boundary is exclusive of the past, not of now)", () => {
    expect(roomDateIssue("2099-01-08", now, now, noHolidays)).toBeNull();
  });

  it("weekend is checked before the past-time check, so the message says weekend even for a past Saturday", () => {
    expect(roomDateIssue("2099-01-03", new Date("2099-01-03T05:00:00Z"), now, noHolidays)).toMatch(
      /weekend/i,
    );
  });
});
