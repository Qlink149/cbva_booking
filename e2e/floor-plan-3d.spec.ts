import { expect, test, type Page } from "@playwright/test";

/**
 * The 3D floor plan, in a real browser.
 *
 * Headless Chromium runs WebGL2 through SwiftShader, which is a SOFTWARE
 * rasteriser. That is perfect for everything structural here — draw calls,
 * triangle counts, picking, the shared selection — because those are properties
 * of the scene graph and identical on any renderer. It is useless for frame
 * rate, so no test asserts fps: that number is measured on real hardware and
 * reported in the handoff instead of being quietly faked here.
 */

interface Cbva3dStats {
  fps: number;
  calls: number;
  triangles: number;
  dpr: number;
  frames: number;
  /** Phase 7: the LOD level and the camera distance that decided it. */
  lod: "seat" | "bay";
  distance: number;
}

/**
 * Four minutes, not the suite's sixty seconds.
 *
 * That default was set for DOM tests and is right for them. Here every frame is
 * rasterised on the CPU: a scene that takes a GPU about 5 ms takes SwiftShader
 * the better part of a second, and simply reaching a settled scene costs half a
 * minute. This is not papering over slowness — the slowness is the renderer the
 * machine has, and the assertions underneath are exact.
 */
test.describe.configure({ timeout: 240_000 });

/**
 * Tracing off, for this file only.
 *
 * The desk sweep below makes on the order of a hundred pointer moves, and the
 * trace recorder snapshots the DOM on every one. That turned a sweep that takes
 * seconds unattended into one that blew the four-minute timeout — the test was
 * not slow, watching it was. The assertions here are exact enough that a trace
 * adds little, and the screenshots are captured separately either way.
 */
test.use({ trace: "off" });

async function openFloor(page: Page) {
  await page.goto("/floor");
  await page.getByLabel("Sign in as a different person (demo)").waitFor();
  // 60s, not 30: this file runs eleven software-rasterised scenes back to
  // back, and the first paint of the 2D plan queues behind them.
  await page.locator("[data-seat]").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(600);
}

async function enter3d(page: Page) {
  await page.getByRole("radio", { name: "3D view" }).click({ noWaitAfter: true });
  await page.waitForSelector('[data-floor-3d="ready"]', { timeout: 120_000 });
  // A few frames, so the perf probe has something to say and the camera has
  // finished its opening flight.
  await page.waitForFunction(() => (window.__cbva3d?.frames ?? 0) > 8, undefined, {
    timeout: 120_000,
  });
}

const stats = (page: Page) => page.evaluate(() => window.__cbva3d as Cbva3dStats);

/**
 * Sweep the pointer across the canvas until the scene reports a desk under it,
 * optionally restricted to a set of seat codes.
 *
 * Two things had to be got right here, and both were got wrong first.
 *
 * CLICKING IS THE WRONG PROBE. The first version clicked around the canvas
 * until a booking dialog appeared. Every click re-rendered a software-rasterised
 * scene, so a sweep cost minutes and timed out. Hovering is far cheaper — the
 * raycast is CPU work, independent of how slowly the frame draws — and
 * `data-focused-seat` reports the answer, so this asks the real raycaster
 * exactly one question per probe and leaves the pointer sitting on the hit.
 *
 * AND IT HAS TO ZOOM IN FIRST. At whole-floor framing the building is 90 metres
 * across in about 1,200 pixels, so a 1.3 m desk is roughly eight pixels wide and
 * a grid fine enough to land on one is enormous. Filtering to a wing first makes
 * a desk about 30 pixels across, which a sane grid hits — and it exercises the
 * shared zone filter on the way past.
 *
 * Deliberately not a projection computed inside the test: reimplementing the
 * camera transform here would test the test rather than the scene.
 */
async function hoverSeat(page: Page, allowed?: string[]): Promise<string> {
  await page.getByRole("radio", { name: "Zone D" }).click({ noWaitAfter: true });
  await page.waitForTimeout(4000);

  const view = page.locator("[data-focused-seat]");
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("the 3D canvas has no box");

  for (let gy = 0.2; gy <= 0.9; gy += 0.03) {
    for (let gx = 0.1; gx <= 0.95; gx += 0.02) {
      await page.mouse.move(box.x + box.width * gx, box.y + box.height * gy);
      const code = await view.getAttribute("data-focused-seat");
      if (code && (!allowed || allowed.includes(code))) return code;
    }
  }
  throw new Error("no desk was found under any probe point on the canvas");
}

test.describe("the 3D floor plan", () => {
  test("the plan is the default, and 3D is something you choose", async ({ page }) => {
    await openFloor(page);
    await expect(page.getByRole("radio", { name: "Plan view" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.locator("canvas")).toHaveCount(0);
    // The keyboard-operable rendering is what is on screen until asked.
    await expect(page.locator("[data-seat]")).toHaveCount(158);
  });

  test("renders the whole floor inside the draw call budget", async ({ page }) => {
    await openFloor(page);
    await enter3d(page);

    const s = await stats(page);
    // The budget is 60. One textured floor plane, its backing slab, three
    // merged wall meshes, two instanced furniture meshes and the status panels
    // — everything else in the scene is lighting.
    expect(s.calls).toBeLessThan(60);
    expect(s.calls).toBeGreaterThan(4);
    // 534 wall chains and 282 pieces of instanced furniture. If this collapses,
    // something stopped rendering; if it explodes, something stopped instancing.
    expect(s.triangles).toBeGreaterThan(20_000);
    expect(s.triangles).toBeLessThan(120_000);
  });

  /**
   * Status LOD in 3D. At whole-floor framing a 0.34 m glyph plate is sub-pixel,
   * so the plates are dropped and one merged bay-plate mesh answers the density
   * question instead. This is assertable rather than only visible because
   * window.__cbva3d carries the level and the camera distance.
   */
  test("switches to bay detail at whole-floor distance and back on a zone", async ({
    page,
  }) => {
    await openFloor(page);
    await enter3d(page);

    const wide = await stats(page);
    expect(wide.distance).toBeGreaterThan(70);
    expect(wide.lod).toBe("bay");
    // The switch REPLACES up to six per-status glyph meshes with one merged
    // plate mesh, so the budget is spent DOWN by it, never up.
    expect(wide.calls).toBeLessThan(60);

    await page.getByRole("radio", { name: "Zone C" }).click();
    await page.waitForTimeout(5000);

    const near = await stats(page);
    expect(near.distance).toBeLessThan(70);
    expect(near.lod).toBe("seat");
    expect(near.calls).toBeLessThan(60);
    expect(near.triangles).toBeGreaterThan(20_000);
    expect(near.triangles).toBeLessThan(120_000);
  });

  /**
   * ADR-044. The static furniture layer must be DRAWN and must be INERT.
   *
   * Drawn: four more instanced meshes, one per kind, and the triangles to go
   * with 318 boxes. If a class stops rendering, zones A and B go back to being
   * bare plate, which is the only thing this layer was built for.
   *
   * Inert: it adds nothing to the DOM. It also cannot steal a pick — none of
   * it has a pointer handler, so it has no seat code to report. The failure it
   * COULD cause is blocking one, by standing in front of a desk without
   * `raycast={() => null}`; that is guarded by the pick test below, which
   * filters to Zone D — a wing that now carries 81 furniture boxes of its own.
   */
  test("the static furniture is drawn, and adds nothing to the DOM", async ({ page }) => {
    await openFloor(page);
    await enter3d(page);

    const s = await stats(page);
    // Phase 4 measured 11 calls and ~40k triangles with no furniture layer.
    // Four instanced kinds put it at 15. Phase 8 / A1 made the bay-density
    // plate one of two independent, off-by-default toggles rather than an
    // always-on draw at bay LOD, so the floor this test lands on (whole-floor,
    // default toggle state) is 12 rather than the old default-on 13 — still a
    // long way inside the budget of 60.
    expect(s.calls).toBeGreaterThanOrEqual(12);
    expect(s.calls).toBeLessThan(60);
    expect(s.triangles).toBeGreaterThan(40_000);
    expect(s.triangles).toBeLessThan(120_000);
    // 318 boxes, and not one of them is an element.
    await expect(page.locator("[data-seat]")).toHaveCount(0);
  });

  test("the DOM stays out of it — no per-seat nodes, no CAD linework", async ({ page }) => {
    await openFloor(page);
    await enter3d(page);

    // The 2D plan's 158 buttons are gone; the scene draws seats, it does not
    // mint elements for them. And the ADR-019 promise still holds: the drawing
    // is a raster, never thousands of paths.
    await expect(page.locator("[data-seat]")).toHaveCount(0);
    expect(await page.locator("svg path").count()).toBeLessThan(50);
    await expect(page.locator("canvas")).toHaveCount(1);
  });

  test("the raycaster resolves a pick back to a real seat code", async ({ page }) => {
    await openFloor(page);
    await enter3d(page);

    const code = await hoverSeat(page);
    // R009 seat codes are the architect's desk numbers, 1-158.
    expect(code).toMatch(/^\d{1,3}$/);

    // And it is one of the desks the floor actually has, not a stray index.
    await page.getByRole("radio", { name: "Plan view" }).click({ noWaitAfter: true });
    await page.waitForSelector("[data-seat]", { timeout: 30_000 });
    await expect(page.locator(`[data-seat="${code}"]`)).toHaveCount(1);
  });

  test("a seat chosen in 3D is still the seat chosen in 2D", async ({ page }) => {
    // THE ARCHITECTURE RULE, asserted. One seat array, one store, one
    // selection — not two renderings kept in sync.
    await openFloor(page);

    // Pick a desk the viewer can actually act on, so the click selects rather
    // than being correctly ignored. Which desks those are is the plan's own
    // judgement, read straight off the 2D markers.
    const bookable = await page
      .locator('[data-seat][data-status="available"], [data-seat][data-status="auto_released"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-seat") ?? ""));
    expect(bookable.length).toBeGreaterThan(0);

    await enter3d(page);
    const picked = await hoverSeat(page, bookable);

    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator(`[data-selected-seat="${picked}"]`)).toHaveCount(1);
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog").locator(".seat-code").first()).toHaveText(picked);

    // Switch renderings WITH THE DIALOG STILL OPEN. The same desk must still be
    // the selected one, because it is one value in one store rather than two
    // views being kept in step.
    //
    // Two deliberate departures from how the rest of the suite drives the UI,
    // both forced by the dialog being modal.
    //
    // `data-mode` rather than `getByRole`: Radix marks everything behind an
    // open dialog `aria-hidden`, so the toggle is not in the accessibility tree
    // at all and a role query does not merely fail to click it, it fails to
    // find it. That is correct behaviour for a modal and the right thing for a
    // screen reader; it just means the test needs a different handle.
    //
    // `dispatchEvent` rather than `click`: a real click would first move the
    // pointer off the canvas, firing `pointerout` and clearing the hover — the
    // act of reaching for the toggle would destroy part of the state being
    // observed. Dispatching at the element runs React's handler exactly as it
    // would for a person who reached the control another way.
    await page.locator('[data-mode="2d"]').dispatchEvent("click");
    await page.waitForSelector("[data-seat]", { timeout: 60_000 });
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").locator(".seat-code").first()).toHaveText(picked);
    // And the plan is showing that desk too, from the same array.
    await expect(page.locator(`[data-seat="${picked}"]`)).toHaveCount(1);
  });

  test("the zone filter is shared, and drives the camera", async ({ page }) => {
    await openFloor(page);
    await enter3d(page);
    const before = await stats(page);

    await page.getByRole("radio", { name: "Zone C" }).click({ noWaitAfter: true });
    await page.waitForTimeout(4000);

    const after = await stats(page);
    expect(after.frames).toBeGreaterThan(before.frames);
    // Zone C holds 66 of the 158 desks, so the scene really did shed geometry.
    expect(after.triangles).toBeLessThan(before.triangles);

    // And it round-trips through the URL with everything else.
    await expect(page).toHaveURL(/zone=C/);
    await expect(page).toHaveURL(/mode=3d/);
  });

  test("top down eases to a plan-like camera", async ({ page }) => {
    await openFloor(page);
    await enter3d(page);

    await page.getByRole("button", { name: "Top down" }).click({ noWaitAfter: true });
    await page.waitForTimeout(3000);
    await expect(page.getByRole("button", { name: "Angled view" })).toBeVisible();

    const s = await stats(page);
    expect(s.calls).toBeLessThan(60);
  });

  test("a deep link opens straight into 3D", async ({ page }) => {
    await page.goto("/floor?mode=3d");
    await page.getByLabel("Sign in as a different person (demo)").waitFor();
    await expect(page.getByRole("radio", { name: "3D view" })).toHaveAttribute(
      "aria-checked",
      "true",
      { timeout: 30_000 },
    );
    await page.waitForSelector('[data-floor-3d="ready"]', { timeout: 120_000 });
  });

  test("falls back to the plan, quietly, when WebGL is unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      // Exactly what an old machine or a locked-down browser presents.
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        id: string,
        ...rest: unknown[]
      ) {
        if (id === "webgl" || id === "webgl2" || id === "experimental-webgl") return null;
        return (original as (...a: unknown[]) => unknown).call(this, id, ...rest);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });

    await openFloor(page);
    await page.getByRole("radio", { name: "3D view" }).click({ noWaitAfter: true });

    await expect(page.locator('[data-floor-3d="fallback"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-floor-3d="fallback"]')).toHaveAttribute(
      "data-fallback-reason",
      "unsupported",
    );
    // The point of the fallback: the floor is still completely usable.
    await expect(page.locator("[data-seat]")).toHaveCount(158);
    await expect(page.locator("canvas")).toHaveCount(0);
  });

  test("the list view is reachable from 3D, and beats it", async ({ page }) => {
    await openFloor(page);
    await enter3d(page);

    // 3D is not the accessible path, so the way to a keyboard-operable view has
    // to stay visible while it is showing.
    await page.getByRole("radio", { name: "List" }).click({ noWaitAfter: true });
    await expect(page.getByText("158 of 158 seats")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("canvas")).toHaveCount(0);
  });

  test("the canvas is labelled as a picture, not as an application", async ({ page }) => {
    await openFloor(page);
    await enter3d(page);
    await expect(page.getByRole("img", { name: /Three-dimensional view of Floor 4/ })).toBeVisible();
    // Never `role="application"`: that would announce an interactive widget and
    // then fail to behave like one (ADR-032).
    await expect(page.locator('canvas[role="application"]')).toHaveCount(0);
  });
});
