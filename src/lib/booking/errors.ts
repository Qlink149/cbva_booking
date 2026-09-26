/**
 * Every way a write can legitimately fail, as data.
 *
 * The point of a code union rather than thrown strings: "somebody just took
 * that seat" is an ORDINARY OUTCOME, not a 500. ADR-003 put both integrity
 * rules in the database precisely so the app would find out about a race from
 * Postgres rather than from a pre-check with a hole in it — which means the
 * insert path has to be able to tell a race apart from a bug, and the UI has to
 * be able to react to one specifically (refresh the map) rather than showing
 * "something went wrong".
 */

export type BookingErrorCode =
  /* races, straight from the database */
  | "SEAT_TAKEN"
  | "OCCUPANT_ALREADY_BOOKED"
  | "ROOM_OVERLAP"
  /* the request is not allowed */
  | "NOT_SIGNED_IN"
  | "FORBIDDEN"
  | "NOT_BOOKABLE_GRADE"
  | "NOT_PERMITTED_ON_BEHALF"
  | "OCCUPANT_NOT_BOOKABLE"
  | "OCCUPANT_INACTIVE"
  /* the request does not describe a bookable thing */
  | "SEAT_NOT_FOUND"
  | "SEAT_NOT_BOOKABLE"
  | "UNKNOWN_SLOT"
  | "DATE_OUTSIDE_WINDOW"
  | "ROOM_NOT_FOUND"
  | "ROOM_NOT_BOOKABLE"
  | "ROOM_DATE_NOT_BOOKABLE"
  | "OUTSIDE_OFFICE_HOURS"
  | "INVALID_RANGE"
  /* the request is too late, or aimed at something that moved */
  | "PAST_CUTOFF"
  | "BOOKING_NOT_FOUND"
  | "BOOKING_NOT_ACTIVE"
  | "BOOKING_CONFLICT"
  | "CHECK_IN_WINDOW_CLOSED"
  | "NO_BOOKING_FOR_SEAT"
  | "SEAT_HAS_FUTURE_BOOKINGS"
  | "USER_NOT_FOUND"
  /* releasing and reclaiming an allocated desk */
  | "SEAT_NOT_RELEASABLE"
  | "SEAT_RELEASE_TAKEN"
  | "RELEASE_NOT_FOUND"
  | "SEAT_NOT_RELEASED"
  /* recurring bookings */
  | "SERIES_NOT_FOUND"
  | "SERIES_INVALID";

const STATUS: Record<BookingErrorCode, number> = {
  SEAT_TAKEN: 409,
  OCCUPANT_ALREADY_BOOKED: 409,
  ROOM_OVERLAP: 409,
  NOT_SIGNED_IN: 401,
  FORBIDDEN: 403,
  NOT_BOOKABLE_GRADE: 403,
  NOT_PERMITTED_ON_BEHALF: 403,
  OCCUPANT_NOT_BOOKABLE: 422,
  OCCUPANT_INACTIVE: 422,
  SEAT_NOT_FOUND: 404,
  SEAT_NOT_BOOKABLE: 422,
  UNKNOWN_SLOT: 422,
  DATE_OUTSIDE_WINDOW: 422,
  ROOM_NOT_FOUND: 404,
  ROOM_NOT_BOOKABLE: 422,
  ROOM_DATE_NOT_BOOKABLE: 422,
  OUTSIDE_OFFICE_HOURS: 422,
  INVALID_RANGE: 422,
  PAST_CUTOFF: 409,
  BOOKING_NOT_FOUND: 404,
  BOOKING_NOT_ACTIVE: 409,
  BOOKING_CONFLICT: 409,
  CHECK_IN_WINDOW_CLOSED: 409,
  NO_BOOKING_FOR_SEAT: 404,
  SEAT_HAS_FUTURE_BOOKINGS: 409,
  USER_NOT_FOUND: 404,
  SEAT_NOT_RELEASABLE: 422,
  SEAT_RELEASE_TAKEN: 409,
  RELEASE_NOT_FOUND: 404,
  SEAT_NOT_RELEASED: 422,
  SERIES_NOT_FOUND: 404,
  SERIES_INVALID: 422,
};

export class BookingError extends Error {
  readonly code: BookingErrorCode;
  readonly status: number;
  /** Anything the UI needs to render a useful screen — the conflicting booking, the affected list. */
  readonly details?: unknown;

  constructor(code: BookingErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BookingError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export function isBookingError(err: unknown): err is BookingError {
  return err instanceof BookingError;
}

interface PgLikeError {
  code?: string;
  constraint?: string;
}

/**
 * Digs the real Postgres error out of whatever wrapped it.
 *
 * Drizzle raises a `DrizzleQueryError` carrying the driver's error on `.cause`,
 * so the SQLSTATE and constraint name are one or more levels down. Reading the
 * top-level object finds neither, which turns "somebody just took that desk"
 * into an unhandled 500 — a failure mode that only shows up under the exact
 * concurrency the constraints exist for.
 */
function unwrapPgError(err: unknown): PgLikeError | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as PgLikeError & { cause?: unknown };
    if (typeof candidate.code === "string" && candidate.code.length > 0) return candidate;
    current = candidate.cause;
  }
  return null;
}

/**
 * Turns a Postgres integrity violation into the outcome it actually represents.
 *
 * Returns null for anything it does not recognise, so a genuine bug still
 * surfaces as a 500 rather than being dressed up as a booking conflict.
 */
export function mapPgError(err: unknown): BookingError | null {
  const e = unwrapPgError(err);
  if (!e) return null;

  if (e.code === "23505" && e.constraint === "seat_slot_unique") {
    return new BookingError(
      "SEAT_TAKEN",
      "Somebody booked that desk a moment before you did. The plan has been refreshed — please pick another.",
    );
  }
  if (e.code === "23505" && e.constraint === "occupant_slot_unique") {
    return new BookingError(
      "OCCUPANT_ALREADY_BOOKED",
      "There is already a desk booked for that person in that slot.",
    );
  }
  if (e.code === "23505" && e.constraint === "seat_release_unique") {
    return new BookingError(
      "SEAT_RELEASE_TAKEN",
      "That desk has already been released for that slot.",
    );
  }
  // The tombstone. editBooking() nulls series_id on the rebooked row precisely
  // so this cannot happen; if it ever does, it is a bug in the write path and
  // the message says so rather than showing an index name to a partner.
  if (e.code === "23505" && e.constraint === "booking_series_occurrence_unique") {
    return new BookingError(
      "BOOKING_CONFLICT",
      "That date is already accounted for in the recurring booking.",
    );
  }
  if (e.code === "23P01" && e.constraint === "no_room_overlap") {
    return new BookingError(
      "ROOM_OVERLAP",
      "That room was booked for part of this time while you were choosing. The grid has been refreshed.",
    );
  }
  if (e.code === "23514") {
    return new BookingError("INVALID_RANGE", "That time range is not valid.");
  }
  return null;
}

/** Re-throws as a BookingError where the database has told us what happened. */
export function rethrowMapped(err: unknown): never {
  const mapped = mapPgError(err);
  throw mapped ?? err;
}

/** The SQLSTATE and constraint of a database error, wrapper or not. */
export function pgErrorInfo(err: unknown): PgLikeError | null {
  return unwrapPgError(err);
}
