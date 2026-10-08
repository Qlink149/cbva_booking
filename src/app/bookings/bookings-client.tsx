"use client";

/**
 * My Bookings.
 *
 * Upcoming and past, grouped by date. The grouping is not decoration: a booking
 * is a half day, so a full day in the office is two rows, and a flat list makes
 * that read as two unrelated things rather than one day at a desk.
 *
 * "Mine" means bookings I sit in AND bookings I made for somebody else. A
 * manager who seats their team has to be able to find those to unbook them;
 * filtering on occupant alone would strand them.
 */
import { useMemo, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";

import { useClock } from "@/components/app-shell/session";
import { MyDeskPanel } from "@/components/booking/my-desk-panel";
import { EditBookingDialog } from "@/components/booking/edit-booking-dialog";
import {
  useCancelBooking,
  useCheckIn,
  useMyBookings,
  type ApiError,
  type MyBookingRow,
} from "@/components/booking/use-bookings";
import { SeatSwatchWithGlyph } from "@/components/seat/seat-swatch";
import type { SeatVisualStatus } from "@/components/seat/seat-status";
import { Button } from "@/components/ui/button";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  StatusMessage,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/primitives";
import type { SlotDefinition } from "@/lib/slots";

const TZ = "Asia/Kolkata";

/** How a booking status reads on a card, and which badge it earns. */
const STATUS_PRESENTATION: Record<
  string,
  { label: string; variant: "neutral" | "navy" | "positive" | "caution" | "danger" }
> = {
  confirmed: { label: "Booked", variant: "navy" },
  checked_in: { label: "Checked in", variant: "positive" },
  completed: { label: "Attended", variant: "neutral" },
  completed_no_show: { label: "No show", variant: "caution" },
  auto_released: { label: "Released — no check-in", variant: "caution" },
  cancelled_by_user: { label: "Cancelled", variant: "neutral" },
  cancelled_after_check_in: { label: "Left early", variant: "neutral" },
  cancelled_by_admin: { label: "Cancelled by the office", variant: "danger" },
};

/** The seat swatch a row draws, from the one vocabulary (ADR-010). */
function swatchStatus(row: MyBookingRow): SeatVisualStatus {
  if (row.status === "checked_in") return "checked_in";
  if (row.status === "auto_released") return "auto_released";
  if (row.status === "confirmed" || row.status === "completed") return "your_booking";
  return "available";
}

function groupByDate(rows: MyBookingRow[]): Array<[string, MyBookingRow[]]> {
  const groups = new Map<string, MyBookingRow[]>();
  for (const row of rows) {
    const list = groups.get(row.bookingDate) ?? [];
    list.push(row);
    groups.set(row.bookingDate, list);
  }
  return [...groups.entries()];
}

export function BookingsClient({
  fixedSeatCode,
  slots,
  cutoffMinutes,
}: {
  /** The desk allocated to the viewer, when they hold one. Null otherwise. */
  fixedSeatCode: string | null;
  slots: SlotDefinition[];
  cutoffMinutes: number;
}) {
  const bookings = useMyBookings();
  const clock = useClock();
  const cancel = useCancelBooking();
  const checkIn = useCheckIn();

  const [editing, setEditing] = useState<MyBookingRow | null>(null);
  const [message, setMessage] = useState<{ tone: "positive" | "danger"; text: string } | null>(null);

  const now = clock.data ? new Date(clock.data.now) : null;

  const upcoming = useMemo(() => groupByDate(bookings.data?.upcoming ?? []), [bookings.data]);
  const past = useMemo(() => groupByDate(bookings.data?.past ?? []), [bookings.data]);

  async function onCancel(row: MyBookingRow) {
    setMessage(null);
    try {
      await cancel.mutateAsync({
        bookingId: row.id,
        expectedUpdatedAt: row.updatedAt,
        bookingDate: row.bookingDate,
        slot: row.slot,
      });
      setMessage({
        tone: "positive",
        text: `${row.seatCode} on ${longDate(row.bookingDate)} has been released back to the floor.`,
      });
    } catch (err) {
      setMessage({ tone: "danger", text: (err as ApiError).message });
    }
  }

  async function onCheckIn(row: MyBookingRow) {
    setMessage(null);
    try {
      const result = await checkIn.mutateAsync({
        bookingId: row.id,
        method: "app",
        bookingDate: row.bookingDate,
        slot: row.slot,
      });
      setMessage({
        tone: "positive",
        text: result.alreadyCheckedIn
          ? `You were already checked in to ${row.seatCode}.`
          : `Checked in to ${row.seatCode}.`,
      });
    } catch (err) {
      setMessage({ tone: "danger", text: (err as ApiError).message });
    }
  }

  if (bookings.isLoading) {
    return <div className="h-64 rounded-md border border-hairline bg-surface-sunken" role="status" aria-label="Loading your bookings" />;
  }

  if (bookings.isError) {
    return (
      <StatusMessage tone="danger">
        Your bookings could not be loaded. {String(bookings.error)}
      </StatusMessage>
    );
  }

  return (
    <div className="space-y-5">
      {message ? <StatusMessage tone={message.tone}>{message.text}</StatusMessage> : null}

      <Tabs defaultValue="upcoming">
        <TabsList>
          <TabsTrigger value="upcoming">
            Upcoming
            <span className="ml-2 text-xs text-ink-subtle tabular">
              {bookings.data?.upcoming.length ?? 0}
            </span>
          </TabsTrigger>
          <TabsTrigger value="past">Past</TabsTrigger>
          <TabsTrigger value="desk">
            My desk
            {/* The two adoption features live behind their own tab rather than
                stacked under the booking list: they are settings about how you
                use the floor, not things you did today. */}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="upcoming" className="mt-5 space-y-6">
          {upcoming.length === 0 ? (
            <EmptyState title="No desks booked">
              Book one from the floor plan — the next five working days are open.
            </EmptyState>
          ) : (
            upcoming.map(([date, rows]) => (
              <DateGroup key={date} date={date}>
                {rows.map((row) => (
                  <BookingRow
                    key={row.id}
                    row={row}
                    slots={slots}
                    now={now}
                    cutoffMinutes={cutoffMinutes}
                    busy={cancel.isPending || checkIn.isPending}
                    onEdit={() => setEditing(row)}
                    onCancel={() => onCancel(row)}
                    onCheckIn={() => onCheckIn(row)}
                  />
                ))}
              </DateGroup>
            ))
          )}
        </TabsContent>

        <TabsContent value="past" className="mt-5 space-y-6">
          {past.length === 0 ? (
            <EmptyState title="Nothing here yet" />
          ) : (
            past.map(([date, rows]) => (
              <DateGroup key={date} date={date}>
                {rows.map((row) => (
                  <BookingRow key={row.id} row={row} slots={slots} now={now} cutoffMinutes={cutoffMinutes} readOnly />
                ))}
              </DateGroup>
            ))
          )}
        </TabsContent>

        <TabsContent value="desk" className="mt-5">
          <MyDeskPanel fixedSeatCode={fixedSeatCode} />
        </TabsContent>
      </Tabs>

      <EditBookingDialog
        booking={editing}
        slots={slots}
        onClose={() => setEditing(null)}
        onDone={(text) => {
          setEditing(null);
          setMessage({ tone: "positive", text });
        }}
      />
    </div>
  );
}

function longDate(date: string): string {
  return formatInTimeZone(`${date}T00:00:00Z`, "UTC", "EEEE d MMMM yyyy");
}

function DateGroup({ date, children }: { date: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-title text-base text-ink">{longDate(date)}</h2>
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}

function BookingRow({
  row,
  slots,
  now,
  cutoffMinutes,
  busy,
  readOnly,
  onEdit,
  onCancel,
  onCheckIn,
}: {
  row: MyBookingRow;
  slots: SlotDefinition[];
  now: Date | null;
  cutoffMinutes: number;
  busy?: boolean;
  readOnly?: boolean;
  onEdit?: () => void;
  onCancel?: () => void;
  onCheckIn?: () => void;
}) {
  const slot = slots.find((s) => s.key === row.slot);
  const presentation = STATUS_PRESENTATION[row.status] ?? {
    label: row.status,
    variant: "neutral" as const,
  };

  const startsAt = new Date(row.startsAt);
  const cutoffAt = new Date(startsAt.getTime() - cutoffMinutes * 60_000);
  const pastCutoff = now !== null && now >= cutoffAt;
  const checkedIn = row.status === "checked_in";
  const active = row.status === "confirmed" || checkedIn;

  // Editing is always closed past the cut-off. Cancelling is not, once somebody
  // has checked in — releasing a desk you are leaving gives the rest of the
  // slot back to the floor, which is what the product wants.
  const canEdit = active && !pastCutoff;
  const canCancel = active && (!pastCutoff || checkedIn);
  const canCheckIn =
    row.status === "confirmed" && now !== null && now >= new Date(startsAt.getTime() - 30 * 60_000) && now < new Date(row.endsAt);

  return (
    <Card>
      <CardBody className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-center gap-4">
          <SeatSwatchWithGlyph status={swatchStatus(row)} code={row.seatCode} />
          <div className="min-w-0">
            <p className="text-sm text-ink">
              <span className="tabular">
                {slot ? `${slot.label} · ${slot.start}–${slot.end}` : row.slot}
              </span>
              <span className="text-ink-subtle"> · Zone {row.zone}, bay {row.bay}</span>
            </p>
            <p className="mt-0.5 text-xs text-ink-subtle">
              {row.bookedForSomeoneElse
                ? `Booked by you for ${row.occupantName}`
                : row.bookedByUserId !== row.occupantUserId
                  ? `Booked for you by ${row.bookedByName}`
                  : "Booked by you"}
              {row.checkedInAt
                ? ` · checked in ${formatInTimeZone(new Date(row.checkedInAt), TZ, "HH:mm")}${
                    row.checkInMethod === "qr" ? " by QR" : row.checkInMethod === "badge" ? " by badge" : ""
                  }`
                : ""}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant={presentation.variant}>{presentation.label}</Badge>
          {readOnly ? null : (
            <>
              {canCheckIn ? (
                <Button size="sm" variant="secondary" onClick={onCheckIn} disabled={busy}>
                  Check in
                </Button>
              ) : null}
              {/* Only the person booked into a desk can move it; a historical
                  booking made for somebody else can still be cancelled. */}
              {row.bookedForSomeoneElse ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onEdit}
                  disabled={busy || !canEdit}
                  title={canEdit ? undefined : cutoffExplanation(cutoffAt, cutoffMinutes)}
                >
                  Edit
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={onCancel}
                disabled={busy || !canCancel}
                title={canCancel ? undefined : cutoffExplanation(cutoffAt, cutoffMinutes)}
              >
                Cancel
              </Button>
            </>
          )}
        </div>

        {!readOnly && active && pastCutoff ? (
          // Spelled out rather than left as a disabled button somebody has to
          // guess at. The cut-off is a settings value nobody has memorised.
          <p className="w-full text-xs text-ink-subtle">
            {checkedIn
              ? `Changes closed at ${formatInTimeZone(cutoffAt, TZ, "HH:mm")}. You can still release the desk if you are leaving.`
              : cutoffExplanation(cutoffAt, cutoffMinutes)}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function cutoffExplanation(cutoffAt: Date, cutoffMinutes: number): string {
  return `Changes closed at ${formatInTimeZone(cutoffAt, TZ, "HH:mm 'on' EEEE d MMMM")} — ${cutoffMinutes} minutes before the slot started.`;
}
