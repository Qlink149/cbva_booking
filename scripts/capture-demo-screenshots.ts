/**
 * Regenerates every screenshot docs/DEMO-GUIDE.md embeds, in one command.
 *
 * `npx tsx scripts/capture-demo-screenshots.ts [baseUrl]`
 *
 * Defaults to http://127.0.0.1:8081 (a local `npm run start:local`, or
 * `npm run dev`); pass the deployed URL to shoot against production instead.
 * Writes into `docs/images/demo/`, overwriting whatever is there — the guide
 * never hand-places a shot this script cannot reproduce.
 *
 * Signs in the same way the role switcher does — POST /api/session with a
 * seeded email — so every shot is real product state, not a fabricated
 * fixture. Where a shot needs to catch a moment (a dialog open, a toggle on,
 * a booking mid-flow), the script drives the exact UI action a demo presenter
 * would.
 */
import { chromium, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:8081";
const OUT_DIR = path.join(process.cwd(), "docs", "images", "demo");
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORT = { width: 1440, height: 900 };

const PERSONA = {
  admin: "aarav.agarwal@cbva.in", // Partner, admin — the default identity
  manager: "aparna.modi@cbva.in", // Manager — on-behalf booking, room booking
  article: "ananya.gokhale@cbva.in", // Article — the group the policy targets
} as const;

async function signInAs(page: Page, email: string) {
  const res = await page.request.post("/api/session", { data: { email } });
  if (!res.ok()) throw new Error(`sign-in as ${email} failed: ${res.status()}`);
}

async function resetClock(page: Page) {
  await page.request.post("/api/clock", { data: { action: "reset" } });
}

async function settled(page: Page) {
  await page.getByLabel("Sign in as a different person (demo)").waitFor({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
}

/**
 * This environment's dev server is intermittently slow on the first hit of a
 * heavy route after a while idle — not a bug in the app, just where this
 * script happens to run. Retrying the whole navigate-and-settle step, rather
 * than only lengthening timeouts, is what actually recovers: a retry lands on
 * a warm route the second time.
 */
async function gotoSettled(page: Page, path: string, attempts = 3): Promise<void> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(path, { waitUntil: "load" });
      await settled(page);
      return;
    } catch (err) {
      lastErr = err;
      console.log(`  (retrying ${path}, attempt ${i} failed: ${(err as Error).message.split("\n")[0]})`);
    }
  }
  throw lastErr;
}

/**
 * The admin and analytics screens paint their shell fast and then wait on a
 * client-side fetch — documented as a 4-5 second "content visible" delay
 * (PHASE-5-HANDOFF §8). A fixed short wait shoots the loading skeleton
 * instead of the screen. Every labelled skeleton in this app carries
 * `role="status"` (`src/components/ui/skeleton.tsx`), so wait for one to
 * appear and then clear, rather than guessing a delay per screen.
 */
async function waitForContent(page: Page, timeout = 10_000) {
  const status = page.locator('[role="status"]').first();
  await status.waitFor({ state: "attached", timeout: 2_000 }).catch(() => {});
  await status.waitFor({ state: "detached", timeout }).catch(() => {});
  await page.waitForTimeout(500);
}

async function shot(page: Page, name: string, opts: { fullPage?: boolean } = {}) {
  await page.screenshot({
    path: path.join(OUT_DIR, `${name}.png`),
    fullPage: opts.fullPage ?? true,
  });
  console.log(`  ${name}.png`);
}

async function main() {
  console.log(`Capturing against ${BASE_URL} → ${OUT_DIR}\n`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, baseURL: BASE_URL });
  let page = await context.newPage();
  const configurePage = (p: typeof page) => {
    p.setDefaultNavigationTimeout(60_000);
    p.setDefaultTimeout(45_000);
  };
  configurePage(page);

  // ---- reset the shared demo clock first, so nothing here shoots a floor
  // still showing a previous run's advanced state. ----
  await gotoSettled(page, "/");
  await resetClock(page);

  console.log("Home");
  await signInAs(page, PERSONA.admin);
  await gotoSettled(page, "/");
  await shot(page, "home-signed-in");

  console.log("\nFloor plan — 2D, list, 3D");
  await signInAs(page, PERSONA.article);
  await gotoSettled(page, "/floor");
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(900);
  await shot(page, "floor-2d-whole-floor");

  await page.getByRole("switch", { name: /Occupancy labels/i }).click();
  await page.waitForTimeout(400);
  await shot(page, "floor-2d-occupancy-labels-on");
  await page.getByRole("switch", { name: /Occupancy labels/i }).click(); // back off

  await page.getByRole("radio", { name: "Zone C" }).click();
  await page.waitForTimeout(900);
  await shot(page, "floor-2d-zone-focus");
  await page.getByRole("radio", { name: "Whole floor" }).click();
  await page.waitForTimeout(700);

  await page.getByRole("radio", { name: "List" }).click();
  await page.getByRole("table").waitFor();
  await shot(page, "floor-list-view");
  await page.getByRole("radio", { name: "Plan", exact: true }).click();
  await page.waitForTimeout(500);

  await page.getByRole("radio", { name: "3D view" }).click({ noWaitAfter: true });
  await page
    .waitForFunction(() => (window as any).__cbva3d?.frames > 6, undefined, { timeout: 60_000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, "floor-3d-view");

  // A fresh page/tab, not a reload on this one — WebGL/three.js leaves real
  // GPU and memory pressure behind in a tab that rendered it, and on this
  // environment's constrained resources that pressure is what was making the
  // NEXT navigation on the same tab hang. A new tab in the same context (the
  // session cookie lives on the context, not the tab) sidesteps it entirely.
  await page.close();
  page = await context.newPage();
  configurePage(page);

  console.log("\nBooking a desk, on behalf");
  // The furthest day in the strip is the safest bet for a free desk, after
  // repeated test runs against this same local database.
  await gotoSettled(page, "/floor");
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
  const dateRadios = page.getByRole("radiogroup", { name: "Booking date" }).getByRole("radio");
  await dateRadios.last().click();
  await page.waitForTimeout(700);
  const availableSeat = page.locator("[data-seat][data-status='available']").first();
  await availableSeat.waitFor({ timeout: 15_000 });
  await availableSeat.click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(300);
  await shot(page, "floor-booking-dialog", { fullPage: false });
  const closeBtn = page.getByRole("button", { name: "Close", exact: true });
  if (await closeBtn.count()) await closeBtn.click();
  await page.waitForTimeout(300);

  console.log("\nMy Bookings");
  await gotoSettled(page, "/bookings");
  await shot(page, "bookings-upcoming");
  const myDeskTab = page.getByRole("tab", { name: /my desk/i });
  if (await myDeskTab.count()) {
    await myDeskTab.click();
    await page.waitForTimeout(400);
    await shot(page, "bookings-recurring-and-releases");
  }

  console.log("\nWho's In, Your Settings");
  await gotoSettled(page, "/who");
  await waitForContent(page);
  await shot(page, "who-is-in");

  await gotoSettled(page, "/me");
  await waitForContent(page);
  await shot(page, "me-settings");

  console.log("\nMeeting Rooms");
  await gotoSettled(page, "/rooms");
  await waitForContent(page);
  await page.getByRole("table").waitFor({ timeout: 20_000 }).catch(() => {});
  await shot(page, "rooms-grid");

  console.log("\nCheck-in page (via a QR link)");
  const seatsRes = await page.request.get("/api/floor?date=" + (await currentDate(page)) + "&slot=AM");
  const seatsBody = (await seatsRes.json().catch(() => null)) as { seats?: Array<{ seatCode: string }> } | null;
  const anySeat = seatsBody?.seats?.[0]?.seatCode ?? "1";
  await gotoSettled(page, `/checkin/${anySeat}`);
  await shot(page, "checkin-page");

  console.log("\nDemo controls panel — clock + badge");
  await gotoSettled(page, "/floor");
  await page.getByRole("button", { name: /demo controls/i }).click();
  await page.waitForTimeout(400);
  await shot(page, "demo-panel-open", { fullPage: false });
  await page.keyboard.press("Escape").catch(() => {});
  await resetClock(page);

  console.log("\nAdmin — switching to Aarav (Partner, Admin)");
  await signInAs(page, PERSONA.admin);
  await gotoSettled(page, "/admin");
  await shot(page, "admin-index");

  await gotoSettled(page, "/admin/analytics");
  await waitForContent(page);
  await shot(page, "admin-analytics-trends");

  await gotoSettled(page, "/admin/analytics/today");
  await waitForContent(page);
  await shot(page, "admin-analytics-today");

  await gotoSettled(page, "/admin/analytics/forecast");
  await waitForContent(page);
  await shot(page, "admin-analytics-forecast");

  await gotoSettled(page, "/admin/seats");
  await waitForContent(page);
  await shot(page, "admin-seats");

  await gotoSettled(page, "/admin/users");
  await waitForContent(page);
  await shot(page, "admin-users");

  await gotoSettled(page, "/admin/settings");
  await waitForContent(page);
  await shot(page, "admin-settings");

  await gotoSettled(page, "/admin/floor-plan");
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(900);
  await shot(page, "admin-floor-plan-editor");

  await gotoSettled(page, "/admin/jobs");
  await waitForContent(page);
  await shot(page, "admin-jobs");

  await gotoSettled(page, "/admin/audit");
  await waitForContent(page);
  await shot(page, "admin-audit");

  await gotoSettled(page, "/admin/notifications");
  await waitForContent(page);
  await shot(page, "admin-notifications");

  await gotoSettled(page, "/admin/qr");
  await page.locator(".qr-card").last().waitFor({ timeout: 30_000 });
  await shot(page, "admin-qr");

  console.log("\nStyle guide");
  await gotoSettled(page, "/styleguide");
  await shot(page, "styleguide");

  await resetClock(page);
  await browser.close();
  console.log(`\nDone. ${OUT_DIR}`);
}

async function currentDate(page: Page): Promise<string> {
  const res = await page.request.get("/api/floor/dates");
  const body = (await res.json()) as { days: Array<{ date: string }> };
  return body.days[0]?.date ?? new Date().toISOString().slice(0, 10);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
