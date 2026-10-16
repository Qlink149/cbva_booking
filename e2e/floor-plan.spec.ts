import { expect, test, type Page } from "@playwright/test";

async function openFloor(page: Page) {
  await page.goto("/floor");
  await page.getByLabel("Sign in as a different person (demo)").waitFor();
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(600);
}

test("renders all 158 seats and no CAD paths in the live DOM", async ({ page }) => {
  await openFloor(page);
  await expect(page.locator("[data-seat]")).toHaveCount(158);

  // The architecture rule: linework is one raster, not 8,603 nodes. If this
  // ever fails somebody has inlined the walls SVG and the plan will crawl.
  const paths = await page.locator(".relative svg path").count();
  expect(paths).toBeLessThan(50);

  const interactive = await page.locator("[data-seat]").count();
  expect(interactive).toBeLessThan(200);
});

test("a seat announces itself with code, zone, bay and status", async ({ page }) => {
  await openFloor(page);
  const label = await page.locator("[data-seat='36']").getAttribute("aria-label");
  expect(label).toMatch(/^Seat 36, Zone C, bay F, /);
});

test("reserved fixed seats are not clickable and name their occupant", async ({ page }) => {
  await openFloor(page);
  const fixed = page.locator("[data-seat][data-status='reserved_fixed']").first();
  // aria-disabled rather than disabled, so it stays keyboard reachable and can
  // still tell you whose desk it is.
  await expect(fixed).toHaveAttribute("aria-disabled", "true");
  // Not the `disabled` attribute, so it keeps its place in the tab order.
  // (Playwright reads aria-disabled as disabled, hence checking the DOM.)
  expect(await fixed.evaluate((el: HTMLButtonElement) => el.disabled)).toBe(false);
  await fixed.focus();
  await expect(fixed).toBeFocused();
  await expect(fixed).toHaveAttribute("aria-label", /Reserved, fixed allocation/);
  // dispatchEvent rather than click(): Playwright refuses to click an
  // aria-disabled element, which is the point — this fires the handler
  // directly to prove the guard inside it, not just the actionability check.
  await fixed.dispatchEvent("click");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a seat is reachable by keyboard and arrows move within the bay", async ({ page }) => {
  await openFloor(page);
  const first = page.locator("[data-seat]").first();
  await first.focus();
  const startCode = await first.getAttribute("data-seat");
  const startBay = await first.getAttribute("data-bay");

  await page.keyboard.press("ArrowRight");
  const focused = page.locator("[data-seat]:focus");
  await expect(focused).toHaveCount(1);
  const nextCode = await focused.getAttribute("data-seat");
  expect(nextCode).not.toBe(startCode);
  // Arrow navigation prefers staying inside the bay.
  expect(await focused.getAttribute("data-bay")).toBe(startBay);
});

test("hovering a seat shows its card", async ({ page }) => {
  await openFloor(page);
  await page.locator("[data-seat='36']").hover();
  // The card is aria-hidden — the seat button's own accessible name already
  // says all of this, so it is visual reinforcement, not a second
  // announcement. Located by attribute rather than by role for that reason.
  const card = page.locator("[data-seat-card='36']");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Zone C");
  await expect(card).toContainText("Bay F");
});

test("clicking an available seat opens the booking flow", async ({ page }) => {
  await openFloor(page);
  const seat = page.locator("[data-seat][data-status='available']").first();
  const seatCode = await seat.getAttribute("data-seat");

  await seat.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The seat, date and slot are spelled out before anybody commits to them.
  await expect(dialog).toContainText(`Book seat ${seatCode}`);
  await expect(dialog.getByRole("button", { name: "Confirm booking" })).toBeEnabled();
  // exact: the dialog also has a "Close dialog" X, and the default substring
  // match resolves to both.
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("changing the slot reloads seat states", async ({ page }) => {
  await openFloor(page);
  const before = await page.locator("[data-seat][data-status='available']").count();
  await page.getByRole("radio", { name: /Afternoon/ }).click();
  await page.waitForTimeout(900);
  const after = await page.locator("[data-seat][data-status='available']").count();
  // The seeded data mixes AM-only and PM-only bookings, so the two differ.
  expect(after).not.toBe(before);
});

test("the zone filter narrows the plan to one wing", async ({ page }) => {
  await openFloor(page);
  await page.getByRole("radio", { name: "Zone C" }).click();
  await page.waitForTimeout(700);
  await expect(page.locator("[data-seat]")).toHaveCount(66);
  await expect(page.locator("[data-seat][data-zone='D']")).toHaveCount(0);

  await page.getByRole("radio", { name: "Whole floor" }).click();
  await page.waitForTimeout(700);
  await expect(page.locator("[data-seat]")).toHaveCount(158);
});

test("fit to floor and keyboard zoom work", async ({ page }) => {
  await openFloor(page);
  const layer = page.locator("[role='application'] > div").first();
  const initial = await layer.evaluate((el) => getComputedStyle(el).transform);

  await page.locator("[role='application']").focus();
  await page.keyboard.press("+");
  await page.waitForTimeout(600);
  expect(await layer.evaluate((el) => getComputedStyle(el).transform)).not.toBe(initial);

  await page.getByRole("button", { name: "Fit to floor" }).click();
  await page.waitForTimeout(900);
  // Compared with a tolerance rather than as a string. The fit is computed from
  // the measured container, so a sub-pixel difference in layout — a scrollbar,
  // a font metric — moves the translation by a fraction and an exact string
  // comparison fails on a difference nobody could see.
  const refit = await layer.evaluate((el) => getComputedStyle(el).transform);
  const numbers = (m: string) => (m.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const [a, b] = [numbers(initial), numbers(refit)];
  expect(b).toHaveLength(a.length);
  for (const [i, value] of a.entries()) {
    expect(Math.abs(value - b[i]!), `transform component ${i}`).toBeLessThan(1);
  }
});

/**
 * Status LOD. The point of these three is that the LOD is a PAINT change: at
 * whole-floor zoom the plan answers a density question, and at every zoom the
 * 158 seat buttons are still there with their names, so nothing a keyboard or
 * a screen reader can observe moves with the zoom.
 */
test("at whole-floor zoom the plan shows bay occupancy, not per-seat status", async ({
  page,
}) => {
  await openFloor(page);
  const canvas = page.locator("[role='application']");
  // Fit-to-floor is ~0.61 at this viewport, well below the 0.85 threshold.
  await expect(canvas).toHaveAttribute("data-lod", "bay");

  // Every seat is STILL a button with its name. This is the assertion that
  // matters: the accessible path does not degrade with the rendering.
  await expect(page.locator("[data-seat]")).toHaveCount(158);
  await expect(page.locator("[data-seat='36']")).toHaveAttribute(
    "aria-label",
    /^Seat 36, Zone C, bay F, /,
  );

  // The bay chips are present, readable, and none covers another. An
  // overlapping chip is the failure mode this layer has -- bay centroids are
  // where the desks are, not where there is room to write.
  const chips = await canvas.evaluate((host) => {
    const hb = host.getBoundingClientRect();
    return [...host.querySelectorAll("svg g > g")]
      .map((g) => {
        const text = g.querySelector("text");
        const rect = g.querySelector("rect");
        if (!text || !rect) return null;
        const rb = rect.getBoundingClientRect();
        return {
          bay: text.textContent ?? "",
          x: rb.left - hb.left,
          y: rb.top - hb.top,
          w: rb.width,
          h: rb.height,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  });

  expect(chips.length).toBeGreaterThanOrEqual(10);
  let overlaps = 0;
  for (let i = 0; i < chips.length; i++) {
    for (let k = i + 1; k < chips.length; k++) {
      const a = chips[i]!;
      const b = chips[k]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        overlaps++;
      }
    }
  }
  expect(overlaps, "bay chips must not cover one another").toBe(0);
  // And none pushed off the drawing by the separation pass.
  for (const chip of chips) {
    expect(chip.y, `chip ${chip.bay} is clipped at the top`).toBeGreaterThanOrEqual(0);
  }

  // Still a raster, not linework (ADR-019). The chips are rect/text/line.
  expect(await page.locator(".relative svg path").count()).toBeLessThan(50);
});

test("zooming in switches to per-seat status, and back out again", async ({ page }) => {
  await openFloor(page);
  const canvas = page.locator("[role='application']");
  await expect(canvas).toHaveAttribute("data-lod", "bay");

  await canvas.focus();
  // Three presses at 1.3x clears the 1.0 exit threshold from ~0.61.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("+");
    await page.waitForTimeout(400);
  }
  await expect(canvas).toHaveAttribute("data-lod", "seat");
  await expect(page.locator("[data-seat]")).toHaveCount(158);

  await page.getByRole("button", { name: "Fit to floor" }).click();
  await page.waitForTimeout(900);
  await expect(canvas).toHaveAttribute("data-lod", "bay");
});

test("the bay chips agree with the seats they aggregate", async ({ page }) => {
  await openFloor(page);
  const canvas = page.locator("[role='application']");
  await expect(canvas).toHaveAttribute("data-lod", "bay");

  // Compared against the SEAT ELEMENTS rather than the headline readout, so
  // this asserts the aggregation itself and not a piece of text formatting.
  //
  // The failure it catches is the Phase 5 bay-heat-map defect: counting
  // occupied desks without dividing by each bay's own capacity, which
  // saturates every cell to the bay's size and draws a picture of which bays
  // are biggest rather than which are busy.
  const truth = await page.evaluate(() => {
    const OCCUPIED = ["booked", "checked_in", "your_booking"];
    const NO_CAPACITY = ["blocked", "reserved_fixed"];
    const perBay = new Map<string, { occupied: number; capacity: number }>();
    for (const el of document.querySelectorAll("[data-seat]")) {
      const bay = el.getAttribute("data-bay") ?? "";
      const status = el.getAttribute("data-status") ?? "";
      const row = perBay.get(bay) ?? { occupied: 0, capacity: 0 };
      if (!NO_CAPACITY.includes(status)) row.capacity += 1;
      if (OCCUPIED.includes(status)) row.occupied += 1;
      perBay.set(bay, row);
    }
    return [...perBay.entries()]
      .filter(([, v]) => v.capacity > 0)
      .map(([bay, v]) => `${bay}:${v.occupied}/${v.capacity}`)
      .sort();
  });

  const drawn = await canvas.evaluate((host) =>
    [...host.querySelectorAll("svg g > g")]
      .map((g) => {
        const texts = g.querySelectorAll("text");
        const bay = texts[0]?.textContent?.trim();
        const count = texts[1]?.textContent?.trim();
        return bay && count ? `${bay}:${count}` : null;
      })
      .filter((v): v is string => v !== null)
      .sort(),
  );

  expect(drawn.length).toBeGreaterThanOrEqual(10);
  // Every chip drawn must match its bay exactly, and every bay with bookable
  // supply must have a chip. Set equality, so neither a missing chip nor an
  // invented one passes.
  expect(drawn).toEqual(truth);
});

test("the list view carries the same seats and can be filtered", async ({ page }) => {
  await openFloor(page);
  await page.getByRole("radio", { name: "List" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText("158 of 158 seats")).toBeVisible();

  await page.locator("#list-zone").selectOption("D");
  await expect(page.getByText("67 of 158 seats")).toBeVisible();

  await page.getByLabel("Search seat, bay or person").fill("142");
  await expect(page.getByText("1 of 158 seats")).toBeVisible();
});

test("the occupancy count is always visible", async ({ page }) => {
  await openFloor(page);
  await expect(page.getByText("Occupancy, this slot")).toBeVisible();
  await expect(page.getByText(/% occupied/)).toBeVisible();
});

test("the date strip skips weekends and holidays", async ({ page }) => {
  await openFloor(page);
  const days = page.getByRole("radiogroup", { name: "Booking date" }).getByRole("radio");
  // settings.booking_window_working_days, which Phase 3 made the enforced rule
  // rather than a display limit. Five, not the six the Phase 2 strip showed.
  await expect(days).toHaveCount(5);
  const labels = await days.allInnerTexts();
  expect(labels.join(" ")).not.toMatch(/\bSat\b|\bSun\b/);
});

test("the admin editor loads and reports the per-bay detection", async ({ page }) => {
  await page.goto("/admin/floor-plan");
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Floor Plan Editor" })).toBeVisible();
  // R009: every desk snaps onto its own chair block, so nothing is interpolated.
  await expect(
    page.getByText("Every seat in this view came from detected geometry."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();

  // The per-bay reconciliation is on the page, not only in the handoff doc.
  // Zone B now carries 17 numbered desks (bay C), so it is an ordinary row:
  // bay, zone, drawing pax, scheduled, detected (cell text runs together).
  await expect(page.getByRole("table")).toContainText("CB171717");
});
