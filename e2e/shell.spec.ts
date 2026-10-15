import { expect, test } from "@playwright/test";

/**
 * Phase 1 browser verification: the shell renders, the nav works, the role
 * switcher actually changes who you are, and the styleguide is complete.
 */

test("home page renders the shell and live seeded numbers", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /CBV & ASSOCIATES/i })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Seats Occupied Today")).toBeVisible();
  // 158 desks come from the seed, not from a hard-coded number.
  await expect(page.getByText("Total Desks")).toBeVisible();
  await expect(page.locator("dd", { hasText: /^158$/ }).first()).toBeVisible();
});

test("primary navigation reaches every destination", async ({ page }) => {
  await page.goto("/");
  for (const [label, path] of [
    ["Floor Map", "/floor"],
    ["My Bookings", "/bookings"],
    ["Meeting Rooms", "/rooms"],
  ] as const) {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: label }).click();
    // A generous budget on purpose. This asserts that the links go where they
    // say, not that dev-mode navigation is fast: /bookings and /rooms are
    // server-rendered and each waits on a round trip to Neon in Singapore
    // before the App Router commits the URL. The default five seconds made this
    // pass warm and fail cold, which reads as flakiness rather than as the
    // latency it is.
    await expect(page).toHaveURL(path, { timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
  }
});

test("role switcher changes the signed-in person", async ({ page }) => {
  await page.goto("/");
  const select = page.getByLabel("Sign in as a different person (demo)");
  await expect(select).toBeVisible();

  const options = await select.locator("option").all();
  expect(options.length).toBeGreaterThan(3);

  const before = await page.getByRole("heading", { level: 1 }).textContent();
  const target = await options[options.length - 1]!.getAttribute("value");
  await select.selectOption(target!);

  await expect
    .poll(async () => page.getByRole("heading", { level: 1 }).textContent())
    .not.toBe(before);
});

test("styleguide shows every seat status with a non-colour cue", async ({ page }) => {
  await page.goto("/styleguide");
  await expect(page.getByRole("heading", { level: 1, name: "Style Guide" })).toBeVisible();

  for (const label of [
    "Available",
    "Booked",
    "Your Booking",
    "Reserved (Fixed)",
    "Checked In",
    "Auto Released",
    "Blocked",
  ]) {
    // The swatch cells carry the same accessible name, so scope to the first
    // column rather than matching anywhere in the row.
    await expect(
      page.getByRole("cell", { name: label, exact: true }).first(),
    ).toBeVisible();
  }

  // The swatches are exposed to assistive tech, not just painted.
  await expect(page.getByRole("img", { name: "Seat C3-04: Your booking" }).first()).toBeVisible();
});

test("skip link is reachable by keyboard", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to Content" })).toBeFocused();
});

test("no horizontal overflow at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/", "/styleguide", "/floor"]) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow, `${path} scrolls horizontally`).toBe(false);
  }
});
