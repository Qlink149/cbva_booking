-- Who else is coming to a booked room, beyond the organiser.
--
-- Hand-written and hand-registered in drizzle/meta/_journal.json, like 0001
-- through 0005. Every statement is idempotent so a partially applied run can
-- be re-run.
--
-- user_id is nullable on purpose: an attendee may be a CBVA employee (matched
-- by email against `users`, active only) or somebody outside the firm — a
-- client, a vendor — who has no row to link to. Either way name and email are
-- always stored, so the room always shows who is coming even when the person
-- is not one of ours.
CREATE TABLE IF NOT EXISTS room_booking_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_booking_id uuid NOT NULL REFERENCES room_bookings(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One invite per email per meeting. Lower-cased at the app layer before this
-- runs, so "A@cbva.in" and "a@cbva.in" collide here rather than becoming two
-- rows for the same person.
CREATE UNIQUE INDEX IF NOT EXISTS room_booking_attendees_unique
  ON room_booking_attendees (room_booking_id, email);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS room_booking_attendees_booking_idx
  ON room_booking_attendees (room_booking_id);
