/**
 * CBVA Workspace seed.
 *
 * IDEMPOTENT BY CONSTRUCTION. Every row's primary key is a UUID v5 of its
 * natural key under a fixed namespace, and every insert is onConflictDoUpdate.
 * Run it twice and the row counts do not move.
 *
 * DETERMINISTIC. All randomness comes from a fixed-seed mulberry32, so two runs
 * produce identical bookings and the analytics numbers do not drift between
 * demos.
 *
 * Realism matters here more than it looks: analytics IS the product, and a
 * screen built on three rows of data looks broken to a partner.
 *
 *   npm run seed
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

import { notInArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import { addDays, format, getDay, subDays } from "date-fns";
import { fromZonedTime } from "date-fns-tz";

import * as schema from "../src/lib/db/schema";
import { makeRng, type Rng } from "../src/lib/seed-data/rng";
import { HOLIDAYS } from "../src/lib/seed-data/holidays";
import { DEFAULT_OFFICE_HOURS } from "../src/lib/settings";
import { floorplanSeatAnchors } from "../src/lib/floorplan";
import { FIRST_NAMES, LAST_NAMES } from "../src/lib/seed-data/names";
import {
  ADMIN_TEAMS,
  BAYS,
  FIXED_SEAT_ALLOCATION,
  HEADCOUNT,
  MEETING_ROOMS,
  TEAMS,
  ZONES,
  seatCodes,
  seatTypeForBay,
} from "../src/lib/seed-data/inventory";
import { DEFAULT_SLOT_DEFINITIONS, deriveSlotBounds } from "../src/lib/slots";

/** Fixed namespace: same natural key always yields the same uuid. */
const NS = "6f0a1c2e-8b3d-4e5a-9f10-2b7c4d5e6a8b";
const id = (...parts: (string | number)[]) => uuidv5(parts.join("|"), NS);

const TZ = "Asia/Kolkata";
const RNG_SEED = 20260903;

const HISTORY_WEEKS = 8;
const FORWARD_WORKING_DAYS = 5;

/** Share of bookable staff who book on a given weekday. Mon/Fri are lighter —
 *  the WFH day clusters at the ends of the week, which is the whole reason
 *  CBVA cannot forecast capacity. */
const DAY_ATTENDANCE: Record<number, number> = {
  1: 0.76, // Monday
  2: 0.9, // Tuesday
  3: 0.89, // Wednesday
  4: 0.87, // Thursday
  5: 0.78, // Friday
};

const NO_SHOW_RATE = 0.12;
const CANCEL_RATE = 0.08;
/**
 * Arrived and then handed the rest of the slot back, and cancelled by an
 * administrator.
 *
 * Both are new in Phase 5 and both are small on purpose. They exist because
 * ADR-024 requires the five terminal statuses to stay separate in the
 * analytics legend, and with no rows at all the report rendered two
 * permanently empty categories — which reads as a broken screen rather than as
 * a distinction worth making.
 */
const LEFT_EARLY_RATE = 0.03;
const ADMIN_CANCEL_RATE = 0.015;
const BAY_AFFINITY = 0.65;
const FULL_DAY_RATE = 0.7;
const AM_ONLY_SPLIT = 0.55;

type Db = NodePgDatabase<typeof schema>;

/* ------------------------------------------------------------------ helpers */

const iso = (d: Date) => format(d, "yyyy-MM-dd");
const holidaySet = new Set(HOLIDAYS.map((h) => h.date));

function isWorkingDay(d: Date): boolean {
  const dow = getDay(d);
  return dow >= 1 && dow <= 5 && !holidaySet.has(iso(d));
}

/**
 * ADR-007 says exactly one function computes starts_at/ends_at. The seed used
 * to carry a private second copy of the derivation; it now calls the real one,
 * so a slot-boundary change moves the seeded history with everything else.
 */
function slotBounds(date: string, slot: string) {
  return deriveSlotBounds(date, slot, DEFAULT_SLOT_DEFINITIONS, TZ);
}

/**
 * "Today" for the seed. The seed sits outside business logic — it is the thing
 * that establishes the timeline the Clock later reads against — so this is one
 * of the four sanctioned places wall time is read directly.
 */
function today(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/* --------------------------------------------------------------- the people */

interface SeededUser {
  id: string;
  email: string;
  displayName: string;
  grade: schema.Grade;
  team: string;
  seatMode: "fixed" | "bookable";
  isAdmin: boolean;
}

function buildUsers(rng: Rng): SeededUser[] {
  const users: SeededUser[] = [];
  const usedEmails = new Set<string>();
  let n = 0;

  for (const bracket of HEADCOUNT) {
    for (let i = 0; i < bracket.count; i++) {
      const first = FIRST_NAMES[(n * 7 + i * 13) % FIRST_NAMES.length]!;
      const last = LAST_NAMES[(n * 11 + i * 5) % LAST_NAMES.length]!;
      let email = `${first}.${last}`.toLowerCase() + "@cbva.in";
      let dedupe = 2;
      while (usedEmails.has(email)) {
        email = `${first}.${last}${dedupe++}`.toLowerCase() + "@cbva.in";
      }
      usedEmails.add(email);

      const team =
        bracket.grade === "admin_staff"
          ? rng.pick(ADMIN_TEAMS)
          : rng.pick(TEAMS);

      users.push({
        id: id("user", email),
        email,
        displayName: `${first} ${last}`,
        grade: bracket.grade,
        team,
        seatMode: bracket.seatMode,
        // Admins: the IT/HR staff plus one partner, so the demo can switch into
        // an admin view from either direction.
        isAdmin: bracket.grade === "admin_staff" || (bracket.grade === "partner" && i === 0),
      });
      n++;
    }
  }
  return users;
}

/* ---------------------------------------------------------------- the seats */

interface SeededSeat {
  id: string;
  seatCode: string;
  bay: string;
  zone: string;
  seatType: "workstation" | "passage" | "foldable" | "cabin";
  planX: string;
  planY: string;
  rotationDeg: number;
}

/**
 * Seat geometry comes from the CAD extraction, not from this file.
 *
 * `src/data/floorplan/seats.json` is written by `npm run build:floorplan` from
 * the architect's drawing and is the source of truth for where a desk is. The
 * editor at /admin/floor-plan writes corrections back into it, which is why
 * re-seeding is safe: it re-reads the same corrected file rather than
 * flattening the floor back onto a grid.
 *
 * The reconciliation against BAYS is deliberate and strict. If the extraction
 * and the bay schedule ever disagree, seeding stops rather than quietly
 * producing a floor that is missing desks.
 */
function buildSeats(): SeededSeat[] {
  const anchors = new Map(
    floorplanSeatAnchors.seats.map((a) => [a.seatCode, a] as const),
  );

  const seats: SeededSeat[] = [];
  const missing: string[] = [];

  for (const bay of BAYS) {
    for (const code of seatCodes(bay)) {
      const anchor = anchors.get(code);
      if (!anchor) {
        missing.push(code);
        continue;
      }
      seats.push({
        id: id("seat", code),
        seatCode: code,
        bay: bay.bay,
        zone: bay.zone,
        seatType: seatTypeForBay(bay.bay),
        planX: anchor.planX.toFixed(2),
        planY: anchor.planY.toFixed(2),
        rotationDeg: anchor.rotationDeg,
      });
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `src/data/floorplan/seats.json has no anchor for ${missing.length} seat(s): ` +
        `${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}. ` +
        "Run: npm run build:floorplan",
    );
  }
  const extra = floorplanSeatAnchors.seats.length - seats.length;
  if (extra !== 0) {
    throw new Error(
      `seats.json carries ${floorplanSeatAnchors.seats.length} anchors but the bay ` +
        `schedule expects ${seats.length}. The drawing and inventory.ts have drifted.`,
    );
  }
  return seats;
}

/* ------------------------------------------------------------------- upsert */

async function chunked<T>(rows: T[], size: number, fn: (batch: T[]) => Promise<void>) {
  for (let i = 0; i < rows.length; i += size) {
    await fn(rows.slice(i, i + size));
  }
}

/* --------------------------------------------------------------------- main */

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");

  if (process.env.APP_MODE === "production") {
    throw new Error(
      "refusing to seed with APP_MODE=production — this script rebuilds all booking data",
    );
  }

  const pool = new Pool({ connectionString: url, max: 4 });
  const db: Db = drizzle(pool, { schema });
  const rng = makeRng(RNG_SEED);

  console.log("seeding CBVA Workspace …");

  /* ---- rebuild the generated booking history ----
     Reference data (users, seats, rooms, holidays, settings) is upserted on its
     natural key and survives. Bookings are regenerated wholesale, because the
     deterministic stream shifts whenever the generator changes and stale rows
     from an earlier stream would then collide with the new ones — as the room
     exclusion constraint correctly points out when they do. Deleting first
     keeps a re-run safe both after a code change and when run twice unchanged. */
  await db.delete(schema.roomBookings);
  await db.delete(schema.bookings);

  /* ---- settings (singleton) ---- */
  await db
    .insert(schema.settings)
    .values({
      id: id("settings"),
      bookingWindowDays: 14,
      bookingWindowWorkingDays: 5,
      slotDefinitions: DEFAULT_SLOT_DEFINITIONS,
      autoReleaseMinutes: 120,
      cutoffMinutes: 60,
      checkInOpensMinutesBefore: 30,
      officeHours: DEFAULT_OFFICE_HOURS,
      timezone: TZ,
      demoOffsetSeconds: 0,
    })
    .onConflictDoUpdate({
      target: schema.settings.id,
      set: {
        bookingWindowDays: 14,
        bookingWindowWorkingDays: 5,
        slotDefinitions: DEFAULT_SLOT_DEFINITIONS,
        autoReleaseMinutes: 120,
        cutoffMinutes: 60,
        checkInOpensMinutesBefore: 30,
        officeHours: DEFAULT_OFFICE_HOURS,
        timezone: TZ,
        // demoOffsetSeconds is deliberately not reset: re-seeding must not
        // yank the clock out from under a demo in progress.
      },
    });

  /* ---- holidays ---- */
  await db
    .insert(schema.holidays)
    .values(
      HOLIDAYS.map((h) => ({
        id: id("holiday", h.date),
        holidayDate: h.date,
        name: h.name,
      })),
    )
    .onConflictDoUpdate({
      target: schema.holidays.holidayDate,
      set: { name: sql`excluded.name` },
    });

  /* ---- floor + zones ---- */
  const floorId = id("floor", "4");
  await db
    .insert(schema.floors)
    .values({
      id: floorId,
      number: 4,
      name: "Floor 4",
      planAssetKey: "assets/cad/floor4-walls.svg",
      isActive: true,
    })
    .onConflictDoUpdate({
      target: schema.floors.id,
      set: { name: "Floor 4", planAssetKey: "assets/cad/floor4-walls.svg" },
    });

  await db
    .insert(schema.zones)
    .values(
      ZONES.map((z) => ({
        id: id("zone", "4", z.code),
        floorId,
        code: z.code,
        displayName: z.displayName,
        sortOrder: z.sortOrder,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.zones.floorId, schema.zones.code],
      set: { displayName: sql`excluded.display_name` },
    });

  /* ---- users ---- */
  const users = buildUsers(rng);
  await chunked(users, 100, async (batch) => {
    await db
      .insert(schema.users)
      .values(
        batch.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          grade: u.grade,
          team: u.team,
          seatMode: u.seatMode,
          isAdmin: u.isAdmin,
          isActive: true,
        })),
      )
      .onConflictDoUpdate({
        target: schema.users.email,
        set: {
          displayName: sql`excluded.display_name`,
          grade: sql`excluded.grade`,
          team: sql`excluded.team`,
          seatMode: sql`excluded.seat_mode`,
          isAdmin: sql`excluded.is_admin`,
        },
      });
  });

  /* ---- seats ---- */
  const seats = buildSeats();
  const zoneIdFor = (zone: string) => id("zone", "4", zone);
  const activeFrom = "2025-01-01";

  await chunked(seats, 100, async (batch) => {
    await db
      .insert(schema.seats)
      .values(
        batch.map((s) => ({
          id: s.id,
          zoneId: zoneIdFor(s.zone),
          floorId,
          seatCode: s.seatCode,
          bay: s.bay,
          planX: s.planX,
          planY: s.planY,
          rotationDeg: s.rotationDeg,
          seatType: s.seatType,
          status: "bookable" as const,
          amenities:
            s.seatType === "cabin"
              ? { monitor: true, drawers: true, phone: true }
              : s.seatType === "passage"
                ? { monitor: false, drawers: false }
                : { monitor: true, drawers: true },
          activeFrom,
        })),
      )
      .onConflictDoUpdate({
        target: schema.seats.seatCode,
        set: {
          zoneId: sql`excluded.zone_id`,
          bay: sql`excluded.bay`,
          planX: sql`excluded.plan_x`,
          planY: sql`excluded.plan_y`,
          rotationDeg: sql`excluded.rotation_deg`,
          seatType: sql`excluded.seat_type`,
          amenities: sql`excluded.amenities`,
        },
      });
  });

  /* ---- fixed seat allocation ----
     Pairs the 47 fixed-grade people with the 47 allocated desks, sets
     seats.status='fixed' + assigned_user_id and users.fixed_seat_id. */
  const byGrade = new Map<schema.Grade, SeededUser[]>();
  for (const u of users) {
    if (u.seatMode !== "fixed") continue;
    const list = byGrade.get(u.grade) ?? [];
    list.push(u);
    byGrade.set(u.grade, list);
  }

  let fixedPairs = 0;
  /** seatCode -> the person allocated it. Reused by the seeded releases below. */
  const ownerBySeatCode = new Map<string, SeededUser>();
  for (const alloc of FIXED_SEAT_ALLOCATION) {
    const pool = byGrade.get(alloc.grade) ?? [];
    if (pool.length !== alloc.codes.length) {
      throw new Error(
        `fixed allocation mismatch for ${alloc.grade}: ${pool.length} people, ${alloc.codes.length} seats`,
      );
    }
    for (let i = 0; i < alloc.codes.length; i++) {
      const code = alloc.codes[i]!;
      const user = pool[i]!;
      const seatId = id("seat", code);
      await db
        .update(schema.seats)
        .set({ status: "fixed", assignedUserId: user.id })
        .where(sql`${schema.seats.seatCode} = ${code}`);
      await db
        .update(schema.users)
        .set({ fixedSeatId: seatId })
        .where(sql`${schema.users.id} = ${user.id}`);
      ownerBySeatCode.set(code, user);
      fixedPairs++;
    }
  }

  // One blocked desk, so the status vocabulary has a live example and the
  // analytics have to cope with capacity that is not the full seat count.
  await db
    .update(schema.seats)
    .set({ status: "blocked" })
    .where(sql`${schema.seats.seatCode} = 'PD-18'`);

  /* ---- meeting rooms ----
     Phase 6 replaced six provisional rooms with the five the drawing actually
     shows, so this needs a DELETE that the rest of the seed does not: the
     upsert below conflicts on `name` and therefore cannot see a row whose name
     is no longer in MEETING_ROOMS. Without this, every database seeded before
     Phase 6 keeps "Conference A", "Conference B" and "Huddle Room" forever,
     and /rooms shows eight rooms on a floor that has five.

     Safe here and nowhere else: room_bookings.room_id is ON DELETE restrict,
     and every room_bookings row was deleted above. Moving this earlier would
     make it fail on a floor in use, which is the correct way round. */
  const keptRoomNames = MEETING_ROOMS.map((r) => r.name);
  const removedRooms = await db
    .delete(schema.meetingRooms)
    .where(notInArray(schema.meetingRooms.name, keptRoomNames))
    .returning({ name: schema.meetingRooms.name });
  if (removedRooms.length > 0) {
    console.log(
      `  removed ${removedRooms.length} meeting room(s) no longer in the drawing: ` +
        removedRooms.map((r) => r.name).join(", "),
    );
  }

  await db
    .insert(schema.meetingRooms)
    .values(
      MEETING_ROOMS.map((r) => ({
        id: id("room", r.name),
        floorId,
        name: r.name,
        bayCode: r.bayCode,
        capacity: r.capacity,
        amenities: r.amenities,
        outlookResourceEmail: null,
        isBookable: true,
      })),
    )
    .onConflictDoUpdate({
      target: schema.meetingRooms.name,
      set: {
        bayCode: sql`excluded.bay_code`,
        capacity: sql`excluded.capacity`,
        amenities: sql`excluded.amenities`,
      },
    });

  /* ---- bookings ---- */
  const bookableUsers = users.filter((u) => u.seatMode === "bookable");
  const bookableSeats = seats.filter(
    (s) =>
      !FIXED_SEAT_ALLOCATION.some((a) => a.codes.includes(s.seatCode)) &&
      s.seatCode !== "PD-18",
  );
  const bayGroups = new Map<string, SeededSeat[]>();
  for (const s of bookableSeats) {
    const list = bayGroups.get(s.bay) ?? [];
    list.push(s);
    bayGroups.set(s.bay, list);
  }
  const bookableBays = [...bayGroups.keys()];

  // Each person has a bay they gravitate back to, the way real people do.
  const affinity = new Map<string, string>();
  for (const u of bookableUsers) affinity.set(u.id, rng.pick(bookableBays));

  const t0 = today();
  const dates: string[] = [];
  for (let i = HISTORY_WEEKS * 7; i >= 1; i--) {
    const d = subDays(t0, i);
    if (isWorkingDay(d)) dates.push(iso(d));
  }
  const pastDates = [...dates];
  if (isWorkingDay(t0)) dates.push(iso(t0));
  let ahead = 1;
  let added = 0;
  while (added < FORWARD_WORKING_DAYS) {
    const d = addDays(t0, ahead++);
    if (isWorkingDay(d)) {
      dates.push(iso(d));
      added++;
    }
  }
  const futureCutoff = iso(t0);

  type BookingRow = typeof schema.bookings.$inferInsert;
  const bookingRows: BookingRow[] = [];

  for (const date of dates) {
    const dow = getDay(new Date(`${date}T00:00:00Z`));
    const attendance = DAY_ATTENDANCE[dow] ?? 0.8;
    const isPast = pastDates.includes(date);
    const isFuture = date > futureCutoff;

    // Who is in today.
    const attendees = rng
      .shuffle([...bookableUsers])
      .slice(0, Math.round(bookableUsers.length * attendance));

    // Track what is taken so the seed never violates seat_slot_unique. The
    // constraint would reject it anyway — that is the point of it — but the
    // seed is not the place to demonstrate that.
    const taken = new Set<string>();

    for (const user of attendees) {
      const preferred = affinity.get(user.id)!;
      const bay = rng.chance(BAY_AFFINITY) ? preferred : rng.pick(bookableBays);

      const slots: Array<"AM" | "PM"> = rng.chance(FULL_DAY_RATE)
        ? ["AM", "PM"]
        : rng.chance(AM_ONLY_SPLIT)
          ? ["AM"]
          : ["PM"];

      // One seat for the whole visit — nobody moves desks at lunch.
      // Try the bay they gravitate to first; if it is full, take anything free,
      // which is exactly what a person does when their usual desk has gone.
      const free = (s: SeededSeat) =>
        slots.every((slot) => !taken.has(`${s.seatCode}|${slot}`));
      const seat =
        rng.shuffle([...(bayGroups.get(bay) ?? [])]).find(free) ??
        rng.shuffle([...bookableSeats]).find(free);
      if (!seat) continue;

      // Outcome is decided once per visit, not per slot, so a no-show does not
      // check in for the afternoon of a morning they never turned up to.
      const roll = rng.next();
      const cancelled = roll < CANCEL_RATE;
      const noShow = !cancelled && roll < CANCEL_RATE + NO_SHOW_RATE;
      const leftEarly =
        !cancelled && !noShow && roll < CANCEL_RATE + NO_SHOW_RATE + LEFT_EARLY_RATE;
      const adminCancelled =
        !cancelled &&
        !noShow &&
        !leftEarly &&
        roll < CANCEL_RATE + NO_SHOW_RATE + LEFT_EARLY_RATE + ADMIN_CANCEL_RATE;
      // Every seeded booking is made by the person who sits at the desk:
      // booking on somebody's behalf was removed (Oct 2026).
      const bookedBy = user;

      for (const slot of slots) {
        taken.add(`${seat.seatCode}|${slot}`);
        const { startsAt, endsAt } = slotBounds(date, slot);

        let status: schema.BookingStatus;
        let checkedInAt: Date | null = null;
        let releasedAt: Date | null = null;
        let cancelledAt: Date | null = null;
        let checkInMethod: string | null = null;

        /**
         * How the check-in arrived, when there was one.
         *
         * NULL on every row until Phase 5, which made A19's whole argument
         * unqueryable: a desk QR proves somebody used THAT desk, a door badge
         * only proves they reached the floor, and the analytics has to keep the
         * two apart. With no data behind it the distinction was a column
         * comment. The mix is a guess — most people scan the sticker in front
         * of them, a minority are picked up by the door reader, a few use the
         * app — and it is an assumption rather than a measurement.
         */
        const pickMethod = () => {
          const m = rng.next();
          return m < 0.62 ? "qr" : m < 0.88 ? "badge" : "app";
        };

        if (cancelled) {
          status = "cancelled_by_user";
          cancelledAt = new Date(startsAt.getTime() - rng.int(2, 40) * 3600_000);
        } else if (noShow) {
          // Auto-release fires 120 minutes into the slot; the row then settles
          // to completed_no_show once the slot is over.
          releasedAt = new Date(startsAt.getTime() + 120 * 60_000);
          status = isPast ? "completed_no_show" : "auto_released";
        } else if (leftEarly && isPast) {
          /**
           * Arrived, then gave the rest of the slot back.
           *
           * Seeded because ADR-024 requires this status to stay separate from a
           * plain no-show in the legend, and with zero rows the analytics
           * screen rendered a permanently empty category — which reads as a
           * broken report rather than a real distinction.
           */
          status = "cancelled_after_check_in";
          checkedInAt = new Date(startsAt.getTime() + rng.int(-10, 20) * 60_000);
          checkInMethod = pickMethod();
          cancelledAt = new Date(startsAt.getTime() + rng.int(90, 200) * 60_000);
        } else if (adminCancelled && isPast) {
          // The firm took the desk back — a desk out of service, a room
          // reshuffle. Never counted against the person.
          status = "cancelled_by_admin";
          cancelledAt = new Date(startsAt.getTime() - rng.int(1, 12) * 3600_000);
        } else if (isPast) {
          status = "completed";
          checkedInAt = new Date(startsAt.getTime() + rng.int(-15, 45) * 60_000);
          checkInMethod = pickMethod();
        } else if (isFuture) {
          status = "confirmed";
        } else {
          // Today: some have badged in already, some have not.
          const arrived = rng.chance(0.75);
          status = arrived ? "checked_in" : "confirmed";
          if (arrived) {
            checkedInAt = new Date(startsAt.getTime() + rng.int(-15, 45) * 60_000);
            checkInMethod = pickMethod();
          }
        }

        bookingRows.push({
          id: id("booking", seat.seatCode, date, slot),
          seatId: seat.id,
          bookingDate: date,
          slot,
          startsAt,
          endsAt,
          bookedByUserId: bookedBy.id,
          occupantUserId: user.id,
          status,
          source: "self",
          checkedInAt,
          checkInMethod,
          releasedAt,
          cancelledAt,
          createdAt: new Date(startsAt.getTime() - rng.int(12, 200) * 3600_000),
          updatedAt: startsAt,
        });
      }
    }
  }

  await chunked(bookingRows, 500, async (batch) => {
    await db
      .insert(schema.bookings)
      .values(batch)
      .onConflictDoUpdate({
        target: schema.bookings.id,
        set: {
          status: sql`excluded.status`,
          occupantUserId: sql`excluded.occupant_user_id`,
          bookedByUserId: sql`excluded.booked_by_user_id`,
          source: sql`excluded.source`,
          checkedInAt: sql`excluded.checked_in_at`,
          checkInMethod: sql`excluded.check_in_method`,
          releasedAt: sql`excluded.released_at`,
          cancelledAt: sql`excluded.cancelled_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  });

  /* ---- room bookings ---- */
  type RoomRow = typeof schema.roomBookings.$inferInsert;
  const roomRows: RoomRow[] = [];
  const roomTitles = [
    "Audit Planning — Q2",
    "Client Onboarding Review",
    "Statutory Audit Debrief",
    "GST Reconciliation Walkthrough",
    "Partner Weekly",
    "Transfer Pricing Discussion",
    "Article Training — Ind AS",
    "Board Pack Review",
    "Internal Controls Workshop",
    "Tax Litigation Update",
  ];
  const organisers = users.filter(
    (u) => u.grade === "partner" || u.grade === "manager" || u.grade === "director",
  );

  for (const date of dates) {
    for (const room of MEETING_ROOMS) {
      // Bigger rooms are busier; the huddle room turns over most often.
      const meetings = rng.int(0, room.capacity >= 10 ? 4 : 3);
      let hour = 9;
      for (let m = 0; m < meetings; m++) {
        const durationHours = rng.chance(0.35) ? 2 : 1;
        if (hour + durationHours > 19) break;
        const startsAt = fromZonedTime(
          `${date}T${String(hour).padStart(2, "0")}:00:00`,
          TZ,
        );
        const endsAt = new Date(startsAt.getTime() + durationHours * 3600_000);
        const organiser = rng.pick(organisers);
        roomRows.push({
          id: id("roombooking", room.name, date, String(hour)),
          roomId: id("room", room.name),
          startsAt,
          endsAt,
          organiserUserId: organiser.id,
          title: rng.pick(roomTitles),
          status: "confirmed",
          calendarEventId: `demo-evt-${id("roombooking", room.name, date, String(hour))}`,
          syncStatus: "synced",
          createdAt: new Date(startsAt.getTime() - rng.int(6, 96) * 3600_000),
        });
        // Step past this meeting plus a gap, so the seed never trips the
        // exclusion constraint.
        hour += durationHours + rng.int(1, 3);
      }
    }
  }

  await chunked(roomRows, 500, async (batch) => {
    await db
      .insert(schema.roomBookings)
      .values(batch)
      .onConflictDoUpdate({
        target: schema.roomBookings.id,
        set: {
          title: sql`excluded.title`,
          startsAt: sql`excluded.starts_at`,
          endsAt: sql`excluded.ends_at`,
          organiserUserId: sql`excluded.organiser_user_id`,
          status: sql`excluded.status`,
        },
      });
  });

  /* ---- released fixed desks, and one recurring booking ----
   *
   * Both are Phase 5 features and both would otherwise demo as an empty screen
   * with a "nothing here yet" message, which is the worst way to show somebody
   * a feature that exists.
   *
   * The releases matter for a second reason: a released allocated desk is the
   * ONLY way the 47 fixed desks ever enter the occupancy data, so without a few
   * of them the capacity figure never moves and the feature's whole argument is
   * invisible in the analytics.
   */
  const forwardDates = dates.filter((d) => d >= iso(t0));
  const releaseRows: (typeof schema.seatReleases.$inferInsert)[] = [];

  const fixedPairsForRelease = FIXED_SEAT_ALLOCATION.flatMap((group) =>
    group.codes.map((code) => ({ code })),
  ).filter((p) => ownerBySeatCode.has(p.code));

  for (let i = 0; i < Math.min(6, fixedPairsForRelease.length); i++) {
    // Deterministic pick: every seeded run releases the same desks.
    const pair = fixedPairsForRelease[(i * 7 + 3) % fixedPairsForRelease.length]!;
    const owner = ownerBySeatCode.get(pair.code);
    const date = forwardDates[i % Math.max(1, forwardDates.length)];
    if (!owner || !date) continue;
    const seatId = id("seat", pair.code);

    for (const slot of DEFAULT_SLOT_DEFINITIONS.map((d) => d.key)) {
      const { startsAt, endsAt } = slotBounds(date, slot);
      releaseRows.push({
        id: id("release", pair.code, date, slot),
        seatId,
        releaseDate: date,
        slot,
        startsAt,
        endsAt,
        ownerUserId: owner.id,
        releasedByUserId: owner.id,
        note: "Working from home.",
        createdAt: new Date(startsAt.getTime() - 48 * 3600_000),
        updatedAt: new Date(startsAt.getTime() - 48 * 3600_000),
      });
    }
  }

  if (releaseRows.length > 0) {
    await db
      .insert(schema.seatReleases)
      .values(releaseRows)
      .onConflictDoUpdate({
        target: schema.seatReleases.id,
        set: {
          startsAt: sql`excluded.starts_at`,
          endsAt: sql`excluded.ends_at`,
          revokedAt: sql`null`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  /* one recurring booking, so /bookings has something to show for the feature */
  const seriesUser = bookableUsers[3];
  const seriesSeat = [...bookableSeats].find((s) => s.bay === "C5");
  let seriesCount = 0;
  if (seriesUser && seriesSeat && forwardDates.length > 0) {
    await db
      .insert(schema.bookingSeries)
      .values({
        id: id("series", seriesUser.email, seriesSeat.seatCode),
        occupantUserId: seriesUser.id,
        createdByUserId: seriesUser.id,
        seatId: seriesSeat.id,
        slot: DEFAULT_SLOT_DEFINITIONS[0]!.key,
        // Tuesday, Wednesday, Thursday — the three days the seeded attendance
        // curve says are busy, so the series is competing for a real desk.
        weekdays: [2, 3, 4],
        startsOn: forwardDates[0]!,
        endsOn: null,
        status: "active",
        createdAt: new Date(t0.getTime() - 7 * 86_400_000),
        updatedAt: new Date(t0.getTime() - 7 * 86_400_000),
      })
      .onConflictDoUpdate({
        target: schema.bookingSeries.id,
        set: { status: sql`'active'`, startsOn: sql`excluded.starts_on` },
      });
    seriesCount = 1;
  }

  /* ---- report ---- */
  const counts = await db.execute(sql`
    select
      (select count(*) from users)          as users,
      (select count(*) from seats)          as seats,
      (select count(*) from seats where status = 'fixed')    as fixed_seats,
      (select count(*) from seats where status = 'bookable') as bookable_seats,
      (select count(*) from bookings)       as bookings,
      (select count(*) from bookings where status = 'auto_released'
                                         or status = 'completed_no_show') as no_shows,
      (select count(*) from bookings where status = 'cancelled_by_user')  as cancelled,
      (select count(*) from meeting_rooms)  as meeting_rooms,
      (select count(*) from room_bookings)  as room_bookings,
      (select count(*) from holidays)       as holidays
  `);

  console.table(counts.rows);
  console.log(`fixed seat pairings: ${fixedPairs}`);
  console.log(`seat releases: ${releaseRows.length} · recurring series: ${seriesCount}`);
  console.log(`booking dates covered: ${dates.length} working days`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
