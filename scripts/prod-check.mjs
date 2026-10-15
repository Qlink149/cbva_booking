/**
 * What "presentable" means for the deployed demo, as a pure function.
 *
 * WHY THIS IS SEPARATE FROM prod.mjs. Phase 6's deploy promoted code that
 * selected a column production did not have. Every meeting-room query failed,
 * and recovering from it ran the seed, which deletes bookings and room_bookings
 * wholesale before regenerating them (ADR-008) -- so failing between the delete
 * and the insert left production with ZERO bookings and ONE meeting room.
 *
 * `prod:check` was run afterwards and said "looks presentable" against THREE
 * bookings. It selected the count, printed it, and asserted nothing about it.
 * A guard that greenlights the exact damage it exists to catch is worse than no
 * guard, because it also supplies a reason not to look.
 *
 * Pulling the judgement out of the transport is what makes it testable. The
 * damaged shapes that actually occurred are in tests/unit/prod-check.test.ts and
 * run on every `npm test`, so this cannot quietly regress the way it quietly
 * failed to exist.
 *
 * FAILURES exit non-zero; WARNINGS do not. The distinction is whether a partner
 * opening the demo would see something wrong.
 */

/**
 * The seed builds eight weeks of history plus five forward working days, which
 * comes out around 5,800 bookings. The floor is deliberately well below that:
 * it is not a precise expectation, it is the line under which the demo has
 * visibly lost its history. Three bookings is the number that got past the old
 * check; two thousand is comfortably above any legitimate variation in the
 * seed and comfortably below anything that looks populated.
 */
export const MIN_BOOKINGS = 2000;

/** From the drawing, and asserted by the geometry tests (A3). */
export const EXPECTED_ROOMS = 5;
export const EXPECTED_SEATS = 158;
export const EXPECTED_USERS = 158;

/**
 * @param {object} counts - one row of the prod:check query
 * @param {{applied: string[], onDisk: string[]}} migrations
 * @returns {{failures: string[], warnings: string[]}}
 */
export function evaluateProduction(counts, migrations) {
  const failures = [];
  const warnings = [];

  /*
   * SCHEMA DRIFT FIRST, because it is the one that actually happened and the
   * only one that is a live outage rather than a presentation problem. Nothing
   * in this project sequences a migration against a deploy: `npm run db:migrate`
   * reads .env.local, so it migrates the LOCAL database, and the deploy then
   * promotes code that selects a column production has never been given. That
   * was invisible for five phases because no phase added a column. The first
   * one that did took the site down.
   */
  const missing = migrations.onDisk.filter((m) => !migrations.applied.includes(m));
  if (missing.length > 0) {
    failures.push(
      `schema is BEHIND the code: ${missing.length} migration(s) not applied ` +
        `(${missing.join(", ")}). Run prod:migrate BEFORE deploying — code that ` +
        `selects a column production does not have fails every request.`,
    );
  }
  const extra = migrations.applied.filter((m) => !migrations.onDisk.includes(m));
  if (extra.length > 0) {
    warnings.push(
      `production has ${extra.length} migration(s) this checkout does not ` +
        `(${extra.join(", ")}) — are you on an older branch?`,
    );
  }

  if (counts.bookings < MIN_BOOKINGS) {
    failures.push(
      `only ${counts.bookings} bookings, expected at least ${MIN_BOOKINGS}. ` +
        `The demo history is gone — this is what an interrupted seed leaves ` +
        `behind. Run prod:seed. (The old check called 3 bookings "presentable".)`,
    );
  }

  if (counts.meeting_rooms !== EXPECTED_ROOMS) {
    failures.push(
      `${counts.meeting_rooms} meeting rooms, expected ${EXPECTED_ROOMS}. ` +
        `The seed deletes rooms no longer in MEETING_ROOMS before inserting, ` +
        `so a partial run leaves exactly this.`,
    );
  }

  if (counts.seats !== EXPECTED_SEATS) {
    failures.push(`${counts.seats} seats, expected ${EXPECTED_SEATS} — test debris?`);
  }
  if (counts.users !== EXPECTED_USERS) {
    failures.push(`${counts.users} users, expected ${EXPECTED_USERS} — test debris?`);
  }

  /* Warnings: real, but a partner would not see them. */
  if (counts.clock_offset !== 0) {
    warnings.push(`clock offset is ${counts.clock_offset}s — reset it before a demo`);
  }
  if (counts.queued_mail > 50) {
    warnings.push(`${counts.queued_mail} messages queued — is the cron running?`);
  }
  if (counts.bookable === 0) {
    failures.push("no bookable seats at all — nobody could book anything");
  }
  if (counts.series === 0) {
    warnings.push("no active recurring series — the seed usually leaves some");
  }
  if (counts.live_releases === 0) {
    warnings.push("no live seat releases — the seed usually leaves some");
  }

  /*
   * THE DISTRIBUTION GUARD (Phase 8 / B2) — the third guard this project has
   * added only after the failure it exists to catch.
   *
   * Phase 7 pointed the e2e suite at production by accident and it
   * auto-released 65 of 95 bookable desks on the demo date. Every count above
   * stayed healthy throughout — 141/141/93, ~5,800 bookings, 5 rooms — and
   * `evaluateProduction` reported "looks presentable" because nothing here
   * asked what SHAPE the bookings were in, only how many there were. A count
   * guard sees data go missing; it is blind to the same data being present
   * but wrong.
   *
   * WHY "TODAY" AND NOT A RUNNING RATIO. `auto_released` is not a count that
   * accumulates the way "12% of bookings are no-shows" suggests — it is a
   * SNAPSHOT of no-shows caught while their slot was still running, and once
   * assigned it never changes (auto-release.ts only ever transitions OUT of
   * `confirmed`, never into or out of `auto_released` again). Once a day is
   * fully over, its no-shows settle to `completed_no_show` instead — that is
   * the OTHER terminal status, and it is the one that accumulates with the
   * calendar. So `auto_released` is concentrated on the current day (and
   * briefly on the one just before it), not spread evenly across a trailing
   * window — a ratio measured over 21 days would dilute today's damage with
   * three weeks of `completed_no_show` history that was never in danger.
   *
   * Measured, not assumed: against the actual seeded database, a single
   * day's `auto_released` count sits at 19–27% of bookable capacity in the
   * worst slot observed. 40% clears that with real margin and is nowhere
   * near the 68% (65 of 95) the incident actually produced.
   */
  if (counts.bookable > 0 && counts.auto_released_today !== undefined) {
    const todayRatio = counts.auto_released_today / counts.bookable;
    if (todayRatio > 0.4) {
      failures.push(
        `${counts.auto_released_today} of ${counts.bookable} bookable desks ` +
          `(${Math.round(todayRatio * 100)}%) are auto_released for today — far more than a ` +
          `12% no-show rate explains in one day. This is the shape of the 65/95 incident: ` +
          `something (an e2e run against this database, a demo clock left advanced) has ` +
          `auto-released the floor wholesale rather than the real 2-hour rule doing it one ` +
          `booking at a time. Check for a stray clock offset and re-seed if this is the demo.`,
      );
    }
  }

  /*
   * The other direction — auto-release having quietly stopped happening at
   * all — is a real risk (A26: a settings edit can put the grace window
   * longer than the slot) but a much noisier signal at the "today" grain,
   * since a healthy morning can legitimately show zero before anyone's grace
   * window has expired yet. A warning, not a failure, over fourteen days —
   * long enough that zero against a real population is worth a look without
   * blocking a deploy someone is running at 9:05am.
   */
  if (counts.recent_held > 100 && counts.recent_auto_released === 0) {
    warnings.push(
      `zero auto_released bookings in the last 14 days against ${counts.recent_held} ` +
        `held — is the cron running, or has auto_release_minutes drifted past the slot ` +
        `length (A26)?`,
    );
  }

  return { failures, warnings };
}
