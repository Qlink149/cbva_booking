/**
 * Remove test fixtures the suites left behind.
 *
 * `createPhase3Fixtures` builds a private floor (number 900), zone, seats, users
 * and a room so the integration tests can run safely against the seeded demo
 * database. `destroyPhase3Fixtures` removes them — but only if the run reaches
 * `afterAll`. A killed run, a crashed process or a timed-out hook leaves them,
 * and the debris is not inert:
 *
 *   · orphan seats make `expect(seats).toHaveLength(158)` fail
 *   · orphan users make the seed report 145 people
 *   · orphan series keep the materialiser queueing failure notifications, which
 *     then break the edge-case test that counts dispatch results
 *
 * Every one of those has cost real debugging time on this phase. Run this after
 * an interrupted suite.
 *
 *   node scripts/purge-test-data.mjs
 */
import { config } from "dotenv";
/**
 * Which env file to load.
 *
 * Defaults to `.env.local` (the LOCAL / test database). Set ENV_FILE to point
 * at another — `scripts/prod.mjs` sets it to `.env.production.local` so the
 * same script can be aimed at the deployed database without editing anything.
 *
 * dotenv does not override variables already in the environment, so an
 * explicitly exported DATABASE_URL still wins over both files.
 */
config({ path: process.env.ENV_FILE ?? ".env.local", quiet: true });
import pg from "pg";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");

const c = new pg.Client({ connectionString: url });
await c.connect();

const before = await c.query(
  "select (select count(*)::int from seats) s, (select count(*)::int from users) u",
);

// Test floors first: their seats, bookings, releases and series go with them.
const floors = await c.query("select id from floors where number = 900");
for (const f of floors.rows) {
  await c.query("delete from bookings where seat_id in (select id from seats where floor_id=$1)", [f.id]);
  await c.query("delete from seat_releases where seat_id in (select id from seats where floor_id=$1)", [f.id]);
  await c.query("delete from booking_series where seat_id in (select id from seats where floor_id=$1)", [f.id]);
  await c.query("update users set fixed_seat_id=null where fixed_seat_id in (select id from seats where floor_id=$1)", [f.id]);
  await c.query("delete from room_bookings where room_id in (select id from meeting_rooms where floor_id=$1)", [f.id]);
  await c.query("delete from meeting_rooms where floor_id=$1", [f.id]);
  await c.query("delete from seats where floor_id=$1", [f.id]);
  await c.query("delete from zones where floor_id=$1", [f.id]);
  await c.query("delete from floors where id=$1", [f.id]);
}

// Fixture users carry a @cbva.test address; real seeded staff are @cbva.in.
await c.query("delete from bookings where occupant_user_id in (select id from users where email like '%@cbva.test') or booked_by_user_id in (select id from users where email like '%@cbva.test')");
await c.query("delete from booking_series where occupant_user_id in (select id from users where email like '%@cbva.test')");
await c.query("delete from seat_releases where owner_user_id in (select id from users where email like '%@cbva.test') or released_by_user_id in (select id from users where email like '%@cbva.test')");
await c.query("update audit_log set actor_user_id=null where actor_user_id in (select id from users where email like '%@cbva.test')");
const users = await c.query("delete from users where email like '%@cbva.test'");

// Notifications queued for occurrences that can never be booked now.
const mail = await c.query(
  "delete from notification_log where kind='series_occurrence_failed' and series_id not in (select id from booking_series)",
);

const after = await c.query(
  "select (select count(*)::int from seats) s, (select count(*)::int from users) u",
);
console.log(`test floors removed: ${floors.rows.length}`);
console.log(`test users removed:  ${users.rowCount}`);
console.log(`stale mail removed:  ${mail.rowCount}`);
console.log(`seats ${before.rows[0].s} -> ${after.rows[0].s} · users ${before.rows[0].u} -> ${after.rows[0].u}`);
await c.end();
