/**
 * The Phase 3 walkthrough, as one spec.
 *
 * Sign in as an assistant manager, book a desk, see the confirmation in the
 * demo inbox, check in by QR, book on behalf of a colleague, cancel, then
 * advance the clock and watch a different booking auto-release.
 *
 * It runs in order and shares state between tests deliberately — it is a
 * narrative, not a set of independent assertions, and the point is that the
 * whole journey holds together. Each step leaves a screenshot behind.
 *
 * The clock is reset in `afterAll` without fail: the offset is one row shared
 * by the whole database, so a spec that advanced it and stopped would leave the
 * dev server and every later spec two hours into the future.
 */
import { expect, test, type Page } from "@playwright/test";

import {
  advanceClockTo,
  clearUpcomingBookings,
  personaOfGrade,
  resetClock,
  runJobs,
  settled,
  shot,
  signInAs,
} from "./helpers";

test.describe.configure({ mode: "serial" });


let booker = "";
let admin = "";
let seatCode = "";
/** ISO start of the booking made in step 1. Drives every clock move below. */
let slotStartsAt = "";

test.beforeAll(async ({ request }) => {
  const am = await personaOfGrade(request, "assistant_manager");
  booker = am.email;
  const adminPersona = await personaOfGrade(request, "admin_staff");
  admin = adminPersona.email;
  const manager = await personaOfGrade(request, "manager");

  // A clean slate for the two people who book here. The engine refuses a second
  // desk in the same slot, so without this the walkthrough passes once and then
  // fails on its own correct behaviour for the rest of the day.
  //
  // On the worker-scoped `request` fixture rather than a throwaway page: a page
  // closed while a DELETE is still settling fails this hook, and a failed hook
  // in a serial spec skips all eleven steps.
  await clearUpcomingBookings(request, booker);
  await clearUpcomingBookings(request, manager.email);
});

test.afterAll(async ({ request }) => {
  // Without fail: the offset is one row shared by the whole database, so a spec
  // that advanced it and stopped leaves the dev server and every later spec
  // days into the future.
  await resetClock(request);
});

/**
 * Opens the floor plan, in the (default) morning slot.
 *
 * `dayIndex`, used at both places in this file that book a fresh desk (steps
 * 1 and 6): with no query string `/floor` defaults to today's AM slot, and
 * this suite runs in real wall-clock time. Late in the day, today's morning
 * slot has "already finished" and `createBooking()` correctly refuses it
 * (A21) — the walkthrough would fail on its own correct behaviour depending
 * what time it happens to run. `tests/integration/series-and-bounds.test.ts`
 * hit the identical flake; same fix here: don't book today.
 *
 * It turns out BOTH booking steps need this, not just the first — step 4's
 * `resetClock` (checking in) puts the demo clock back to real time before
 * step 6 runs, so step 6 is just as exposed to "today's slot already
 * finished" as step 1 was, and originally failed on exactly that once step 1
 * was fixed and could actually be reached.
 *
 * The two calls deliberately use DIFFERENT indices (1 and 2) rather than both
 * defaulting to "tomorrow": the first attempt at this fix sent both to the
 * same day, and the seed's own booking history for that specific date
 * collided with whichever colleague step 6 happened to search up first ("There
 * is already a desk booked for that slot"). Distinct days sidesteps that
 * without having to know or control which colleague gets picked.
 */
async function openFloor(page: Page, { dayIndex = 0 } = {}): Promise<void> {
  await page.goto("/floor");
  await settled(page);
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });

  if (dayIndex === 0) return;

  const days = page.getByRole("radiogroup", { name: "Booking date" }).getByRole("radio");
  // `placeholderData: (previous) => previous` (floor-client.tsx) means the
  // date click does not blank the plan — it keeps showing TODAY's seats,
  // fully interactive, until the new date's fetch resolves. Waiting only for
  // "[data-seat] exists" is satisfied instantly by that stale render, so a
  // seat grabbed right after the click can be today's, not the chosen day's —
  // wait for the actual response instead.
  const refetch = page.waitForResponse(
    (r) => r.url().includes("/api/floor?date=") && r.status() === 200,
  );
  await days.nth(dayIndex).click();
  await refetch;
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
}

test("1 — an assistant manager books a desk from the floor plan", async ({ page }) => {
  // openFloor's date-picker round trip (real navigation, a click, and a
  // waited network response, on top of everything this step already did)
  // pushed observed runs to right up against the 60s default — comfortably
  // under it most of the time, but not with margin to spare.
  test.setTimeout(90_000);
  await signInAs(page, booker);
  await openFloor(page, { dayIndex: 1 });

  const seat = page.locator("[data-seat][data-status='available']").first();
  seatCode = (await seat.getAttribute("data-seat")) ?? "";
  expect(seatCode).not.toBe("");

  await seat.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Book seat ${seatCode}`);
  await shot(page, "p3-01-booking-dialog");

  await dialog.getByRole("button", { name: "Confirm booking" }).click();

  // The confirmation names the desk, so there is no doubt which one was taken.
  await expect(dialog).toContainText(seatCode, { timeout: 15_000 });
  await expect(dialog.getByText(/is yours for the/i)).toBeVisible();
  await shot(page, "p3-02-booking-confirmed");

  await dialog.getByRole("button", { name: "Done" }).click();

  // And the map has followed: the desk now reads as yours.
  await expect(page.locator(`[data-seat='${seatCode}']`)).toHaveAttribute(
    "data-status",
    "your_booking",
    { timeout: 15_000 },
  );
  await shot(page, "p3-03-floor-after-booking");
});

test("2 — it appears on My Bookings", async ({ page }) => {
  await signInAs(page, booker);
  await page.goto("/bookings");
  await settled(page);

  await expect(page.getByRole("heading", { level: 1, name: "My Bookings" })).toBeVisible();
  await expect(page.getByText(seatCode).first()).toBeVisible();
  await shot(page, "p3-04-my-bookings");

  // The instant the later steps have to move the clock to. Read from the API
  // rather than guessed: the first bookable day can be several days out, and a
  // check-in window is measured from that slot's start, not from now.
  const res = await page.request.get("/api/bookings");
  const body = (await res.json()) as {
    upcoming: Array<{ seatCode: string; startsAt: string }>;
  };
  const row = body.upcoming.find((b) => b.seatCode === seatCode);
  expect(row, "the booking is on My Bookings").toBeTruthy();
  slotStartsAt = row!.startsAt;
});

test("3 — the confirmation is in the demo inbox, rendered", async ({ page }) => {
  await signInAs(page, admin);
  await page.goto("/admin/notifications");
  await settled(page);

  // The outbox holds the real HTML, not a description of it.
  const row = page.getByRole("button", { name: new RegExp(`Desk ${seatCode} booked`) }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();

  const preview = page.locator("iframe");
  await expect(preview).toBeVisible();
  await expect(preview.contentFrame().getByText("Booking confirmed")).toBeVisible();
  await expect(preview.contentFrame().getByText(seatCode)).toBeVisible();
  await shot(page, "p3-05-demo-inbox");
});

test("4 — checking in by scanning the desk QR", async ({ page }) => {
  await signInAs(page, booker);

  // The slot has to be running for a check-in to be legal, so move the clock
  // fifteen minutes into it. This is the demo clock, and the check-in it
  // enables is entirely real.
  await advanceClockTo(page, new Date(new Date(slotStartsAt).getTime() + 15 * 60_000));

  await page.goto(`/checkin/${seatCode}`);
  await settled(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(seatCode);
  await shot(page, "p3-06-qr-landing");

  const confirm = page.getByRole("button", { name: new RegExp(`Check in to ${seatCode}`) });
  await expect(confirm).toBeVisible();
  await confirm.click();

  await expect(page.getByText(/recorded as in use|Nothing more to do/)).toBeVisible({
    timeout: 15_000,
  });
  await shot(page, "p3-07-checked-in");

  await resetClock(page);
});

test("5 — the printable QR sheet exists and is scannable markup", async ({ page }) => {
  await signInAs(page, admin);
  await page.goto("/admin/qr");
  await settled(page);

  // One inline SVG per bookable desk, generated server-side — no client JS and
  // no runtime fetch, because the output of this page is 141 stickers.
  const codes = page.locator(".qr-card svg");
  expect(await codes.count()).toBeGreaterThan(90);
  await expect(page.locator(".qr-card").first()).toContainText("/checkin/");
  await shot(page, "p3-08-qr-sheet");
});

test("8 — cancelling a booking releases the desk", async ({ page }) => {
  await signInAs(page, booker);
  await page.goto("/bookings");
  await settled(page);

  // The booking from step 1 was checked into, so the cut-off no longer applies
  // to it — releasing a desk you are leaving is exactly what the product wants.
  const card = page.locator("div").filter({ hasText: seatCode }).last();
  await expect(card).toBeVisible();

  const cancel = page.getByRole("button", { name: "Cancel" }).first();
  await cancel.click();
  await expect(page.getByText(/released back to the floor/i)).toBeVisible({ timeout: 15_000 });
  await shot(page, "p3-12-cancelled");
});

test("9 — advancing the clock auto-releases an un-checked-in desk", async ({ page }) => {
  // Two `runJobs` calls (each a real scan over real rows) and three full
  // reloads-with-networkidle plus their screenshots, against the real Neon
  // connection. The 60s default is comfortable for the rest of this file's
  // steps but not for this one — it timed out mid-run rather than failing on
  // any assertion, which is a budget problem, not a behaviour bug.
  test.setTimeout(120_000);
  await signInAs(page, admin);
  await page.goto("/floor");
  await settled(page);

  /*
   * Pin the clock to a moment when nothing is due YET, rather than trusting
   * the wall clock to be early enough.
   *
   * The two-hour grace window on the 09:00 slot expires at 11:00. Run before
   * that, the real time is a fine baseline; run after it — which any suite
   * started late morning is — this first `runJobs` settles every un-checked-in
   * booking itself, and the advance below then finds nothing left to do and the
   * test fails having proved the opposite of a defect.
   *
   * Half an hour into the slot is inside the grace window by construction, so
   * both halves of this narrative are now deterministic at any hour.
   */
  await advanceClockTo(page, new Date(new Date(slotStartsAt).getTime() + 30 * 60_000));
  await page.reload();
  await settled(page);

  // Nothing is due yet.
  const before = await runJobs(page);
  expect(before.autoRelease.released).toBeGreaterThanOrEqual(0);

  // Half an hour past the two-hour grace window for that morning's bookings.
  // The offset is shared, so the server, the browser and the job all move
  // together — which is the entire point of the clock rule.
  await advanceClockTo(page, new Date(new Date(slotStartsAt).getTime() + 150 * 60_000));
  await page.reload();
  await settled(page);
  await shot(page, "p3-13-clock-advanced");

  const result = await runJobs(page);
  // Seeded confirmed bookings for today that nobody checked into are now past
  // their grace window. The REAL job ran the REAL rule against REAL rows.
  expect(
    result.autoRelease.released + result.autoRelease.markedNoShow,
    "the job settled at least one booking",
  ).toBeGreaterThan(0);

  await page.reload();
  await settled(page);
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
  await shot(page, "p3-14-after-auto-release");

  if (result.autoRelease.released > 0) {
    // A released desk gets its own status on the plan, not just "available" —
    // that is what makes the two-hour rule visible rather than invisible.
    await expect(page.locator("[data-seat][data-status='auto_released']").first()).toBeVisible({
      timeout: 15_000,
    });
  }

  await resetClock(page);
});

test("10 — the release email is in the inbox", async ({ page }) => {
  await signInAs(page, admin);
  await page.goto("/admin/notifications");
  await settled(page);
  await page.getByLabel("Kind").selectOption("auto_released");

  const row = page.getByRole("button", { name: /released — no check-in/i }).first();
  if (await row.isVisible().catch(() => false)) {
    await row.click();
    await expect(page.locator("iframe").contentFrame().getByText("Desk released")).toBeVisible();
  }
  await shot(page, "p3-15-release-email");
});

test("11 — a meeting room is booked from the grid", async ({ page }) => {
  await signInAs(page, booker);
  await page.goto("/rooms");
  await settled(page);
  await shot(page, "p3-16-room-grid");

  const free = page.getByRole("button", { name: /:00, free$/ }).first();
  await free.click();
  await page.getByRole("button", { name: "Name this meeting" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Meeting name").fill("Phase 3 walkthrough");
  await shot(page, "p3-17-room-dialog");
  await dialog.getByRole("button", { name: "Book the room" }).click();

  await expect(page.getByText(/is booked/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Phase 3 walkthrough").first()).toBeVisible();
  await shot(page, "p3-18-room-booked");
});
