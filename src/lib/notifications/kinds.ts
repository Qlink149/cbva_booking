/**
 * The nine things this product tells people about.
 *
 * `notification_log.kind` is plain text in the schema, so this union is the
 * only thing keeping the vocabulary closed. Adding a kind means adding a
 * template, which is deliberate — a notification with no template would be
 * delivered as an empty email.
 */
export const NOTIFICATION_KINDS = [
  "booking_confirmed",
  // History only. Booking on somebody's behalf was removed (Oct 2026), so this
  // is never sent again; it stays so the admin outbox can label and filter the
  // rows that were sent before. render.ts excludes it from what can be sent.
  "booked_on_your_behalf",
  "booking_edited",
  "booking_cancelled",
  "auto_released",
  "reminder",
  "room_confirmed",
  "room_cancelled",
  "series_occurrence_failed",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Kinds a JOB emits rather than a person. These carry a partial unique index on
 * (kind, booking_id, recipient_email) so a job that runs twice — or two workers
 * that run at once — cannot produce two copies of the same message.
 */
export const JOB_EMITTED_KINDS: ReadonlySet<NotificationKind> = new Set([
  "auto_released",
  "reminder",
  // This one is keyed differently — on (kind, series_id, occurrence_date,
  // recipient_email) — because the booking it is about was never created, so
  // booking_id is null and the usual index cannot see it. See 0003.
  "series_occurrence_failed",
]);

export const NOTIFICATION_LABELS: Record<NotificationKind, string> = {
  booking_confirmed: "Booking confirmed",
  booked_on_your_behalf: "Booked on your behalf",
  booking_edited: "Booking changed",
  booking_cancelled: "Booking cancelled",
  auto_released: "Desk auto-released",
  reminder: "Check-in reminder",
  room_confirmed: "Room booked",
  room_cancelled: "Room booking cancelled",
  series_occurrence_failed: "Recurring booking could not be made",
};
