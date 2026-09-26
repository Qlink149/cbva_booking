"use client";

/**
 * Where a booking is actually made.
 *
 * A dialog rather than a one-tap action on the seat, because the seat, the date
 * and the slot somebody is about to commit to should be spelled out before they
 * commit to them — and because this is where the two things that make a booking
 * wrong live: booking the wrong desk or slot, and booking something you can no
 * longer change. It always books for the person signed in.
 *
 * It handles three shapes of the same screen: a free desk (book it), your own
 * booking (check in, move it, drop it), and somebody else's (read only).
 */
import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";

import {
  useBookSeat,
  useCancelBooking,
  useCheckIn,
  type ApiError,
} from "@/components/booking/use-bookings";
import { SEAT_STATUS_TOKENS } from "@/components/seat/seat-status";
import { SeatSwatchWithGlyph } from "@/components/seat/seat-swatch";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, StatusMessage } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/switch";
import { request } from "@/components/admin/api";
import type { FloorPlanSeat, SlotDefinition, SlotKey } from "@/components/floor-plan/types";

/** ISO weekday names, 1 = Monday, matching what the series API expects. */
const WEEKDAY_NAMES = [
  "", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
] as const;

/** yyyy-MM-dd to an ISO weekday. Parsed as UTC so no timezone can shift it. */
function isoWeekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const js = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return js === 0 ? 7 : js;
}

interface SeriesResult {
  created: number;
  failed: Array<{ bookingDate: string; message: string }>;
}

function createSeries(body: {
  seatCode: string;
  slot: string;
  weekdays: number[];
  startsOn: string;
}): Promise<SeriesResult> {
  return request<SeriesResult>("/api/series", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const TZ = "Asia/Kolkata";

export interface BookingDialogProps {
  seat: FloorPlanSeat | null;
  date: string | null;
  slot: SlotKey;
  slotDefinition: SlotDefinition | null;
  /** Shared clock, in ISO. Never the browser's own Date. */
  now: string | null;
  cutoffMinutes: number;
  onClose: () => void;
}

function longDate(date: string): string {
  return formatInTimeZone(`${date}T00:00:00Z`, "UTC", "EEEE d MMMM");
}

/** The instant after which this booking can no longer be changed. */
function cutoffFor(date: string, slot: SlotDefinition, cutoffMinutes: number): Date {
  const [h, m] = slot.start.split(":").map(Number);
  const startsAt = new Date(Date.UTC(...isoParts(date), (h ?? 0) - 5, (m ?? 0) - 30));
  return new Date(startsAt.getTime() - cutoffMinutes * 60_000);
}

function isoParts(date: string): [number, number, number] {
  const [y, mo, d] = date.split("-").map(Number);
  return [y ?? 2026, (mo ?? 1) - 1, d ?? 1];
}

export function BookingDialog({
  seat,
  date,
  slot,
  slotDefinition,
  now,
  cutoffMinutes,
  onClose,
}: BookingDialogProps) {
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  /**
   * Declared here with the other state, NOT next to the button that uses it —
   * this component early-returns when there is no seat, so a hook further down
   * is called conditionally and React's hook order breaks. Caught by lint.
   */
  const [repeatWeekly, setRepeatWeekly] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const book = useBookSeat();
  const cancel = useCancelBooking();
  const checkIn = useCheckIn();

  // A fresh dialog every time, so the previous seat's error never lingers.
  useEffect(() => {
    setError(null);
    setDone(null);
  }, [seat?.seatCode, date, slot]);

  if (!seat || !date) return null;

  const token = SEAT_STATUS_TOKENS[seat.status];
  const yours = seat.status === "your_booking" && seat.bookingId !== null;
  const bookable = seat.status === "available" || seat.status === "auto_released";

  const cutoffAt = slotDefinition ? cutoffFor(date, slotDefinition, cutoffMinutes) : null;
  const pastCutoff = cutoffAt !== null && now !== null && new Date(now) >= cutoffAt;

  const busy = book.isPending || cancel.isPending || checkIn.isPending;

  function fail(err: unknown) {
    const e = err as ApiError;
    setError({ message: e.message, code: e.code });
  }

  async function onBook() {
    setError(null);
    try {
      await book.mutateAsync({
        seatCode: seat!.seatCode,
        bookingDate: date!,
        slot,
      });

      /**
       * The repeat is set up AFTER the booking, not instead of it.
       *
       * Two separate facts: "I want this desk on Thursday" and "I want it every
       * Thursday". Making the second replace the first would mean a failed
       * series silently loses you the desk you were actually trying to book —
       * so the booking lands first and the repeat is a second, additive step.
       */
      let repeatNote = "";
      if (repeatWeekly && date) {
        const weekday = isoWeekdayOf(date);
        try {
          const res = await createSeries({
            seatCode: seat!.seatCode,
            slot,
            weekdays: [weekday],
            startsOn: date,
          });
          repeatNote =
            res.failed.length > 0
              ? ` It will repeat every ${WEEKDAY_NAMES[weekday]}, though ${res.failed.length} day${res.failed.length === 1 ? " was" : "s were"} already taken.`
              : ` It will repeat every ${WEEKDAY_NAMES[weekday]} as each new day opens.`;
        } catch (err) {
          repeatNote = ` The desk is booked, but the weekly repeat could not be set up: ${(err as ApiError).message}`;
        }
      }

      setDone(
        `${seat!.seatCode} is yours for the ${slotDefinition?.label.toLowerCase() ?? slot}.` +
          repeatNote,
      );
    } catch (err) {
      fail(err);
    }
  }

  async function onCancel() {
    setError(null);
    try {
      await cancel.mutateAsync({
        bookingId: seat!.bookingId!,
        expectedUpdatedAt: seat!.bookingUpdatedAt ?? undefined,
        bookingDate: date!,
        slot,
      });
      setDone(`${seat!.seatCode} has been released back to the floor.`);
    } catch (err) {
      fail(err);
    }
  }

  async function onCheckIn() {
    setError(null);
    try {
      const result = await checkIn.mutateAsync({
        bookingId: seat!.bookingId!,
        method: "app",
        bookingDate: date!,
        slot,
      });
      setDone(
        result.alreadyCheckedIn
          ? `You are already checked in to ${seat!.seatCode}.`
          : `Checked in to ${seat!.seatCode}.`,
      );
    } catch (err) {
      fail(err);
    }
  }

  const title = yours
    ? `Your desk — ${seat.seatCode}`
    : bookable
      ? `Book seat ${seat.seatCode}`
      : `Seat ${seat.seatCode}`;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={title} description={`Zone ${seat.zone}, bay ${seat.bay}`}>
        <dl className="mt-1 space-y-2 text-sm">
          <Row label="Seat">
            <SeatSwatchWithGlyph status={seat.status} code={seat.seatCode} />
          </Row>
          <Row label="Status">{token.label}</Row>
          <Row label="Date">
            <span className="tabular">{longDate(date)}</span>
          </Row>
          <Row label="Slot">
            <span className="tabular">
              {slotDefinition
                ? `${slotDefinition.label} · ${slotDefinition.start}–${slotDefinition.end}`
                : slot}
            </span>
          </Row>
          {seat.occupantName && !yours ? <Row label="Occupant">{seat.occupantName}</Row> : null}
        </dl>

        {seat.status === "auto_released" && !done ? (
          <StatusMessage tone="caution" className="mt-4">
            This desk came free late — it was released because nobody checked in.
          </StatusMessage>
        ) : null}

        {yours && pastCutoff && !done ? (
          <StatusMessage tone="neutral" className="mt-4">
            Changes closed at{" "}
            <span className="tabular">
              {cutoffAt ? formatInTimeZone(cutoffAt, TZ, "HH:mm") : ""}
            </span>
            , {cutoffMinutes} minutes before the slot started. You can still check in.
          </StatusMessage>
        ) : null}

        {error ? (
          <StatusMessage tone="danger" className="mt-4">
            {error.message}
          </StatusMessage>
        ) : null}
        {done ? (
          <StatusMessage tone="positive" className="mt-4">
            {done}
          </StatusMessage>
        ) : null}

        {!done && bookable && date ? (
          <div className="mt-4 border-t border-hairline pt-4">
            <Switch
              label={`Book this desk every ${WEEKDAY_NAMES[isoWeekdayOf(date)]}`}
              description="Each new day books itself as it comes into the five working-day window. If somebody takes the desk first on one of them you get an email about that day only."
              checked={repeatWeekly}
              onCheckedChange={setRepeatWeekly}
              disabled={busy}
            />
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {done ? "Done" : "Close"}
          </Button>

          {!done && yours ? (
            <>
              <Button variant="secondary" onClick={onCheckIn} disabled={busy}>
                {checkIn.isPending ? "Checking in…" : "Check in"}
              </Button>
              <Button variant="danger" onClick={onCancel} disabled={busy || pastCutoff}>
                {cancel.isPending ? "Cancelling…" : "Cancel booking"}
              </Button>
            </>
          ) : null}

          {!done && bookable ? (
            <Button variant="primary" onClick={onBook} disabled={busy}>
              {book.isPending ? "Booking…" : "Confirm booking"}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
