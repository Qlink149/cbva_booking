import nodePath from "node:path";

import { expect, test, type Page } from "@playwright/test";

// Playwright transpiles specs to CJS, so import.meta is not available here.
// It always runs from the project root, so cwd is the reliable anchor.
const AXE_PATH = nodePath.join(process.cwd(), "node_modules", "axe-core", "axe.min.js");

/** Spelled this way so no escape sequence can be mangled into a real one. */
const NL = String.fromCharCode(10);

interface AxeNode {
  target: string[];
  failureSummary?: string;
}
interface AxeViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  help: string;
  nodes: AxeNode[];
}
interface AxeResults {
  violations: AxeViolation[];
  incomplete: AxeViolation[];
}

/**
 * AXE CANNOT MEASURE CONTRAST AGAINST A RASTER BACKGROUND.
 *
 * When it cannot resolve what is behind a piece of text -- an image, a gradient,
 * anything it cannot reduce to a single computed colour -- `color-contrast`
 * returns INCOMPLETE rather than a violation. It is not a pass. It is axe
 * saying "I could not judge this one".
 *
 * That matters more here than in most apps, because Phase 7 put the architect's
 * drawing behind the plan in its own colours, including red workstation hatch
 * across most of the C and D wings. Every element drawn over the plan is
 * exactly the case axe declines to judge, so reporting only the violation count
 * after that change would be a false green of precisely the kind Phase 6 spent
 * itself finding.
 *
 * So the incomplete count is returned and reported alongside, and the elements
 * axe could not judge are measured directly from a screenshot -- see
 * `contrast-over-plan.spec.ts`.
 */
async function audit(page: Page): Promise<{
  violations: AxeViolation[];
  incompleteContrast: AxeViolation[];
}> {
  await page.addScriptTag({ path: AXE_PATH });
  const results = await page.evaluate(async () => {
    // @ts-expect-error axe is injected into the page above
    return (await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    })) as AxeResults;
  });
  return {
    violations: results.violations,
    incompleteContrast: (results.incomplete ?? []).filter(
      (r) => r.id === "color-contrast",
    ),
  };
}

function report(violations: AxeViolation[]) {
  return violations
    .map(
      (v) =>
        `${v.impact ?? "unknown"} · ${v.id} · ${v.help}\n` +
        v.nodes
          .slice(0, 3)
          .map((n) => `      ${n.target.join(" ")}`)
          .join("\n"),
    )
    .join("\n");
}

/**
 * Zero critical or serious violations is the bar. Anything below that is
 * printed rather than swallowed, so a regression is visible even when the
 * suite is green.
 */

const CASES: Array<[string, string, (page: Page) => Promise<void>]> = [
  [
    "floor plan",
    "/floor",
    async (page) => {
      await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
    },
  ],
  [
    "floor list view",
    "/floor",
    async (page) => {
      await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
      await page.getByRole("radio", { name: "List" }).click();
      await page.getByRole("table").waitFor();
    },
  ],
  [
    "booking dialog",
    "/floor",
    async (page) => {
      await page.locator("[data-seat][data-status='available']").first().waitFor({
        timeout: 30_000,
      });
      await page.locator("[data-seat][data-status='available']").first().click();
      await page.getByRole("dialog").waitFor();
    },
  ],
  [
    "floor plan editor",
    "/admin/floor-plan",
    async (page) => {
      await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
    },
  ],
  /* ---- Phase 3 surfaces ---- */
  [
    "my bookings",
    "/bookings",
    async (page) => {
      await page.getByRole("heading", { level: 1, name: "My Bookings" }).waitFor();
      await page.waitForTimeout(500);
    },
  ],
  [
    "meeting room grid",
    "/rooms",
    async (page) => {
      // Every hour is a real button in a table with a caption and row headers;
      // this is the surface most likely to regress into a div grid.
      await page.getByRole("table").waitFor({ timeout: 30_000 });
    },
  ],
  [
    "booking dialog",
    "/floor",
    async (page) => {
      await page.locator("[data-seat][data-status='available']").first().waitFor({
        timeout: 30_000,
      });
      await page.locator("[data-seat][data-status='available']").first().click();
      await page.getByRole("dialog").waitFor();
    },
  ],
  [
    "demo notification inbox",
    "/admin/notifications",
    async (page) => {
      await page.getByRole("heading", { level: 1, name: "Notifications" }).waitFor();
      await page.waitForTimeout(500);
    },
  ],
  [
    "desk QR sheet",
    "/admin/qr",
    async (page) => {
      await page.locator(".qr-card").first().waitFor({ timeout: 30_000 });
    },
  ],

  /* ------------------------------------------------- Phase 5 surfaces ---
   *
   * The analytics screens are the deliverable and carry the densest content in
   * the product — nine widgets, five tables and seven SVG figures on Trends
   * alone. They are also the screens most likely to grow an unlabelled control
   * as they change, so they are swept rather than trusted.
   *
   * /admin was previously not covered at all, which is how it kept an entirely
   * missing authorisation check for four phases.
   */
  [
    "admin index",
    "/admin",
    async (page) => {
      await page.getByRole("heading", { level: 1, name: "Admin" }).waitFor();
    },
  ],
  [
    "analytics — trends",
    "/admin/analytics",
    async (page) => {
      await page
        .getByRole("heading", { name: "Desks needed against desks held" })
        .waitFor({ timeout: 90_000 });
    },
  ],
  [
    "analytics — today",
    "/admin/analytics/today",
    async (page) => {
      await page.getByRole("heading", { level: 1, name: "Today on the floor" }).waitFor();
      await page.waitForTimeout(2_000);
    },
  ],
  [
    "analytics — forecast",
    "/admin/analytics/forecast",
    async (page) => {
      await page
        .getByRole("heading", { name: /working days/ })
        .waitFor({ timeout: 60_000 });
    },
  ],
  [
    "seat inventory",
    "/admin/seats",
    async (page) => {
      await page.getByRole("heading", { name: "All desks" }).waitFor({ timeout: 60_000 });
    },
  ],
  [
    "people",
    "/admin/users",
    async (page) => {
      // The page h1 is also "People", so pin the card title by level.
      await page
        .getByRole("heading", { level: 2, name: "People" })
        .waitFor({ timeout: 60_000 });
    },
  ],
  [
    "settings",
    "/admin/settings",
    async (page) => {
      await page.getByRole("heading", { name: "Booking rules" }).waitFor({ timeout: 60_000 });
    },
  ],
  [
    "audit log",
    "/admin/audit",
    async (page) => {
      // level 1: the card title is also "Audit log", plus its entry count.
      await page
        .getByRole("heading", { level: 1, name: "Audit log" })
        .waitFor({ timeout: 60_000 });
    },
  ],
  [
    "scheduled jobs",
    "/admin/jobs",
    async (page) => {
      await page
        .getByRole("heading", { level: 2, name: /What the next run would do/ })
        .waitFor({ timeout: 60_000 });
    },
  ],
  [
    "who is in",
    "/who",
    async (page) => {
      await page.getByRole("heading", { level: 1, name: /Who/ }).waitFor();
      await page.waitForTimeout(2_500);
    },
  ],
  [
    "your settings",
    "/me",
    async (page) => {
      await page.getByRole("switch").first().waitFor({ timeout: 30_000 });
    },
  ],
  [
    "my desk — releases and repeats",
    "/bookings",
    async (page) => {
      await page.getByRole("tab", { name: /My desk/ }).click();
      await page.waitForTimeout(1_500);
    },
  ],
  [
    "check-in page",
    "/checkin/C5-01",
    async (page) => {
      await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30_000 });
    },
  ],
  /*
   * Three surfaces that were never covered, added in Phase 7 because the
   * texture change moves what sits behind things and "we did not check" is not
   * a result. The 3D view is included even though it is a canvas: what is
   * audited there is the WRAPPER -- that it is role="img" and labelled, and
   * that the escape to a keyboard-operable view is reachable -- which is
   * exactly ADR-032's claim and was previously only asserted in the 3D spec.
   */
  [
    "home",
    "/",
    async (page) => {
      await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30_000 });
    },
  ],
  [
    "styleguide",
    "/styleguide",
    async (page) => {
      await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30_000 });
    },
  ],
  [
    "floor plan, 3D",
    "/floor?mode=3d",
    async (page) => {
      await page.locator('[data-floor-3d="ready"]').waitFor({ timeout: 180_000 });
      await page.waitForTimeout(2000);
    },
  ],
];

for (const [name, path, prepare] of CASES) {
  test(`no serious accessibility violations: ${name}`, async ({ page }) => {
    /**
     * The seat inventory is 141 rows carrying two selects each, so axe walks
     * roughly 1,100 interactive nodes. That is a real cost of auditing the
     * whole page rather than a sample, and it does not fit the suite's 60s
     * default — the assertion underneath is unchanged.
     */
    if (name === "seat inventory") test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(path);
    await page.getByLabel("Sign in as a different person (demo)").waitFor();
    await prepare(page);

    const { violations, incompleteContrast } = await audit(page);
    const blocking = violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    const minor = violations.filter((v) => !blocking.includes(v));
    const undecidable = incompleteContrast.reduce((n, r) => n + r.nodes.length, 0);

    // NUMBERS, not pass/fail. Zero blocking violations means little on its own
    // if axe silently could not judge forty elements -- and after Phase 7 put
    // the architect's drawing behind the plan in its own colours, the elements
    // over the plan are exactly the ones it declines to judge.
    console.log(
      `  AXE ${name.padEnd(32)} crit+serious ${blocking.length}` +
        ` | mod+minor ${minor.length}` +
        ` | contrast-undecidable ${undecidable}`,
    );
    if (minor.length > 0) {
      console.log(`  ${name} - non-blocking:` + NL + report(minor));
    }
    expect(blocking, NL + report(blocking) + NL).toEqual([]);
  });
}

test("every seat is a real button with an accessible name", async ({ page }) => {
  // Runs after the heaviest specs in the file, against a dev server that has
  // just compiled nine admin routes. The floor plan itself is fast.
  test.setTimeout(120_000);
  await page.goto("/floor");
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });

  const names = await page
    .locator("[data-seat]")
    .evaluateAll((els) =>
      els.map((el) => ({
        tag: el.tagName,
        label: el.getAttribute("aria-label") ?? "",
      })),
    );

  expect(names).toHaveLength(141);
  for (const { tag, label } of names) {
    expect(tag).toBe("BUTTON");
    // "Seat C3-04, Zone C, bay C3, Available" — code, zone, bay and state.
    expect(label).toMatch(/^Seat [A-Z]+\d*-\d{2}, Zone [ABCD], bay [A-Z]+\d*, .+/);
  }
});

test("the plan region and its controls are labelled", async ({ page }) => {
  await page.goto("/floor");
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });

  await expect(page.getByRole("application")).toHaveAttribute("aria-label", /arrow keys/i);
  for (const group of ["Booking date", "Slot", "Zone", "View"]) {
    await expect(page.getByRole("radiogroup", { name: group })).toHaveCount(1);
  }
});
