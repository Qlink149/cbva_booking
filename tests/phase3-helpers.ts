/**
 * Fixtures for the Phase 3 write path.
 *
 * The Phase 1 helpers create one seat and one user, which is enough to prove a
 * constraint but not enough to exercise a booking engine: the edge cases need
 * two desks (to move a booking between them), two bookable people (to prove the
 * occupant rule discriminates), a fixed-grade manager, and an admin. Nobody
 * can book on somebody else's behalf — that was removed at CBVA's request.
 *
 * Same isolation strategy as Phase 1 and for the same reason: a private floor,
 * a random tag, and dates in 2099 that the seed never touches, so the suite runs
 * safely against a working demo database rather than needing one of its own.
 *
 * 2099-01-05 is a Monday, so 05-09 January is a clean working week with no
 * weekend and no seeded holiday in it.
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { Pool } from "pg";

import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/db";
import type { Clock } from "@/lib/clock";
import { DEFAULT_SLOT_DEFINITIONS, type SlotDefinition } from "@/lib/slots";
import type { AppSettings } from "@/lib/settings";

export function testConnectionString(): string {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");
  return url;
}

/**
 * A drizzle handle on the DIRECT endpoint.
 *
 * The services take their handle as an argument precisely so tests can hand
 * them this one: PgBouncer's transaction pooling makes "two sessions racing
 * each other" non-deterministic, and half the edge cases are exactly that.
 */
export function testDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

export function testPool(max = 8): Pool {
  return new Pool({ connectionString: testConnectionString(), max });
}

/** Frozen time. Every rule in the engine takes `now` rather than reading it. */
export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  set(next: Date): void {
    this.current = new Date(next);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** The 2099 working week the fixtures live in. */
export const MONDAY = "2099-01-05";
export const TUESDAY = "2099-01-06";
export const WEDNESDAY = "2099-01-07";

export interface Phase3Fixtures {
  tag: string;
  floorId: string;
  zoneId: string;
  /** Two bookable desks, so a booking can be moved between them. */
  seatA: { id: string; code: string };
  seatB: { id: string; code: string };
  /** An article: bookable grade, cannot book for anybody else. */
  article: schema.User;
  /** A second article, for the occupant-conflict and refused-on-behalf cases. */
  colleague: schema.User;
  /** A manager: fixed grade, so may not book a hot desk for themselves. */
  manager: schema.User;
  /** Admin/HR: may block desks, deactivate people, and cancel others' bookings. */
  admin: schema.User;
  roomId: string;
  roomName: string;
}

export async function createPhase3Fixtures(db: Db): Promise<Phase3Fixtures> {
  const tag = randomUUID().slice(0, 8);
  const floorId = randomUUID();
  const zoneId = randomUUID();

  await db.insert(schema.floors).values({
    id: floorId,
    number: 900,
    name: `Test Floor ${tag}`,
    isActive: true,
  });
  await db.insert(schema.zones).values({
    id: zoneId,
    floorId,
    code: `T${tag.slice(0, 3)}`,
    displayName: `Test Zone ${tag}`,
    sortOrder: 0,
  });

  const seatA = { id: randomUUID(), code: `TA-${tag}` };
  const seatB = { id: randomUUID(), code: `TB-${tag}` };
  await db.insert(schema.seats).values(
    [seatA, seatB].map((s, i) => ({
      id: s.id,
      zoneId,
      floorId,
      seatCode: s.code,
      bay: "TT",
      planX: String(i * 10),
      planY: "0",
      seatType: "workstation" as const,
      status: "bookable" as const,
      activeFrom: "2020-01-01",
    })),
  );

  const people = await db
    .insert(schema.users)
    .values([
      {
        id: randomUUID(),
        email: `article.${tag}@cbva.test`,
        displayName: `Article ${tag}`,
        grade: "article",
        seatMode: "bookable",
        team: "Audit",
      },
      {
        id: randomUUID(),
        email: `colleague.${tag}@cbva.test`,
        displayName: `Colleague ${tag}`,
        grade: "assistant_manager",
        seatMode: "bookable",
        team: "Tax",
      },
      {
        id: randomUUID(),
        email: `manager.${tag}@cbva.test`,
        displayName: `Manager ${tag}`,
        grade: "manager",
        seatMode: "fixed",
        team: "Audit",
      },
      {
        id: randomUUID(),
        email: `admin.${tag}@cbva.test`,
        displayName: `Admin ${tag}`,
        grade: "admin_staff",
        seatMode: "fixed",
        isAdmin: true,
        team: "Operations",
      },
    ])
    .returning();

  const roomId = randomUUID();
  const roomName = `Test Room ${tag}`;
  await db
    .insert(schema.meetingRooms)
    .values({ id: roomId, floorId, name: roomName, capacity: 6 });

  return {
    tag,
    floorId,
    zoneId,
    seatA,
    seatB,
    article: people[0]!,
    colleague: people[1]!,
    manager: people[2]!,
    admin: people[3]!,
    roomId,
    roomName,
  };
}

/**
 * Removes everything the fixture owns, in FK order.
 *
 * notification_log and audit_log rows are cleared by hand because neither
 * cascades — the first has ON DELETE SET NULL so it would survive as an
 * orphaned message, and the second has no FK at all by design.
 */
export async function destroyPhase3Fixtures(db: Db, f: Phase3Fixtures): Promise<void> {
  const userIds = [f.article.id, f.colleague.id, f.manager.id, f.admin.id];
  const emails = [f.article.email, f.colleague.email, f.manager.email, f.admin.email];

  await db.delete(schema.notificationLog).where(inArray(schema.notificationLog.recipientEmail, emails));
  await db.delete(schema.auditLog).where(inArray(schema.auditLog.actorUserId, userIds));
  await db.delete(schema.badgeEvents).where(inArray(schema.badgeEvents.userId, userIds));
  await db.delete(schema.bookings).where(inArray(schema.bookings.seatId, [f.seatA.id, f.seatB.id]));
  await db.delete(schema.roomBookings).where(eq(schema.roomBookings.roomId, f.roomId));
  await db.delete(schema.meetingRooms).where(eq(schema.meetingRooms.id, f.roomId));
  await db.delete(schema.seats).where(inArray(schema.seats.id, [f.seatA.id, f.seatB.id]));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.zones).where(eq(schema.zones.id, f.zoneId));
  await db.delete(schema.floors).where(eq(schema.floors.id, f.floorId));
}

/** Bookings and messages belonging to this fixture, between cases. */
export async function clearBookings(db: Db, f: Phase3Fixtures): Promise<void> {
  const emails = [f.article.email, f.colleague.email, f.manager.email, f.admin.email];
  await db.delete(schema.notificationLog).where(inArray(schema.notificationLog.recipientEmail, emails));
  await db.delete(schema.bookings).where(inArray(schema.bookings.seatId, [f.seatA.id, f.seatB.id]));
  await db.delete(schema.roomBookings).where(eq(schema.roomBookings.roomId, f.roomId));
}

export async function messagesFor(
  db: Db,
  f: Phase3Fixtures,
  kind?: string,
): Promise<Array<typeof schema.notificationLog.$inferSelect>> {
  const emails = [f.article.email, f.colleague.email, f.manager.email, f.admin.email];
  const where = kind
    ? and(inArray(schema.notificationLog.recipientEmail, emails), eq(schema.notificationLog.kind, kind))
    : inArray(schema.notificationLog.recipientEmail, emails);
  return db.select().from(schema.notificationLog).where(where);
}

export async function auditFor(db: Db, entityId: string) {
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, entityId));
}

export async function bookingById(db: Db, id: string) {
  const [row] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, id)).limit(1);
  return row;
}

/* --------------------------------------------------------------- settings */

/**
 * `settings` is a singleton shared with the dev server and every other test
 * file, so anything that changes it has to put it back. Snapshot in `beforeAll`,
 * restore in `afterAll`, without fail.
 */
export interface SettingsSnapshot {
  id: string;
  slotDefinitions: unknown;
  bookingWindowDays: number;
  bookingWindowWorkingDays: number;
  cutoffMinutes: number;
  autoReleaseMinutes: number;
  checkInOpensMinutesBefore: number;
  officeHours: unknown;
  demoOffsetSeconds: number;
}

export async function snapshotSettings(db: Db): Promise<SettingsSnapshot> {
  const [row] = await db.select().from(schema.settings).limit(1);
  if (!row) throw new Error("settings row missing — run `npm run seed`");
  return {
    id: row.id,
    slotDefinitions: row.slotDefinitions,
    bookingWindowDays: row.bookingWindowDays,
    bookingWindowWorkingDays: row.bookingWindowWorkingDays,
    cutoffMinutes: row.cutoffMinutes,
    autoReleaseMinutes: row.autoReleaseMinutes,
    checkInOpensMinutesBefore: row.checkInOpensMinutesBefore,
    officeHours: row.officeHours,
    demoOffsetSeconds: row.demoOffsetSeconds,
  };
}

export async function restoreSettings(db: Db, snap: SettingsSnapshot): Promise<void> {
  await db
    .update(schema.settings)
    .set({
      slotDefinitions: snap.slotDefinitions,
      bookingWindowDays: snap.bookingWindowDays,
      bookingWindowWorkingDays: snap.bookingWindowWorkingDays,
      cutoffMinutes: snap.cutoffMinutes,
      autoReleaseMinutes: snap.autoReleaseMinutes,
      checkInOpensMinutesBefore: snap.checkInOpensMinutesBefore,
      officeHours: snap.officeHours,
      demoOffsetSeconds: snap.demoOffsetSeconds,
    })
    .where(eq(schema.settings.id, snap.id));
}

export async function setSlotDefinitions(db: Db, definitions: SlotDefinition[]): Promise<void> {
  const [row] = await db.select({ id: schema.settings.id }).from(schema.settings).limit(1);
  await db
    .update(schema.settings)
    .set({ slotDefinitions: definitions })
    .where(eq(schema.settings.id, row!.id));
}

/**
 * Widens the bookable window so a fixture in 2099 is reachable from a fixed
 * clock set to that same week. The window rule itself is proven separately in
 * tests/unit/booking-days.test.ts; here it would only get in the way.
 */
export async function widenWindow(db: Db, workingDays = 10, calendarDays = 21): Promise<void> {
  const [row] = await db.select({ id: schema.settings.id }).from(schema.settings).limit(1);
  await db
    .update(schema.settings)
    .set({ bookingWindowWorkingDays: workingDays, bookingWindowDays: calendarDays })
    .where(eq(schema.settings.id, row!.id));
}

export const AM: SlotDefinition = DEFAULT_SLOT_DEFINITIONS[0]!;
export const PM: SlotDefinition = DEFAULT_SLOT_DEFINITIONS[1]!;

/** The instant a slot starts on a date, from the definitions in force. */
export function slotStart(settings: AppSettings, date: string, key: string): Date {
  const def = settings.slotDefinitions.find((d) => d.key === key)!;
  const [h, m] = def.start.split(":").map(Number);
  // IST is UTC+5:30 and has no DST, so this arithmetic is exact.
  return new Date(Date.UTC(...dateParts(date), h! - 5, m! - 30));
}

function dateParts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y!, m! - 1, d!];
}

/** Anything a test needs to strip that the seed might have left lying around. */
export async function purgeTestUsers(db: Db): Promise<void> {
  await db
    .delete(schema.users)
    .where(or(like(schema.users.email, "%@cbva.test"), eq(schema.users.email, "")));
}
