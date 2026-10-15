import { describe, expect, it } from "vitest";

// A .mjs script module on purpose: prod:check runs under plain node, before any
// build step exists, so its predicate cannot be a TS module without putting tsx
// on the production path.
import { MIN_BOOKINGS, evaluateProduction } from "../../scripts/prod-check.mjs";

/**
 * `prod:check` reported "looks presentable" against THREE bookings, immediately
 * after the Phase 6 deploy emptied production. It selected the count, printed
 * it, and asserted nothing about it.
 *
 * These are the three damage shapes that actually occurred, so the guard cannot
 * regress back into the state it was in. They run on every `npm test`, which is
 * the difference between a guard and a guard nobody has seen fail.
 */

const ALL_MIGRATIONS = [
  "0000_initial_schema",
  "0001_constraints",
  "0002_booking_engine",
  "0003_phase5",
  "0004_room_bay_code",
];

const healthy = {
  users: 158,
  seats: 158,
  bookable: 110,
  bookings: 5804,
  meeting_rooms: 5,
  live_releases: 3,
  series: 4,
  clock_offset: 0,
  queued_mail: 2,
  // Measured against the real seeded database (Phase 8 / B2): a single day's
  // auto_released count normally runs 19–27% of bookable capacity in the
  // worst slot; 12 of 110 (~11%) is a representative healthy snapshot.
  auto_released_today: 12,
  recent_auto_released: 25,
  recent_held: 1888,
};

const fullyMigrated = { applied: ALL_MIGRATIONS, onDisk: ALL_MIGRATIONS };

describe("evaluateProduction — a healthy deployment", () => {
  it("passes with no failures and no warnings", () => {
    const { failures, warnings } = evaluateProduction(healthy, fullyMigrated);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("the three shapes the Phase 6 incident actually produced", () => {
  it("FAILS on a near-empty bookings table — the exact false green", () => {
    // This is the state prod:check was run against and called presentable.
    const { failures } = evaluateProduction(
      { ...healthy, bookings: 3 },
      fullyMigrated,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/only 3 bookings/);
    expect(failures[0]).toMatch(/prod:seed/);
  });

  it("FAILS when the seed left one meeting room instead of five", () => {
    const { failures } = evaluateProduction(
      { ...healthy, meeting_rooms: 1 },
      fullyMigrated,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/1 meeting rooms, expected 5/);
  });

  it("FAILS when a migration is on disk but not applied — the cause, not the damage", () => {
    // bay_code was in schema.ts AND in drizzle/0004, journalled and committed.
    // It had simply never reached production, because db:migrate reads
    // .env.local. The deploy then promoted code that selected it.
    const { failures } = evaluateProduction(healthy, {
      applied: ALL_MIGRATIONS.slice(0, 4),
      onDisk: ALL_MIGRATIONS,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/schema is BEHIND the code/);
    expect(failures[0]).toMatch(/0004_room_bay_code/);
    expect(failures[0]).toMatch(/prod:migrate BEFORE deploying/);
  });

  it("reports ALL of them together when the whole incident is reproduced", () => {
    const { failures } = evaluateProduction(
      { ...healthy, bookings: 3, meeting_rooms: 1 },
      { applied: ALL_MIGRATIONS.slice(0, 4), onDisk: ALL_MIGRATIONS },
    );
    // Migration drift first: it is the cause, and the only live outage.
    expect(failures[0]).toMatch(/schema is BEHIND/);
    expect(failures).toHaveLength(3);
  });
});

describe("the boundary of the bookings floor", () => {
  it("passes exactly at the floor and fails one below it", () => {
    expect(
      evaluateProduction({ ...healthy, bookings: MIN_BOOKINGS }, fullyMigrated)
        .failures,
    ).toEqual([]);
    expect(
      evaluateProduction({ ...healthy, bookings: MIN_BOOKINGS - 1 }, fullyMigrated)
        .failures,
    ).toHaveLength(1);
  });
});

describe("failures versus warnings", () => {
  it("treats a stray demo clock as a warning, not a failure", () => {
    // Real, and worth saying, but a partner opening the demo sees a working
    // floor. Only things that make the demo WRONG may block a deploy.
    const { failures, warnings } = evaluateProduction(
      { ...healthy, clock_offset: 7200 },
      fullyMigrated,
    );
    expect(failures).toEqual([]);
    expect(warnings[0]).toMatch(/clock offset is 7200s/);
  });

  it("warns when production is AHEAD of this checkout rather than failing", () => {
    // An older branch is a mistake about which code you are looking at, not
    // damage to production.
    const { failures, warnings } = evaluateProduction(healthy, {
      applied: ALL_MIGRATIONS,
      onDisk: ALL_MIGRATIONS.slice(0, 4),
    });
    expect(failures).toEqual([]);
    expect(warnings[0]).toMatch(/production has 1 migration/);
  });

  it("fails when nothing is bookable at all", () => {
    const { failures } = evaluateProduction(
      { ...healthy, bookable: 0 },
      fullyMigrated,
    );
    expect(failures.some((f: string) => /nobody could book/.test(f))).toBe(true);
  });
});

/**
 * THE DISTRIBUTION GUARD (B2) — Phase 7 established that every count above
 * can stay healthy while the DISTRIBUTION of bookings is wrecked: 65 of 95
 * bookable desks auto-released, and `prod:check` said "looks presentable"
 * throughout. These are the shapes that incident actually produced, so this
 * guard cannot regress back into not seeing them.
 */
describe("the distribution guard — auto-released desks", () => {
  it("passes a healthy day", () => {
    const { failures, warnings } = evaluateProduction(healthy, fullyMigrated);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("FAILS on the exact shape of the 65/95 incident", () => {
    const { failures } = evaluateProduction(
      { ...healthy, bookable: 95, auto_released_today: 65 },
      fullyMigrated,
    );
    expect(failures.some((f: string) => /65 of 95 bookable desks/.test(f))).toBe(true);
    expect(failures.some((f: string) => /68%/.test(f))).toBe(true);
  });

  it("passes exactly at the 40% boundary and fails one desk above it", () => {
    // 40% of 93, rounded down, is 37 — the boundary the guard is written
    // against is the RATIO, not a rounded desk count, so assert on the ratio
    // directly rather than fighting integer rounding at the edge.
    const atBoundary = Math.floor(healthy.bookable * 0.4);
    const overBoundary = Math.ceil(healthy.bookable * 0.4) + 1;
    expect(
      evaluateProduction(
        { ...healthy, auto_released_today: atBoundary },
        fullyMigrated,
      ).failures,
    ).toEqual([]);
    expect(
      evaluateProduction(
        { ...healthy, auto_released_today: overBoundary },
        fullyMigrated,
      ).failures,
    ).toHaveLength(1);
  });

  it("does not confuse a normal single-slot spike with the incident", () => {
    // Measured against the real seed: a single slot's worst observed ratio
    // is 19/57 (33%). This must stay a pass, or the guard fires on ordinary
    // demo data and nobody trusts it by the second run.
    const { failures } = evaluateProduction(
      { ...healthy, bookable: 110, auto_released_today: 19 },
      fullyMigrated,
    );
    expect(failures).toEqual([]);
  });

  it("WARNS, not fails, when auto-release looks like it has stopped entirely", () => {
    // A16/A26 territory: worth a look, not worth blocking a 9am deploy over —
    // a healthy morning can legitimately show zero before any grace window
    // has expired yet.
    const { failures, warnings } = evaluateProduction(
      { ...healthy, auto_released_today: 0, recent_auto_released: 0, recent_held: 1888 },
      fullyMigrated,
    );
    expect(failures).toEqual([]);
    expect(warnings.some((w: string) => /zero auto_released/.test(w))).toBe(true);
  });

  it("does not warn when the recent population is too small to mean anything", () => {
    const { warnings } = evaluateProduction(
      { ...healthy, auto_released_today: 0, recent_auto_released: 0, recent_held: 40 },
      fullyMigrated,
    );
    expect(warnings.some((w: string) => /zero auto_released/.test(w))).toBe(false);
  });

  it("stays silent on older count shapes that predate this guard", () => {
    // A scratch database or an older checkout's query might not carry the
    // new columns at all. Undefined must not throw and must not fail.
    const { failures } = evaluateProduction(
      {
        users: 158,
        seats: 158,
        bookable: 110,
        bookings: 5804,
        meeting_rooms: 5,
        live_releases: 3,
        series: 4,
        clock_offset: 0,
        queued_mail: 2,
      },
      fullyMigrated,
    );
    expect(failures).toEqual([]);
  });
});
