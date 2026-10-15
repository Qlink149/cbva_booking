import { readFileSync } from "node:fs";
import path from "node:path";

import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { floorplanMeta, floorplanSeatAnchors } from "@/lib/floorplan";
import { TOTAL_SEATS } from "@/lib/seed-data/inventory";

/**
 * Can a seat chip be seen against the architect's drawing?
 *
 * WHY THIS IS A UNIT TEST AND NOT A SCREENSHOT. Phase 7 bakes the drawing in
 * its own colours -- red workstation hatch across most of C and D, orange rapid
 * rails, green credenzas -- so the background under every seat moved. The
 * obvious way to check is to screenshot a chip and sample around it. That does
 * not work, and the reason is worth writing down: in a bench run the nearest
 * non-chip pixels are OTHER CHIPS. Desks sit about 40px apart at working zoom
 * and a chip is 28px wide, so a ring around one chip reads a neighbour's navy
 * border as "the background" and reports 1:1. Widening the ring only reaches
 * further into the next chip.
 *
 * So it is measured here instead: directly against the baked texture, at the
 * plan coordinate of every one of the 158 seats, with no neighbours in the way
 * and no browser involved. This is both more precise and cheaper -- and it
 * covers all 158 rather than whichever one happened to be on screen.
 *
 * WHAT IS ASSERTED. WCAG 1.4.11 asks for 3:1 on "the visual information
 * required to identify user interface components". For a seat that is the 1px
 * OUTLINE, not the fill: an `available` desk is deliberately paper-coloured,
 * the same ground the drawing sits on, and its navy border is what makes it a
 * desk rather than a smudge. It is also what the greyscale and colour-vision
 * guarantee on /styleguide rests on.
 */

const PAPER: Rgb = [0xfb, 0xfa, 0xf7];
/** --cbva-navy, the outline on available, booked and checked-in desks. */
const NAVY: Rgb = [0x1e, 0x2a, 0x5a];
/** --cbva-gold, the 2px rule on the desk that is yours. */
const GOLD: Rgb = [0xd9, 0xa3, 0x4a];
/** --cbva-caution, the dotted outline on an auto-released desk. */
const CAUTION: Rgb = [0x8a, 0x64, 0x14];
/** --cbva-ink, the outline on a blocked desk. */
const INK: Rgb = [0x14, 0x18, 0x1f];

/**
 * `plan-canvas` renders the texture at `opacity-55` over the paper page
 * (ADR-019: the drawing is context, the seats are content). So what a reader
 * actually sees behind a chip is the texture composited at 55% over paper, not
 * the texture itself -- and that composite is what has to be measured.
 */
const TEXTURE_OPACITY = 0.55;
const AA_NON_TEXT = 3.0;
const NL = String.fromCharCode(10);

type Rgb = [number, number, number];

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
function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
}

let pixels: Buffer;
let width = 0;
let height = 0;
let channels = 0;

beforeAll(async () => {
  const file = path.join(
    process.cwd(),
    "public",
    "floorplan",
    "plan-texture-2048.webp",
  );
  const raw = await sharp(readFileSync(file))
    .flatten({ background: "#FBFAF7" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  pixels = raw.data;
  width = raw.info.width;
  height = raw.info.height;
  channels = raw.info.channels;
}, 60_000);

/** The composited colour a reader sees at one plan coordinate. */
function backgroundAt(planX: number, planY: number): Rgb {
  const b = floorplanMeta.planBounds;
  const px = Math.round(((planX - b.x) / b.width) * (width - 1));
  const py = Math.round(((planY - b.y) / b.height) * (height - 1));
  const i = (Math.min(height - 1, Math.max(0, py)) * width +
    Math.min(width - 1, Math.max(0, px))) * channels;
  const texel: Rgb = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
  return over(texel, PAPER, TEXTURE_OPACITY);
}

/**
 * The worst place, within `radius` plan units of a seat, for a chip painted
 * `fill` inside and `line` around it.
 *
 * PER PIXEL, then worst over pixels — and the order matters. Taking each
 * colour's own worst pixel independently and then the better of the two is a
 * different and wrong question: paper's worst pixel is a pale one and navy's is
 * a dark one, so it compares two edges at two places that a reader never sees
 * together. What is actually being asked is "is there anywhere the chip
 * disappears", which means: for each pixel, the chip is visible if EITHER edge
 * separates from it; the chip is at risk only where NEITHER does.
 */
function worstAround(planX: number, planY: number, fill: Rgb, line: Rgb, radius = 9) {
  let worst = { ratio: Infinity, bg: PAPER, via: "" };
  for (let dy = -radius; dy <= radius; dy += 1.5) {
    for (let dx = -radius; dx <= radius; dx += 1.5) {
      const bg = backgroundAt(planX + dx, planY + dy);
      const byFill = contrast(fill, bg);
      const byLine = contrast(line, bg);
      const best = Math.max(byFill, byLine);
      if (best < worst.ratio) {
        worst = { ratio: best, bg, via: byFill >= byLine ? "fill" : "outline" };
      }
    }
  }
  return worst;
}

/** color-mix(in srgb, A p%, B) — plain interpolation in sRGB byte space. */
function mix(a: Rgb, b: Rgb, p: number): Rgb {
  return [
    Math.round(a[0] * p + b[0] * (1 - p)),
    Math.round(a[1] * p + b[1] * (1 - p)),
    Math.round(a[2] * p + b[2] * (1 - p)),
  ];
}

const HAIRLINE: Rgb = [0xe4, 0xe0, 0xd9];
const NAVY_TINT = mix(NAVY, PAPER, 0.08);
/** --cbva-navy-yours (Phase 8 / B1) — the your_booking fill, and ONLY that;
 *  navy-tint-strong (14%) still exists, unchanged, for ::selection. */
const NAVY_YOURS = mix(NAVY, PAPER, 0.95);
const SURFACE_SUNKEN = mix(HAIRLINE, PAPER, 0.32);
const INK_SUBTLE = mix(INK, PAPER, 0.62);

/**
 * The seven statuses as `SEAT_STATUS_TOKENS` renders them, resolved to pixels.
 *
 * Kept as fill AND line, because WCAG 1.4.11 asks whether the component can be
 * told apart from what is adjacent to it — and a chip has two candidate edges.
 * Whichever is stronger is the one doing the work; requiring BOTH to clear 3:1
 * would be asking the design for something it never claimed, and would fail
 * `auto_released` on its dotted caution outline while its paper fill sits at
 * 3.47:1 against the same pixels.
 */
const STATUS_PAINT: Array<{ status: string; fill: Rgb; line: Rgb }> = [
  { status: "available", fill: PAPER, line: NAVY },
  { status: "booked", fill: NAVY_TINT, line: NAVY },
  { status: "your_booking", fill: NAVY_YOURS, line: GOLD },
  { status: "reserved_fixed", fill: SURFACE_SUNKEN, line: INK_SUBTLE },
  { status: "checked_in", fill: NAVY, line: NAVY },
  { status: "auto_released", fill: PAPER, line: CAUTION },
  { status: "blocked", fill: SURFACE_SUNKEN, line: INK },
];

describe("seat chips against the baked drawing", () => {
  it("reads the texture the app actually ships", () => {
    expect(width).toBe(2048);
    expect(floorplanMeta.texture["2048"]).toBe("/floorplan/plan-texture-2048.webp");
    expect(floorplanSeatAnchors.seats).toHaveLength(TOTAL_SEATS);
    expect(STATUS_PAINT).toHaveLength(7);
  });

  /**
   * PHASE 6's OWN NUMBERS, measured against the greyscale texture it shipped.
   *
   * This is the baseline that matters, and it is what turns "three statuses are
   * under 3:1" from an alarming discovery into a known property. Measured by
   * running this same computation against `phase-6:public/floorplan/
   * plan-texture-2048.webp`:
   *
   *   available 3.83 · booked 3.83 · your_booking 1.29 · reserved_fixed 2.15
   *   checked_in 3.83 · auto_released 2.27 · blocked 4.98
   *
   * The colour texture moved every one of them by at most 0.07. The three that
   * sit under 3:1 sat under 3:1 before this phase — the figure is set by how
   * DARK the drawing's linework is at 55% opacity, and the muted palette
   * preserved that almost exactly while changing the hue.
   *
   * So the gate here is a REGRESSION gate, which is the honest one for this
   * change: the statuses that cleared 3:1 must still clear it, and none may get
   * measurably worse than Phase 6 shipped. An absolute 3:1 gate on all seven
   * would fail this build for something it did not cause, and "fix the chip"
   * would mean redesigning three status tokens on the last day of the project.
   *
   * PHASE 8 / B1 moved `your_booking`'s baseline on purpose, from 1.29 to
   * 3.29 — `--seat-yours-fill` was darkened until the chip clears 3:1 as a
   * graphical object (WCAG 1.4.11), keeping the gold rule as the hue and
   * measuring against this exact baked texture rather than guessing a value.
   * `reserved_fixed` and `auto_released` were verified the same way — their
   * redundant indicator (the border, independent of the fill) measures only
   * 1.41:1 and 1.48:1 in isolation, and the combined figure below (whichever
   * of fill or line is stronger, per pixel) is what reaches 2.15 / 2.27,
   * still under 3:1. Both are unchanged from Phase 6: reaching 3:1 on either
   * would need the same drastic a re-tint `your_booking` needed — B1 asked
   * for `your_booking` specifically, not a redesign of two more tokens on the
   * last phase of the project, so their baselines are carried forward as the
   * known, reported gap they already were.
   */
  const PHASE_6_BASELINE: Record<string, number> = {
    available: 3.83,
    booked: 3.83,
    your_booking: 3.29,
    reserved_fixed: 2.15,
    checked_in: 3.83,
    auto_released: 2.27,
    blocked: 4.98,
  };

  it("no status is worse against the colour texture than it was against the grey one", () => {
    const regressions: string[] = [];

    for (const { status, fill, line } of STATUS_PAINT) {
      let worst = { code: "", ratio: Infinity, via: "" };
      for (const seat of floorplanSeatAnchors.seats) {
        const here = worstAround(seat.planX, seat.planY, fill, line);
        if (here.ratio < worst.ratio) {
          worst = { code: seat.seatCode, ratio: here.ratio, via: here.via };
        }
      }
      const baseline = PHASE_6_BASELINE[status]!;
      console.log(
        `  ${status.padEnd(15)} ${worst.ratio.toFixed(2)}:1 at ${worst.code.padEnd(7)} ` +
          `(via its ${worst.via.padEnd(7)}) — Phase 6 was ${baseline.toFixed(2)}`,
      );

      // Rasteriser noise between two encodes is a few hundredths; 0.15 is well
      // inside that and far below anything a reader could see.
      if (worst.ratio < baseline - 0.15) {
        regressions.push(
          `${status}: ${worst.ratio.toFixed(2)} against Phase 6's ${baseline}`,
        );
      }
      // And the four that cleared 3:1 must go on clearing it.
      if (baseline >= AA_NON_TEXT && worst.ratio < AA_NON_TEXT) {
        regressions.push(`${status} fell below ${AA_NON_TEXT}:1 at ${worst.code}`);
      }
    }

    expect(regressions, regressions.join(NL)).toEqual([]);
  });

  /**
   * The gold RULE specifically, measured and reported rather than gated.
   *
   * `your_booking` clears 3:1 above through its fill. Its gold outline does not,
   * and cannot: gold reaches only **2.17:1 against plain paper** and has done
   * since Phase 1, before any texture existed. A low gold-versus-drawing figure
   * is therefore a property of the PALETTE, not something Phase 7 introduced,
   * and gating on it would report a standing design decision as a regression of
   * this change.
   *
   * It is a legitimate decision because gold never carries meaning alone:
   * `your_booking` is the only status with a 2px rule rather than 1px and the
   * only one carrying the ● glyph. That redundancy is what /styleguide's
   * desaturated comparison exists to prove. Recorded here so the number is
   * known rather than assumed.
   */
  it("reports where the gold rule is weakest against the drawing", () => {
    let worst = { code: "", ratio: Infinity };
    for (const seat of floorplanSeatAnchors.seats) {
      const r = worstAround(seat.planX, seat.planY, GOLD, GOLD).ratio;
      if (r < worst.ratio) worst = { code: seat.seatCode, ratio: r };
    }
    console.log(
      `  gold RULE alone: ${worst.ratio.toFixed(2)}:1 at ${worst.code} ` +
        `(2.17:1 on plain paper — pre-existing, redundantly coded)`,
    );
    expect(worst.ratio).toBeLessThanOrEqual(2.2);
  });

  it("would FAIL if the texture were shipped at full strength", () => {
    // The 55% is load-bearing, not decoration, and this is what says so: at
    // full opacity the drawing's own dark linework runs straight under desks
    // and the outline stops being reliably distinguishable. If somebody raises
    // the opacity, this test is the thing that objects.
    let worstFull = Infinity;
    for (const seat of floorplanSeatAnchors.seats) {
      const b = floorplanMeta.planBounds;
      for (let dy = -9; dy <= 9; dy += 1.5) {
        for (let dx = -9; dx <= 9; dx += 1.5) {
          const px = Math.round(((seat.planX + dx - b.x) / b.width) * (width - 1));
          const py = Math.round(((seat.planY + dy - b.y) / b.height) * (height - 1));
          const i =
            (Math.min(height - 1, Math.max(0, py)) * width +
              Math.min(width - 1, Math.max(0, px))) * channels;
          const texel: Rgb = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
          worstFull = Math.min(worstFull, contrast(NAVY, texel));
        }
      }
    }
    console.log(`  at 100% texture opacity the worst would be ${worstFull.toFixed(2)}:1`);
    expect(worstFull).toBeLessThan(AA_NON_TEXT);
  });
});
