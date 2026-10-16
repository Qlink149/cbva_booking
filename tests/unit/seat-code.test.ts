import { describe, expect, it } from "vitest";

import { compareSeatCodes } from "@/lib/seat-code";

describe("compareSeatCodes", () => {
  it("orders R009 desk numbers numerically, not as text", () => {
    const codes = ["100", "2", "10", "158", "1", "20", "3"];
    expect([...codes].sort(compareSeatCodes)).toEqual(["1", "2", "3", "10", "20", "100", "158"]);
  });

  it("still gives a total order to prefixed codes from fixtures", () => {
    expect(["T-10", "T-2", "A-1"].sort(compareSeatCodes)).toEqual(["A-1", "T-2", "T-10"]);
  });
});
