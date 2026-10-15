import { test, type Page } from "@playwright/test";

/** Captures the screens for visual review. Not an assertion suite. */
const PAGES = [
  ["home", "/"],
  ["styleguide", "/styleguide"],
  ["floor", "/floor"],
  ["admin-floor-plan", "/admin/floor-plan"],
  /* ---- Phase 3 ---- */
  ["bookings", "/bookings"],
  ["rooms", "/rooms"],
  ["admin-notifications", "/admin/notifications"],
  ["admin-qr", "/admin/qr"],
] as const;

const WIDTHS = [
  ["1440", 1440, 900],
  ["1280", 1280, 800],
  ["390", 390, 844],
] as const;

/**
 * The header widgets are client-rendered from /api/session and /api/clock, and
 * networkidle alone fires before they replace their skeletons. The floor plan
 * additionally waits on a seat button, because the plan mounts after two more
 * round trips and a shot taken before that is of an empty rectangle.
 */
async function settle(page: Page, path: string) {
  await page.getByLabel("Sign in as a different person (demo)").waitFor();
  // The clock readout is `hidden sm:inline`, so it is only a usable signal
  // that the header has hydrated on the wider viewports.
  if ((page.viewportSize()?.width ?? 0) >= 640) {
    await page.locator("header time").waitFor();
  }
  await page.waitForLoadState("networkidle");
  if (path === "/floor" || path === "/admin/floor-plan") {
    await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
    // The plan springs into its fit-to-floor framing on mount.
    await page.waitForTimeout(900);
  }
  if (path === "/rooms") {
    await page.getByRole("table").waitFor({ timeout: 30_000 });
  }
  if (path === "/admin/qr") {
    // 110 QR codes are generated server-side; the last one is the signal.
    await page.locator(".qr-card").last().waitFor({ timeout: 30_000 });
  }
}

for (const [name, path] of PAGES) {
  for (const [label, width, height] of WIDTHS) {
    test(`shot ${name} ${label}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(path);
      await settle(page, path);
      await page.screenshot({
        path: `screenshots/${name}-${label}.png`,
        fullPage: true,
      });
    });
  }
}

test("shot floor zone focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/floor");
  await settle(page, "/floor");
  await page.getByRole("radio", { name: "Zone C" }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "screenshots/floor-zone-c-1440.png", fullPage: true });
});

test("shot floor list view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/floor");
  await settle(page, "/floor");
  await page.getByRole("radio", { name: "List" }).click();
  await page.getByRole("table").waitFor();
  await page.screenshot({ path: "screenshots/floor-list-1440.png", fullPage: true });
});

/**
 * The 3D view, for review.
 *
 * These run against SwiftShader in headless Chromium, which is a software
 * rasteriser: a frame that takes a GPU 5 ms takes it several seconds. The
 * screenshots are therefore given a long timeout and the device pixel ratio is
 * pinned to 1 — they are for looking at, not for timing.
 *
 * The one that matters is `floor-3d-topdown`. Held against
 * `public/floorplan/plan-texture-2048.webp` it answers the only question that
 * decides whether the geometry is right: do the cruciform's arms and the wing
 * positions land on the architect's own drawing.
 */
async function open3d(page: Page, width = 1280, height = 820) {
  await page.setViewportSize({ width, height });
  await page.goto("/floor");
  await settle(page, "/floor");
  await page.getByRole("radio", { name: "3D view" }).click({ noWaitAfter: true });
  await page.waitForSelector('[data-floor-3d="ready"]', { timeout: 120_000 });
  await page.waitForFunction(() => (window.__cbva3d?.frames ?? 0) > 6, undefined, {
    timeout: 120_000,
  });
}

const SHOT = { timeout: 180_000 } as const;

/**
 * The 3D shots are PAGE screenshots, not element screenshots.
 *
 * Targeting `[data-floor-3d="ready"]` failed intermittently with "element is
 * not attached to the DOM", and the cause is not a flake worth retrying around:
 * under SwiftShader a long-running scene can genuinely lose its WebGL context,
 * at which point the view does what it is supposed to do and swaps itself for
 * the 2D plan with a notice. The element really is gone. A page screenshot
 * captures whichever of the two is showing, and shows the surrounding controls,
 * which is what these are reviewed for anyway.
 */

// Software rasterisation, as in floor-plan-3d.spec.ts. The suite default of
// sixty seconds is not enough to reach a settled frame, let alone capture one.
test.describe.configure({ timeout: 300_000 });

test("shot floor 3d default", async ({ page }) => {
  await open3d(page);
  await page.screenshot({ ...SHOT, path: "screenshots/floor-3d-default.png" });
});

test("shot floor 3d top down", async ({ page }) => {
  await open3d(page);
  await page.getByRole("button", { name: "Top down" }).click({ noWaitAfter: true });
  await page.waitForTimeout(3000);
  await page.screenshot({ ...SHOT, path: "screenshots/floor-3d-topdown.png" });
});

test("shot floor 3d zone and selection", async ({ page }) => {
  await open3d(page);
  await page.getByRole("radio", { name: "Zone C" }).click({ noWaitAfter: true });
  await page.waitForTimeout(4000);
  await page.screenshot({ ...SHOT, path: "screenshots/floor-3d-zone-c.png" });
});

test("shot floor 3d on a phone", async ({ page }) => {
  await open3d(page, 390, 844);
  await page.locator('[data-floor-3d="ready"]').screenshot({
    ...SHOT,
    path: "screenshots/floor-3d-390.png",
  });
});
