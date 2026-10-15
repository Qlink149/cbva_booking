import { expect, test } from "@playwright/test";

/**
 * Contrast for everything drawn OVER the architect's drawing.
 *
 * WHY THIS EXISTS. Every contrast figure in this product was taken against a
 * near-white plate: ink-subtle at 4.90:1, the opaque status tints, the
 * person-picker fix. Phase 7 put the architect's drawing behind the plan in the
 * drawing's OWN colours — red workstation hatch across most of the C and D
 * wings, orange rapid rails, green credenzas — which moves the background under
 * every seat chip, bay chip and room label.
 *
 * AXE CANNOT JUDGE ANY OF IT. When it cannot reduce a background to a single
 * computed colour it returns `color-contrast` as INCOMPLETE, which is not a
 * pass. Running axe alone after this change and reporting zero violations would
 * be a false green of exactly the Phase 6 kind: a check reporting success for a
 * property nobody is testing. `accessibility.spec.ts` now prints that
 * incomplete count per surface — 44 on the floor plan — so the gap is visible
 * rather than assumed away.
 *
 * WHAT THIS SPEC DOES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * Everything here is judged from COMPUTED COLOURS or from CONSTRUCTION. There
 * is no pixel sampling, and that is a considered retreat rather than a
 * shortcut. Sampling "the worst background pixel behind the text" cannot be
 * made reliable: every glyph edge blends ink into whatever is behind it, so an
 * anti-aliased pixel is always an intermediate tone and always scores about
 * 2:1 — for ANY text on ANY background, black-on-white included. Excluding
 * pixels near the foreground helps and does not settle it, because the blend is
 * a gradient and wherever the cutoff is placed some pixel sits just past it.
 * Three successive thresholds gave 2.06, then 3.75, then would have given
 * something else again. At that point the number is a property of the threshold
 * and not of the design, and tuning it until it passes is the exact behaviour
 * these gates exist to prevent.
 *
 * The seat chips against the drawing ARE measured against real pixels — in
 * `tests/unit/texture-contrast.test.ts`, against the baked texture itself, at
 * the plan coordinate of all 158 seats. No anti-aliasing, no neighbouring chip
 * to contaminate the sample, no browser. It is a better instrument for the same
 * question, and it compares against the Phase 6 texture, so a regression is
 * distinguishable from a figure that was already there.
 */

const AA_NORMAL = 4.5;

type Rgb = [number, number, number];

interface Sample {
  what: string;
  fg: string;
  bg: string;
  ratio: number;
  needs: number;
}

function srgbToLinear(c: number) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function luminance([r, g, b]: Rgb) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrast(a: Rgb, b: Rgb) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Chrome reports a colour built with `color-mix()` as `color(srgb 0.33 0.34
 * 0.36)` — 0..1 FLOATS, not 0..255 bytes. Most of this product's tokens are
 * color-mix, so reading those three numbers as bytes turns a mid-grey into
 * near-black and reports a contrast failure that does not exist. Caught by this
 * spec's own first run, which put `reserved_fixed` at 1:1.
 */
function parseRgb(value: string): Rgb {
  const nums = (value.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const scale = value.trim().startsWith("color(") ? 255 : 1;
  return [
    Math.round((nums[0] ?? 0) * scale),
    Math.round((nums[1] ?? 0) * scale),
    Math.round((nums[2] ?? 0) * scale),
  ];
}

test("text and chips over the plan clear WCAG AA", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/floor");
  await page.getByLabel("Sign in as a different person (demo)").waitFor();
  await page.locator("[data-seat]").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1800);

  const canvas = page.locator('[role="application"]');
  const samples: Sample[] = [];

  /* ---- text drawn over the drawing, at fit-to-floor -------------------- */
  await expect(canvas).toHaveAttribute("data-lod", "bay");

  /*
   * The room labels are guaranteed by CONSTRUCTION. They are drawn with
   * `paint-order: stroke` and a PAPER stroke, so the surface behind every glyph
   * IS paper — not measured to be paper, but painted paper before the glyph
   * goes down, wherever on the drawing the label lands. Ink on paper is
   * 17.05:1, so what is asserted is that the halo is actually applied, which is
   * exact and cannot drift with the texture.
   *
   * This replaced a pixel measurement that found `ink-subtle` reaching only
   * 4.02:1 over the drawing's darker linework — below the floor, and varying
   * with whatever the label happened to sit over, which is the worse property.
   * The LABEL was changed, not the texture: the drawing is the thing being
   * reproduced faithfully; a label drawn over it is ours to make legible.
   */
  const labelPaint = await page.evaluate(() => {
    const g = document.querySelector('[role="application"] svg > g:has(> text)');
    if (!g) return null;
    const s = getComputedStyle(g);
    return {
      paintOrder: s.paintOrder,
      stroke: s.stroke,
      width: s.strokeWidth,
      fill: s.fill,
    };
  });
  expect(labelPaint, "no plan label was found").not.toBeNull();
  expect(labelPaint!.paintOrder).toContain("stroke");
  expect(labelPaint!.stroke).toBe("rgb(251, 250, 247)");
  expect(parseFloat(labelPaint!.width)).toBeGreaterThanOrEqual(2);
  const labelRatio = contrast(parseRgb(labelPaint!.fill), [0xfb, 0xfa, 0xf7]);
  console.log(
    `  room label   ${labelRatio.toFixed(2)}:1 — ${labelPaint!.fill} on a ` +
      `${labelPaint!.width} paper halo, so the drawing beneath it cannot matter`,
  );
  expect(labelRatio).toBeGreaterThanOrEqual(AA_NORMAL);

  // The bay chip carries its own opaque plate. SVG text has no
  // `background-color`, so the pair is read from the plate <rect> explicitly.
  const chipPaint = await page.evaluate(() => {
    const g = document.querySelector('[role="application"] svg g > g:has(> rect)');
    const texts = g?.querySelectorAll("text");
    const rect = g?.querySelector("rect");
    if (!rect || !texts || texts.length < 2) return null;
    return { fg: getComputedStyle(texts[1]!).fill, bg: getComputedStyle(rect).fill };
  });
  expect(chipPaint, "no bay chip was found").not.toBeNull();
  samples.push({
    what: "bay chip count",
    fg: chipPaint!.fg,
    bg: chipPaint!.bg,
    ratio:
      Math.round(contrast(parseRgb(chipPaint!.fg), parseRgb(chipPaint!.bg)) * 100) / 100,
    needs: AA_NORMAL,
  });

  /* ---- the seven status chips ------------------------------------------ */
  await canvas.focus();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("+");
    await page.waitForTimeout(350);
  }
  await expect(canvas).toHaveAttribute("data-lod", "seat");
  await page.waitForTimeout(800);

  for (const status of [
    "available",
    "booked",
    "your_booking",
    "reserved_fixed",
    "checked_in",
    "auto_released",
    "blocked",
  ]) {
    const el = page.locator(`[data-seat][data-status="${status}"]`).first();
    if ((await el.count()) === 0) continue;
    const pair = await el.evaluate((node) => {
      const s = getComputedStyle(node as Element);
      return { fg: s.color, bg: s.backgroundColor };
    });
    // A transparent chip would make the pair meaningless, and is the thing to
    // catch: it would mean a status tint had stopped being opaque and the
    // drawing was showing through its text.
    expect(pair.bg, `${status} chip is not opaque`).not.toMatch(
      /rgba\(0, 0, 0, 0\)|transparent/,
    );
    samples.push({
      what: `seat chip: ${status}`,
      fg: pair.fg,
      bg: pair.bg,
      ratio: Math.round(contrast(parseRgb(pair.fg), parseRgb(pair.bg)) * 100) / 100,
      needs: AA_NORMAL,
    });
  }

  console.log("");
  console.log("  CONTRAST FOR TEXT OVER THE PLAN — axe returns INCOMPLETE for these");
  console.log("  " + "-".repeat(74));
  for (const s of samples) {
    console.log(
      `  ${s.what.padEnd(26)} ${String(s.ratio).padStart(7)}:1  needs ${s.needs}  ` +
        `${s.ratio >= s.needs ? "PASS" : "FAIL"}`,
    );
  }
  console.log("  " + "-".repeat(74));

  expect(samples.length, "nothing measurable was found over the plan").toBeGreaterThan(5);
  for (const s of samples) {
    expect(s.ratio, s.what).toBeGreaterThanOrEqual(s.needs);
  }
});
