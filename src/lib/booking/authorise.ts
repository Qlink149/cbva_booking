/**
 * Who may write what.
 *
 * Pure functions over rows, so every rule here is unit-testable and none of it
 * depends on a request being in flight. Route handlers resolve the actor and
 * call in; nothing in this file touches the database or `next/headers`.
 */
import { BookingError } from "@/lib/booking/errors";
import type { Seat, User } from "@/lib/db/schema";

/** Grades that hold an allocated desk and therefore must not consume a hot one. */
const FIXED_GRADES = new Set(["partner", "director", "manager", "admin_staff"]);

export function assertSignedIn(actor: User | null): asserts actor is User {
  if (!actor) {
    throw new BookingError("NOT_SIGNED_IN", "You need to be signed in to do that.");
  }
  if (!actor.isActive) {
    throw new BookingError("FORBIDDEN", "This account is no longer active.");
  }
}

/**
 * May this person occupy a hot desk at all?
 *
 * A partner consuming a bookable desk is not a permission slip-up, it is a
 * capacity error: they already hold one, so the floor is now short by one and
 * every occupancy number is wrong by one. The analytics is the product, so this
 * is enforced rather than trusted.
 */
export interface OccupantContext {
  /**
   * This person has handed their own allocated desk back to the pool for the
   * date and slot being booked.
   *
   * Without this carve-out there is a hole with a straight face: a partner
   * releases their desk for the morning, changes their mind, and now has
   * nowhere to sit and no way to book one. Keyed on a `seat_releases` ROW, not
   * on grade, so the general rule that fixed grades do not consume hot desks is
   * not weakened — and the arithmetic stays right, because their released desk
   * added one to capacity and their new booking adds one to demand.
   */
  hasReleasedOwnSeat?: boolean;
}

export function assertOccupantMayBook(occupant: User, context: OccupantContext = {}): void {
  if (!occupant.isActive) {
    throw new BookingError(
      "OCCUPANT_INACTIVE",
      "This account is no longer active, so a desk cannot be booked for it.",
    );
  }
  if (context.hasReleasedOwnSeat) return;
  if (occupant.seatMode !== "bookable" || FIXED_GRADES.has(occupant.grade)) {
    throw new BookingError(
      "NOT_BOOKABLE_GRADE",
      "You have an allocated desk, so there is nothing to book. Hot desks are for Assistant Manager grade and below.",
    );
  }
}

/**
 * A desk is only ever booked by the person who will sit at it — for every
 * grade, admins included. CBVA asked for booking on somebody else's behalf to
 * be removed (Oct 2026; ASSUMPTIONS A7). Historical on-behalf rows are kept and
 * still count in the analytics; nothing can create a new one.
 */
export function assertBookingForSelf(actor: User, occupantUserId: string | undefined): void {
  if (occupantUserId !== undefined && occupantUserId !== actor.id) {
    throw new BookingError("NOT_PERMITTED_ON_BEHALF", "Desks can only be booked for yourself.");
  }
}

export function assertMayBookFor(
  actor: User,
  occupant: User,
  context: OccupantContext = {},
): void {
  assertBookingForSelf(actor, occupant.id);
  assertOccupantMayBook(occupant, context);
}

/**
 * @param release  A live, unrevoked `seat_releases` row for the exact date and
 *   slot being booked, when the caller found one. A fixed desk whose owner has
 *   released it IS bookable for that slot and for nobody else's.
 *
 *   This is a rule about the DESK. The separate rule about which PEOPLE may
 *   occupy a hot desk lives in assertOccupantMayBook and is untouched by it.
 */
export function assertSeatBookable(
  seat: Seat | undefined,
  release?: { id: string } | null,
): asserts seat is Seat {
  if (!seat) {
    throw new BookingError("SEAT_NOT_FOUND", "That desk is not on the floor plan.");
  }
  if (seat.status === "fixed" && release) return;
  if (seat.status !== "bookable") {
    const why: Record<string, string> = {
      fixed: `${seat.seatCode} is allocated to somebody, so it cannot be booked.`,
      blocked: `${seat.seatCode} is out of service.`,
      decommissioned: `${seat.seatCode} is no longer a desk.`,
    };
    throw new BookingError("SEAT_NOT_BOOKABLE", why[seat.status] ?? "That desk is not bookable.");
  }
}

/**
 * Who may change an existing booking: the person sitting there, the person who
 * made it, or an admin. A manager who booked for their team keeps the ability
 * to unbook it.
 */
/**
 * Who may hand a fixed desk back to the pool: the person it is allocated to, or
 * an admin doing it on their behalf. Not the person's manager — an allocated
 * desk is theirs, and somebody else giving it away is a surprise nobody wants
 * on a Monday morning.
 */
export function assertMayReleaseSeat(actor: User, seat: Seat): void {
  if (seat.status !== "fixed") {
    throw new BookingError(
      "SEAT_NOT_RELEASABLE",
      `${seat.seatCode} is not an allocated desk, so there is nothing to release.`,
    );
  }
  if (actor.isAdmin) return;
  if (seat.assignedUserId !== actor.id) {
    throw new BookingError(
      "FORBIDDEN",
      `${seat.seatCode} is not your desk to release.`,
    );
  }
}

export function assertMayMutateBooking(
  actor: User,
  booking: { occupantUserId: string; bookedByUserId: string },
): void {
  const mine =
    booking.occupantUserId === actor.id || booking.bookedByUserId === actor.id || actor.isAdmin;
  if (!mine) {
    throw new BookingError("FORBIDDEN", "That is not your booking to change.");
  }
}

export function assertAdmin(actor: User): void {
  if (!actor.isAdmin) {
    throw new BookingError("FORBIDDEN", "That is an administrator action.");
  }
}
