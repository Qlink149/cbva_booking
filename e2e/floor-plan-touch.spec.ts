import { expect, test, type CDPSession, type Page } from "@playwright/test";

/**
 * A3 (Phase 8) — mobile plan panning, driven by REAL touch input.
 *
 * Two candidate bugs were named going in: a touch-action/pointer-capture
 * conflict, and a layout overflow independent of touch. Both were checked
 * here rather than assumed.
 *
 * WHY CDP, NOT `dispatchEvent`. A hand-built `pointerdown`/`pointermove` pair
 * fired via `elementHandle.dispatchEvent` is UNTRUSTED — the browser's pointer
 * machinery never saw a real touch start, so `setPointerCapture` throws
 * `InvalidPointerId` ("No active pointer with the given id is found") the
 * instant the app tries to use it, and the whole gesture silently does
 * nothing. That is not a property of a bug; it is a property of the harness.
 * `Input.dispatchTouchEvent` over the Chrome DevTools Protocol produces a
 * genuinely trusted touch sequence the browser's real input pipeline
 * processes, which is what these tests use throughout.
 *
 * FINDING, RECORDED HERE SO IT DOES NOT GET RE-INVESTIGATED. The touch-pan
 * bug was real: `use-pan-zoom.ts`'s `onPointerDown` used to bail out of
 * starting a pan entirely whenever the press landed on `[data-seat]`, and at
 * fit-to-floor on a phone the 141 seat buttons (13px, ~11px pitch) nearly
 * tile the surface — so almost every touch landed on a seat and no pan could
 * ever begin. The desktop right-edge clip did NOT reproduce: `/floor` and
 * `/admin/floor-plan` were checked at 768/900/1024/1280/1440px, with a zone
 * selected, zoomed in, and in 3D, and `document.documentElement.scrollWidth`
 * never exceeded `clientWidth` beyond the 1px sub-pixel rounding the existing
 * `shell.spec.ts` check already tolerates.
 */

async function openFloor(page: Page) {
  await page.goto("/floor");
  await page.getByLabel("Sign in as a different person (demo)").waitFor();
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(600);
}

function layerTransform(page: Page) {
  return page.evaluate(
    () => getComputedStyle(document.querySelector('[role="application"] > div')!).transform,
  );
}

/** One real, trusted touch drag from (x1,y1) to (x2,y2), in `steps` moves. */
async function touchDrag(
  cdp: CDPSession,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  steps = 10,
) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: x1, y: y1, id: 1 }],
  });
  for (let i = 1; i <= steps; i++) {
    const x = x1 + ((x2 - x1) * i) / steps;
    const y = y1 + ((y2 - y1) * i) / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** A real two-finger pinch, expanding around a stable centre point. */
async function touchPinchOut(cdp: CDPSession, x: number, y: number, steps = 8) {
  const start = 24;
  const end = 88;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: x - start, y, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: x - start, y, id: 1 },
      { x: x + start, y, id: 2 },
    ],
  });
  for (let i = 1; i <= steps; i++) {
    const distance = start + ((end - start) * i) / steps;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: x - distance, y, id: 1 },
        { x: x + distance, y, id: 2 },
      ],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [{ x: x + end, y, id: 2 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** One real, trusted tap. */
async function touchTap(cdp: CDPSession, x: number, y: number) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/**
 * An available seat whose bounding-box centre a tap can actually land on.
 *
 * At fit-to-floor on a 390px phone the 141 seat markers are documented (top
 * of file) to nearly tile the surface — the ~11px pitch is tighter than the
 * ~13px marker, so adjacent hit-areas genuinely overlap by a couple of
 * pixels. `.first()`'s bounding-box centre can therefore sit on the wrong
 * side of that overlap, and a real trusted tap there lands on the
 * NEIGHBOURING seat instead — sometimes a `reserved_fixed` one, which
 * correctly opens nothing. That is real geometry, not a bug: confirm with
 * `elementFromPoint`, the same resolution a mouse click would use, rather
 * than trusting the box blind.
 */
async function findTappableSeat(
  page: Page,
): Promise<{ seatCode: string; x: number; y: number }> {
  const codes = await page
    .locator("[data-seat][data-status='available']")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-seat")!));
  for (const code of codes) {
    const candidate = page.locator(`[data-seat="${code}"]`);
    // `elementFromPoint` only hit-tests the current viewport — most of these
    // 141 seats start scrolled out of it, and a box for an off-screen seat
    // hit-tests as nothing, not as itself.
    await candidate.scrollIntoViewIfNeeded();
    const box = await candidate.boundingBox();
    if (!box) continue;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const hit = await page.evaluate(
      ([hx, hy]) =>
        document.elementFromPoint(hx, hy)?.closest("[data-seat]")?.getAttribute("data-seat") ??
        null,
      [x, y] as const,
    );
    if (hit === code) return { seatCode: code, x, y };
  }
  throw new Error("no available seat's centre point resolved back to itself");
}

test.describe("touch on the plan, at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a tap on a seat opens the booking dialog", async ({ page, context }) => {
    await openFloor(page);
    const cdp = await context.newCDPSession(page);
    const { seatCode, x, y } = await findTappableSeat(page);

    await touchTap(cdp, x, y);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(seatCode);
  });

  test("a horizontal drag starting ON a seat pans the plan, not the dialog", async ({
    page,
    context,
  }) => {
    await openFloor(page);
    const cdp = await context.newCDPSession(page);
    const seat = page.locator("[data-seat]").first();
    await seat.scrollIntoViewIfNeeded();
    const box = (await seat.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const before = await layerTransform(page);
    await touchDrag(cdp, cx, cy, cx - 90, cy);
    await page.waitForTimeout(300);
    const after = await layerTransform(page);

    expect(after, "the plan did not pan").not.toBe(before);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("a vertical drag starting ON a seat pans the plan too", async ({ page, context }) => {
    await openFloor(page);
    const cdp = await context.newCDPSession(page);
    const seat = page.locator("[data-seat]").first();
    await seat.scrollIntoViewIfNeeded();
    const box = (await seat.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const before = await layerTransform(page);
    await touchDrag(cdp, cx, cy, cx, cy - 90);
    await page.waitForTimeout(300);
    const after = await layerTransform(page);

    expect(after, "the plan did not pan vertically").not.toBe(before);
  });

  test("a two-finger pinch out zooms the plan", async ({ page, context }) => {
    await openFloor(page);
    const cdp = await context.newCDPSession(page);
    const canvas = page.locator('[role="application"]');
    const box = (await canvas.boundingBox())!;
    const before = await layerTransform(page);

    await touchPinchOut(cdp, box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);

    expect(await layerTransform(page), "the pinch gesture did not zoom the plan").not.toBe(before);
  });

  test("a small movement stays a tap, not a pan (the slop radius)", async ({ page, context }) => {
    await openFloor(page);
    const cdp = await context.newCDPSession(page);
    const { seatCode, x: cx, y: cy } = await findTappableSeat(page);

    // Two pixels of jitter is well inside DRAG_SLOP_PX (8) — a real finger
    // is never perfectly still, and that must still register as a tap.
    await touchDrag(cdp, cx, cy, cx + 2, cy - 1, 2);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(seatCode);
  });

  test("the page still scrolls vertically from a touch that starts above the plan", async ({
    page,
    context,
  }) => {
    await openFloor(page);
    const cdp = await context.newCDPSession(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    const heading = (await page.getByRole("heading", { name: "Floor Map" }).boundingBox())!;
    const hx = heading.x + heading.width / 2;
    const hy = heading.y + heading.height / 2;

    const before = await page.evaluate(() => window.scrollY);
    await touchDrag(cdp, hx, hy, hx, hy - 150);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.scrollY);

    expect(after, "the page did not scroll").toBeGreaterThan(before);
  });

  test("zoom in, zoom out and fit-to-floor still work by real tap (Phase 2 regression)", async ({
    page,
    context,
  }) => {
    await openFloor(page);
    const cdp = await context.newCDPSession(page);

    const zoomIn = page.getByRole("button", { name: "Zoom in" });
    await zoomIn.scrollIntoViewIfNeeded();
    const box = (await zoomIn.boundingBox())!;
    const before = await layerTransform(page);
    await touchTap(cdp, box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    expect(await layerTransform(page), "zoom in did nothing").not.toBe(before);

    // A second zoom-in, so zoom-out has room to move: fit-to-floor at 390px
    // starts BELOW MIN_SCALE (0.25 against a floor of 0.35, deliberately —
    // see use-pan-zoom.ts), so a single zoom-in click already saturates at
    // the manual-zoom floor and one zoom-out click correctly cannot go lower.
    // That is the clamp working, not a regression; testing it from here
    // avoids asserting a change the clamp is required to refuse.
    const zoomInBox = (await zoomIn.boundingBox())!;
    await touchTap(cdp, zoomInBox.x + zoomInBox.width / 2, zoomInBox.y + zoomInBox.height / 2);
    await page.waitForTimeout(300);

    const zoomOut = page.getByRole("button", { name: "Zoom out" });
    const outBox = (await zoomOut.boundingBox())!;
    const beforeZoomOut = await layerTransform(page);
    await touchTap(cdp, outBox.x + outBox.width / 2, outBox.y + outBox.height / 2);
    await page.waitForTimeout(300);
    const afterZoomOut = await layerTransform(page);
    expect(afterZoomOut, "zoom out did nothing").not.toBe(beforeZoomOut);

    const fit = page.getByRole("button", { name: "Fit to floor" });
    const fitBox = (await fit.boundingBox())!;
    await touchTap(cdp, fitBox.x + fitBox.width / 2, fitBox.y + fitBox.height / 2);
    await page.waitForTimeout(700);
    // Fitting from a zoomed-in state must actually change the transform —
    // asserts the button did something rather than merely not crashing.
    expect(await layerTransform(page)).not.toBe(afterZoomOut);
  });

  test("no horizontal page overflow at 390px, at fit-to-floor and zoomed in", async ({ page }) => {
    await openFloor(page);
    const check = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
    expect(await check(), "overflows at fit-to-floor").toBe(false);

    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: "Zoom in" }).click();
      await page.waitForTimeout(150);
    }
    expect(await check(), "overflows zoomed in").toBe(false);
  });
});

test.describe("no desktop overflow, at every width the brief named", () => {
  for (const width of [768, 1024, 1280, 1440]) {
    test(`/floor at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openFloor(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflow, `/floor overflows at ${width}px`).toBe(false);
    });

    test(`/admin/floor-plan at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/admin/floor-plan");
      await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(600);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflow, `/admin/floor-plan overflows at ${width}px`).toBe(false);
    });
  }
});
