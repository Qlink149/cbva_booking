"use client";

/**
 * Change a booking's date, slot or desk.
 *
 * The user sees one action. Underneath it is a cancel-and-rebook inside a
 * single transaction (see editBooking), which is what keeps `seat_slot_unique`
 * protecting them: if the desk they are moving to is taken between opening this
 * dialog and pressing Save, the whole thing rolls back and they still have the
 * desk they started with.
 *
 * The desk list is the live floor for the chosen date and slot, so it cannot
 * offer a desk that is already taken — but it does not rely on that. The
 * refusal comes from the database.
 */
import { compareSeatCodes } from "@/lib/seat-code";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatInTimeZone } from "date-fns-tz";

import { useEditBooking, type ApiError, type MyBookingRow } from "@/components/booking/use-bookings";
import type { BookableDay, FloorPlanPayload } from "@/components/floor-plan/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  Field,
  Select,
  StatusMessage,
} from "@/components/ui/primitives";
import type { SlotDefinition } from "@/lib/slots";

interface DatesPayload {
  days: BookableDay[];
  slots: SlotDefinition[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request to ${url} failed with ${res.status}`);
  return res.json() as Promise<T>;
}

export function EditBookingDialog({
  booking,
  slots,
  onClose,
  onDone,
}: {
  booking: MyBookingRow | null;
  slots: SlotDefinition[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [date, setDate] = useState<string>("");
  const [slot, setSlot] = useState<string>("");
  const [seatCode, setSeatCode] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const edit = useEditBooking();

  // Reset to the booking as it stands whenever a different one is opened.
  useEffect(() => {
    if (!booking) return;
    setDate(booking.bookingDate);
    setSlot(booking.slot);
    setSeatCode(booking.seatCode);
    setError(null);
  }, [booking]);

  const dates = useQuery({
    queryKey: ["floor", "dates"],
    queryFn: () => getJson<DatesPayload>("/api/floor/dates"),
    enabled: booking !== null,
  });

  const floor = useQuery({
    queryKey: ["floor", date, slot],
    queryFn: () => getJson<FloorPlanPayload>(`/api/floor?date=${date}&slot=${slot}`),
    enabled: booking !== null && date !== "" && slot !== "",
    staleTime: 5_000,
  });

  /**
   * Desks this booking could move to: anything free, plus the one it already
   * has — which reads as taken on the plan precisely because this booking has
   * it, and would otherwise vanish from its own edit dialog.
   */
  const options = useMemo(() => {
    const seats = floor.data?.seats ?? [];
    const free = seats.filter(
      (s) => s.status === "available" || s.status === "auto_released" || s.seatCode === booking?.seatCode,
    );
    return free.sort((a, b) => compareSeatCodes(a.seatCode, b.seatCode));
  }, [floor.data, booking?.seatCode]);

  if (!booking) return null;

  const unchanged =
    date === booking.bookingDate && slot === booking.slot && seatCode === booking.seatCode;

  async function onSave() {
    setError(null);
    try {
      await edit.mutateAsync({
        bookingId: booking!.id,
        expectedUpdatedAt: booking!.updatedAt,
        seatCode,
        bookingDate: date,
        slot,
        previousDate: booking!.bookingDate,
        previousSlot: booking!.slot,
      });
      onDone(
        `Moved to ${seatCode} on ${formatInTimeZone(`${date}T00:00:00Z`, "UTC", "EEEE d MMMM")}.`,
      );
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Change this booking"
        description={`Currently ${booking.seatCode} on ${formatInTimeZone(
          `${booking.bookingDate}T00:00:00Z`,
          "UTC",
          "EEEE d MMMM",
        )}`}
      >
        <div className="space-y-4">
          <Field label="Date" htmlFor="edit-date">
            <Select id="edit-date" value={date} onChange={(e) => setDate(e.target.value)}>
              {(dates.data?.days ?? []).map((day) => (
                <option key={day.date} value={day.date}>
                  {formatInTimeZone(`${day.date}T00:00:00Z`, "UTC", "EEEE d MMMM")}
                </option>
              ))}
              {/* Keep the current date selectable even when it has dropped out
                  of the window — otherwise the select silently shows the wrong
                  day and Save moves the booking somewhere nobody asked for. */}
              {(dates.data?.days ?? []).some((d) => d.date === booking.bookingDate) ? null : (
                <option value={booking.bookingDate}>
                  {formatInTimeZone(`${booking.bookingDate}T00:00:00Z`, "UTC", "EEEE d MMMM")}
                </option>
              )}
            </Select>
          </Field>

          <Field label="Slot" htmlFor="edit-slot">
            <Select id="edit-slot" value={slot} onChange={(e) => setSlot(e.target.value)}>
              {slots.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label} · {s.start}–{s.end}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Desk"
            htmlFor="edit-seat"
            hint={
              floor.isFetching
                ? "Checking which desks are free…"
                : `${options.length} desk${options.length === 1 ? "" : "s"} available for this slot`
            }
          >
            <Select
              id="edit-seat"
              value={seatCode}
              onChange={(e) => setSeatCode(e.target.value)}
              disabled={floor.isLoading}
            >
              {options.map((seat) => (
                <option key={seat.seatCode} value={seat.seatCode}>
                  {seat.seatCode} — Zone {seat.zone}, bay {seat.bay}
                  {seat.seatCode === booking.seatCode ? " (current)" : ""}
                </option>
              ))}
            </Select>
          </Field>

          {error ? <StatusMessage tone="danger">{error}</StatusMessage> : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={onSave} disabled={edit.isPending || unchanged}>
            {edit.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
