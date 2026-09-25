import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* ------------------------------------------------------------------ enums */

export const gradeEnum = pgEnum("grade", [
  "partner",
  "director",
  "manager",
  "assistant_manager",
  "article",
  "admin_staff",
]);

export const seatModeEnum = pgEnum("seat_mode", ["fixed", "bookable"]);

export const seatTypeEnum = pgEnum("seat_type", [
  "workstation",
  "passage",
  "foldable",
  "cabin",
]);

export const seatStatusEnum = pgEnum("seat_status", [
  "bookable",
  "fixed",
  "blocked",
  "decommissioned",
]);

/**
 * There is deliberately no `slot` enum.
 *
 * `bookings.slot` is text. The brief requires that switching from half-days to
 * hourly booking be a change to `settings.slot_definitions` and nothing else —
 * an enum makes that a migration, which is exactly the refactor it must not be.
 * Slot keys are validated against the live definitions in src/lib/slots.ts,
 * which is where an editable vocabulary belongs. See ADR-020.
 */

export const bookingStatusEnum = pgEnum("booking_status", [
  "confirmed",
  "checked_in",
  "cancelled_by_user",
  /**
   * Arrived, was counted present, then dropped the desk. A different fact from
   * a plain cancellation, and occupancy reporting must not blend the two.
   */
  "cancelled_after_check_in",
  /** We cancelled it for them — a desk was blocked, or a user deactivated. */
  "cancelled_by_admin",
  "auto_released",
  "completed",
  "completed_no_show",
]);

export const bookingSourceEnum = pgEnum("booking_source", [
  "self",
  "on_behalf",
  "admin",
]);

export const roomBookingStatusEnum = pgEnum("room_booking_status", [
  "confirmed",
  "cancelled",
  "completed",
]);

export const syncStatusEnum = pgEnum("sync_status", [
  "pending",
  "synced",
  "failed",
]);

export const notificationStatusEnum = pgEnum("notification_status", [
  "queued",
  "sent",
  "failed",
]);

/* ------------------------------------------------------------------ tables */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    grade: gradeEnum("grade").notNull(),
    team: text("team"),
    seatMode: seatModeEnum("seat_mode").notNull().default("bookable"),
    // FK added in the constraints migration: seats and users reference each
    // other, so one direction has to be wired after both tables exist.
    fixedSeatId: uuid("fixed_seat_id"),
    isAdmin: boolean("is_admin").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * Opt-out of the coworker roster. Defaults true, because a "who is in on
     * Tuesday" view that nobody has opted into is an empty screen that argues
     * for nothing — and countering low booking uptake is the whole reason it
     * exists. Opting out hides the NAME, never the desk, so occupancy data is
     * unaffected by the privacy choice.
     */
    shareAttendance: boolean("share_attendance").notNull().default(true),
    /** scrypt password hash. Null means this account uses SSO/demo switching. */
    passwordHash: text("password_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email),
    index("users_grade_idx").on(t.grade),
    index("users_seat_mode_idx").on(t.seatMode),
  ],
);

export const floors = pgTable("floors", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: integer("number").notNull(),
  name: text("name").notNull(),
  /** Key into assets/cad — the plan SVG this floor renders from in Phase 2. */
  planAssetKey: text("plan_asset_key"),
  isActive: boolean("is_active").notNull().default(true),
});

export const zones = pgTable(
  "zones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    floorId: uuid("floor_id")
      .notNull()
      .references(() => floors.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    displayName: text("display_name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("zones_floor_code_unique").on(t.floorId, t.code)],
);

export const seats = pgTable(
  "seats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    zoneId: uuid("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "restrict" }),
    floorId: uuid("floor_id")
      .notNull()
      .references(() => floors.id, { onDelete: "restrict" }),
    seatCode: text("seat_code").notNull(),
    bay: text("bay").notNull(),
    /**
     * Plan coordinate space, not pixels. Phase 1 seeds a temporary grid;
     * Phase 2 overwrites both from the CAD extraction in tools/cad/.
     */
    planX: numeric("plan_x", { precision: 10, scale: 2 }).notNull(),
    planY: numeric("plan_y", { precision: 10, scale: 2 }).notNull(),
    rotationDeg: integer("rotation_deg").notNull().default(0),
    seatType: seatTypeEnum("seat_type").notNull().default("workstation"),
    status: seatStatusEnum("status").notNull().default("bookable"),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    amenities: jsonb("amenities").notNull().default(sql`'{}'::jsonb`),
    activeFrom: date("active_from").notNull(),
    activeTo: date("active_to"),
  },
  (t) => [
    uniqueIndex("seats_seat_code_unique").on(t.seatCode),
    index("seats_zone_idx").on(t.zoneId),
    index("seats_bay_idx").on(t.bay),
    index("seats_status_idx").on(t.status),
  ],
);

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seatId: uuid("seat_id")
      .notNull()
      .references(() => seats.id, { onDelete: "restrict" }),
    bookingDate: date("booking_date").notNull(),
    /** A key into settings.slot_definitions. Text, not an enum — see ADR-020. */
    slot: text("slot").notNull(),
    /**
     * Derived from bookingDate + slot via deriveSlotBounds() in
     * src/lib/slots.ts. Stored so the auto-release job can range-scan without
     * re-deriving. Never write these by hand.
     */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    bookedByUserId: uuid("booked_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    occupantUserId: uuid("occupant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: bookingStatusEnum("status").notNull().default("confirmed"),
    source: bookingSourceEnum("source").notNull().default("self"),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    /**
     * How the check-in arrived: 'qr' | 'badge' | 'app' | 'admin'.
     *
     * The whole point of the desk QR recommendation. A door swipe proves
     * somebody entered the floor; a desk QR proves they used THIS desk. They
     * are different evidence and the analytics must be able to tell them apart.
     */
    checkInMethod: text("check_in_method"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id"),
    /**
     * Set when this booking only exists because a fixed desk's owner released
     * it for this date and slot. Analytics reads it to answer "how much demand
     * did released desks absorb"; the revoke path reads it to refuse to reclaim
     * a desk somebody is sitting at. FK added in 0003.
     */
    releaseId: uuid("release_id"),
    /**
     * The recurring series that materialised this row, if any. A cancelled row
     * KEEPS its seriesId — it is the tombstone that stops the job recreating a
     * deliberately cancelled occurrence. editBooking() must therefore null this
     * on the rebooked row; see booking_series_occurrence_unique in 0003.
     */
    seriesId: uuid("series_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // NOTE: the uniqueness rule that actually matters (one active booking per
    // seat/date/slot) is a PARTIAL unique index and lives in the hand-written
    // migration drizzle/0001_constraints.sql. Drizzle cannot express the
    // predicate, and it must not be duplicated at app level.
    index("bookings_date_idx").on(t.bookingDate),
    index("bookings_seat_date_idx").on(t.seatId, t.bookingDate),
    index("bookings_occupant_idx").on(t.occupantUserId),
    index("bookings_status_idx").on(t.status),
    index("bookings_starts_at_idx").on(t.startsAt),
  ],
);

export const meetingRooms = pgTable(
  "meeting_rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    floorId: uuid("floor_id")
      .notNull()
      .references(() => floors.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /**
     * The architect's bay tag for this room -- A3, A9, A8, A7, A6. It is the
     * join key between /rooms and the floor plan: the plan labels a room by
     * bay, and without this the two could only be matched on a display name
     * that CBVA is expected to change.
     */
    bayCode: text("bay_code"),
    capacity: integer("capacity").notNull(),
    amenities: jsonb("amenities").notNull().default(sql`'{}'::jsonb`),
    /** Outlook room resource mailbox. Null until IT gives us the list. */
    outlookResourceEmail: text("outlook_resource_email"),
    isBookable: boolean("is_bookable").notNull().default(true),
  },
  (t) => [uniqueIndex("meeting_rooms_name_unique").on(t.name)],
);

export const roomBookings = pgTable(
  "room_bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => meetingRooms.id, { onDelete: "restrict" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    organiserUserId: uuid("organiser_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    status: roomBookingStatusEnum("status").notNull().default("confirmed"),
    calendarEventId: text("calendar_event_id"),
    syncStatus: syncStatusEnum("sync_status").notNull().default("pending"),
    syncAttempts: integer("sync_attempts").notNull().default(0),
    syncError: text("sync_error"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Overlap prevention is a GiST exclusion constraint in
    // drizzle/0001_constraints.sql. Rooms are arbitrary ranges, not slots.
    index("room_bookings_room_starts_idx").on(t.roomId, t.startsAt),
    index("room_bookings_starts_at_idx").on(t.startsAt),
  ],
);

/**
 * Stub table. No badge feed exists yet; CheckInSource writes here in demo mode
 * so a real reader webhook can land later with no schema change.
 */
export const badgeEvents = pgTable(
  "badge_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    swipedAt: timestamp("swiped_at", { withTimezone: true }).notNull(),
    readerId: text("reader_id"),
    raw: jsonb("raw").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index("badge_events_user_swiped_idx").on(t.userId, t.swipedAt)],
);

export const notificationLog = pgTable(
  "notification_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    bookingId: uuid("booking_id").references(() => bookings.id, {
      onDelete: "set null",
    }),
    roomBookingId: uuid("room_booking_id").references(() => roomBookings.id, {
      onDelete: "set null",
    }),
    recipientEmail: text("recipient_email").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    channel: text("channel").notNull().default("email"),
    status: notificationStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Retry backoff. Null means "eligible now". */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    error: text("error"),
    /**
     * A message about an occurrence that was NEVER created — the materialiser
     * lost the seat. notification_log_job_kind_once keys on bookingId, which is
     * null here, so 0003 adds a second once-only key over these two.
     */
    seriesId: uuid("series_id"),
    occurrenceDate: date("occurrence_date"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("notification_log_kind_idx").on(t.kind),
    index("notification_log_status_idx").on(t.status),
  ],
);

export const holidays = pgTable(
  "holidays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    holidayDate: date("holiday_date").notNull(),
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("holidays_date_unique").on(t.holidayDate)],
);

/**
 * Singleton. Exactly one row, enforced by settings_singleton in the
 * constraints migration.
 */
export const settings = pgTable("settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingWindowDays: integer("booking_window_days").notNull().default(14),
  slotDefinitions: jsonb("slot_definitions").notNull(),
  /**
   * The rule the brief states: the next N WORKING days are bookable.
   * bookingWindowDays above stays as the calendar-day bound the scan stops at,
   * so a long run of holidays cannot make it unbounded.
   */
  bookingWindowWorkingDays: integer("booking_window_working_days")
    .notNull()
    .default(5),
  autoReleaseMinutes: integer("auto_release_minutes").notNull().default(120),
  cutoffMinutes: integer("cutoff_minutes").notNull().default(60),
  /** How early a booking may be checked into, relative to its slot start. */
  checkInOpensMinutesBefore: integer("check_in_opens_minutes_before")
    .notNull()
    .default(30),
  /** { start: "HH:mm", end: "HH:mm" } — the bounds of the meeting room grid. */
  officeHours: jsonb("office_hours")
    .notNull()
    .default(sql`'{"start":"08:00","end":"20:00"}'::jsonb`),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  /**
   * DemoClock offset. Held here rather than in memory so server and client
   * agree and the offset survives a page refresh — see src/lib/clock.ts.
   */
  demoOffsetSeconds: integer("demo_offset_seconds").notNull().default(0),
  /**
   * Blast-radius bounds for runAutoRelease (ASSUMPTIONS A22). Settings-backed
   * rather than constants because the right cap is a function of the bookable
   * pool and the slots per day, and both of those are configuration: at hourly
   * slots the legitimate daily volume is four times what it is at half-days.
   */
  autoReleaseBatchCap: integer("auto_release_batch_cap").notNull().default(250),
  autoReleaseHorizonDays: integer("auto_release_horizon_days")
    .notNull()
    .default(3),
});

/**
 * A fixed desk, handed back to the pool for one date and one slot.
 *
 * 47 of the 141 desks are allocated and therefore never appear in the occupancy
 * data — they are a constant, not a measurement. This table is the only route
 * by which they ever get measured.
 *
 * Revoking sets revoked_at rather than deleting, and seat_release_unique is
 * partial on that column: a desk released and later reclaimed is a fact about
 * how the floor was used, and the history is the analytics.
 */
export const seatReleases = pgTable(
  "seat_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seatId: uuid("seat_id")
      .notNull()
      .references(() => seats.id, { onDelete: "restrict" }),
    releaseDate: date("release_date").notNull(),
    slot: text("slot").notNull(),
    /** Derived by deriveSlotBounds() and nowhere else, like bookings. */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    releasedByUserId: uuid("released_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    note: text("note"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // seat_release_unique is PARTIAL on revoked_at and lives in 0003; drizzle
  // cannot express the predicate. Do not add an app-level pre-check for it.
  (t) => [
    index("seat_releases_date_slot_idx").on(t.releaseDate, t.slot),
    index("seat_releases_owner_idx").on(t.ownerUserId, t.releaseDate),
  ],
);

/**
 * A recurring booking: same seat, same slot, same weekdays, materialised into
 * real `bookings` rows by the job as the booking window rolls forward.
 *
 * There is deliberately no exceptions table. Cancelling one occurrence leaves a
 * cancelled booking row carrying (seriesId, bookingDate, slot), and
 * booking_series_occurrence_unique is NOT partial on status — so that row is
 * the tombstone the materialiser conflicts with. See 0003.
 */
export const bookingSeries = pgTable(
  "booking_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occupantUserId: uuid("occupant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    seatId: uuid("seat_id")
      .notNull()
      .references(() => seats.id, { onDelete: "restrict" }),
    slot: text("slot").notNull(),
    /** ISO weekdays, 1 = Monday to 7 = Sunday — the same numbering as isodow. */
    weekdays: smallint("weekdays").array().notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    /** 'active' | 'paused' | 'ended', checked in 0003. */
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("booking_series_occupant_idx").on(t.occupantUserId)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id"),
    action: text("action").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_entity_idx").on(t.entity, t.entityId)],
);

/* ------------------------------------------------------------------ types */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Seat = typeof seats.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
export type MeetingRoom = typeof meetingRooms.$inferSelect;
export type RoomBooking = typeof roomBookings.$inferSelect;
export type NewRoomBooking = typeof roomBookings.$inferInsert;
export type BadgeEvent = typeof badgeEvents.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Zone = typeof zones.$inferSelect;
export type Floor = typeof floors.$inferSelect;
export type Holiday = typeof holidays.$inferSelect;
export type NotificationLog = typeof notificationLog.$inferSelect;
export type NewNotificationLog = typeof notificationLog.$inferInsert;
export type AuditLog = typeof auditLog.$inferSelect;
export type SeatRelease = typeof seatReleases.$inferSelect;
export type NewSeatRelease = typeof seatReleases.$inferInsert;
export type BookingSeries = typeof bookingSeries.$inferSelect;
export type NewBookingSeries = typeof bookingSeries.$inferInsert;
/** booking_series.status — 'active' | 'paused' | 'ended'. */
export type SeriesStatus = "active" | "paused" | "ended";
export type Grade = (typeof gradeEnum.enumValues)[number];
/** A key into settings.slot_definitions, not a closed set. See ADR-020. */
export type Slot = string;
export type BookingStatus = (typeof bookingStatusEnum.enumValues)[number];
export type SeatStatus = (typeof seatStatusEnum.enumValues)[number];
