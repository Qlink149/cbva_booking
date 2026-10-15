/**
 * The shapes the analytics reads return, and the labels that go with them.
 *
 * SEPARATE FROM queries.ts ON PURPOSE, and this is a bundle boundary rather
 * than tidiness. `queries.ts` imports `@/lib/db`, which imports `pg`, which
 * needs `fs` — so a client component importing ANYTHING from it, even a single
 * label constant, drags the Postgres driver into the browser bundle and the
 * build fails with "Can't resolve 'fs'".
 *
 * It is the same trap ADR-031 documents for `three`, one layer down, and it
 * fails the same way: not with a wrong number, but with a build error or a
 * bundle four times bigger than it should be. Types alone would survive
 * erasure; a runtime value like WEEKDAY_LABELS does not, which is exactly how
 * this was found.
 *
 * Nothing in this file may import anything with a runtime dependency.
 */

export interface CapacityRow {
  date: string;
  slot: string;
  /**
   * The STRUCTURAL supply: desks whose own status is `bookable` and which were
   * active on this date. 110 today. This is the headline denominator — a partner
   * may reclaim a released desk at any time, so released fixed desks are not
   * supply anybody can plan against.
   */
  pool: number;
  /**
   * The supply that actually existed in this slot: `pool` plus fixed desks
   * their owners had released. Utilisation against this is the honest
   * operational number.
   */
  capacity: number;
  releasedFixed: number;
  /** Slot length in hours, from settings — not derived from any booking. */
  slotHours: number;
  seatHourCapacity: number;
}

export interface HeatCell {
  bay: string;
  zone: string;
  weekday: number;
  desksClaimed: number;
  desksAttended: number;
  seatHours: number;
  /** Distinct dates in the period that fell on this weekday and had data. */
  observedDays: number;
}

export interface Headline {
  /** The busiest single slot observed in the period. */
  peak: number;
  peakDate: string | null;
  peakSlot: string | null;
  /** What you would actually right-size against. */
  p95: number;
  median: number;
  /** Structural bookable supply on the peak day. */
  pool: number;
  /** Distinct people who claimed a desk at any point in the period. */
  distinctPeople: number;
  observedSlots: number;
  from: string;
  to: string;
}

export interface BookingExportRow {
  bookingDate: string;
  slot: string;
  seatCode: string;
  bay: string;
  zone: string;
  occupantName: string;
  occupantEmail: string;
  grade: string;
  team: string | null;
  status: string;
  source: string;
  checkedInAt: string | null;
  checkInMethod: string | null;
  releasedAt: string | null;
  cancelledAt: string | null;
  seatHours: number;
  fromReleasedFixedSeat: boolean;
  recurring: boolean;
}

export interface SeatUtilisationRow {
  seatCode: string;
  bay: string;
  zone: string;
  seatStatus: string;
  /** Slots in the period this desk was claimed for. */
  slotsClaimed: number;
  slotsAttended: number;
  seatHours: number;
  /** Slots the desk was available across the period. */
  slotsAvailable: number;
  utilisationPct: number;
}

export interface WeekdayRow {
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  slot: string;
  /** Mean desks claimed on a single day of this weekday. */
  meanDesks: number;
  meanAttended: number;
  meanSeatHours: number;
  peakDesks: number;
  minDesks: number;
  /** How many days of this weekday the period actually contained. */
  observedDays: number;
}

export interface MeasureRow {
  desksClaimed: number;
  claims: number;
  peopleClaiming: number;
  desksAttended: number;
  peopleAttended: number;
  deskVerified: number;
  badgeOnly: number;
  noShows: number;
  autoReleased: number;
  cancellations: number;
  /** `numeric` arrives from pg as a string. Deliberate — see the conventions. */
  seatHours: number;
  seatHoursNoShowFree: number;
}

export interface AnalyticsFilters {
  /** yyyy-MM-dd, inclusive. */
  from: string;
  /** yyyy-MM-dd, inclusive. */
  to: string;
  /** Zone code, e.g. "C". Null means the whole floor. */
  zone?: string | null;
  bay?: string | null;
  team?: string | null;
  /** Restrict to one slot key. Null means every slot. */
  slot?: string | null;
}

export const WEEKDAY_LABELS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface DaySlotRow extends MeasureRow {
  date: string;
  slot: string;
  /** ISO weekday, 1 = Monday. */
  weekday: number;
}

export interface DimensionRow extends MeasureRow {
  key: string;
}
