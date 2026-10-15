import { expect, test } from "@playwright/test";

/**
 * "Have a look at Zone C on Tuesday afternoon" has to be a link. The plan's
 * date, slot, zone and view all live in the query string so a view can be
 * shared, bookmarked and reloaded.
 */

test("a deep link restores date, slot, zone and view", async ({ page }) => {
  await page.goto("/floor?date=2026-09-08&slot=PM&zone=D&view=list");
  await page.getByRole("table").waitFor({ timeout: 30_000 });

  await expect(page.getByRole("radio", { name: /Afternoon/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByRole("radio", { name: "Zone D", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByRole("radio", { name: "List" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // Zone D is 67 of the 158 seats.
  await expect(page.getByText("67 of 67 seats")).toBeVisible();
});

test("changing the plan writes the state back to the URL", async ({ page }) => {
  await page.goto("/floor");
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });

  // Landing on /floor deliberately does NOT write the URL any more.
  //
  // It used to: the default date arrived from the server about a second after
  // load and the sync effect stamped `?date=…&slot=AM`. That unprompted write
  // is the one that cancelled a navigation if somebody clicked away inside that
  // second, which broke `shell.spec.ts` in Phase 3 and again in Phase 4. A bare
  // `/floor` resolves to exactly the same screen, so what is lost is sharing
  // the default day without touching anything — and the moment any control is
  // used the URL starts carrying everything, date included, as asserted below.
  await expect(page).toHaveURL(/\/floor$/);

  await page.getByRole("radio", { name: /Afternoon/ }).click();
  await expect(page).toHaveURL(/date=\d{4}-\d{2}-\d{2}/);
  await expect(page).toHaveURL(/slot=PM/);

  await page.getByRole("radio", { name: "Zone C", exact: true }).click();
  await expect(page).toHaveURL(/zone=C/);
});

test("state survives a reload", async ({ page }) => {
  await page.goto("/floor");
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
  await page.getByRole("radio", { name: "Zone C", exact: true }).click();
  await expect(page).toHaveURL(/zone=C/);

  await page.reload();
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });
  await expect(page.locator("[data-seat]")).toHaveCount(66);
});

test("switching slots does not stack up history entries", async ({ page }) => {
  // replace, not push: Back should leave the floor plan, not walk through
  // every slot the user glanced at.
  await page.goto("/");
  // Scoped to the header nav: the signed-in home page's own quick-link grid
  // (Phase 8) added a second "Floor Map" link on the page, and an unscoped
  // role query is ambiguous the moment there are two.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Floor Map" })
    .click();
  await page.locator("[data-seat]").first().waitFor({ timeout: 30_000 });

  await page.getByRole("radio", { name: /Afternoon/ }).click();
  await expect(page).toHaveURL(/slot=PM/);
  await page.getByRole("radio", { name: /Morning/ }).click();
  await expect(page).toHaveURL(/slot=AM/);

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});
