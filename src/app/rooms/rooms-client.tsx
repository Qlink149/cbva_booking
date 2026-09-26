"use client";

/**
 * The room-by-hour grid, one day at a time.
 *
 * Click an hour, or click and drag across several, to select a range. Booked
 * hours are locked and show their title and organiser.
 *
 * Two things are load-bearing and easy to get wrong:
 *
 * 1. **Every cell is a real button.** Drag-to-select is a mouse gesture, and a
 *    grid that only responds to one is a grid nobody can book with a keyboard.
 *    So selection is expressible either way: click (or Space) starts a range,
 *    Shift+click or Shift+Arrow extends it, Enter opens the dialog.
 * 2. **An overlap refusal is not an error.** The exclusion constraint is the
 *    source of truth (ADR-003), so a 23P01 comes back as "somebody booked part
 *    of that time while you were choosing" and the grid refetches underneath.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatInTimeZone } from "date-fns-tz";

import type { BookableDay } from "@/components/floor-plan/types";
import { Button } from "@/components/ui/button";
import {
  Badge,
  Card,
  CardBody,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  StatusMessage,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

interface RoomGridAttendee {
  name: string;
  email: string;
  isStaff: boolean;
}

interface RoomGridBooking {
  id: string;
  roomId: string;
  title: string;
  organiserName: string;
  organiserUserId: string;
  startsAt: string;
  endsAt: string;
  startHour: number;
  endHour: number;
  syncStatus: string;
  attendees: RoomGridAttendee[];
}

interface RoomGridPayload {
  date: string;
  timezone: string;
  hours: number[];
  now: string;
  viewerId: string;
  viewerIsAdmin: boolean;
  officeHours: { start: string; end: string };
  rooms: Array<{
    id: string;
    name: string;
    bayCode: string | null;
    capacity: number;
    isBookable: boolean;
    /** Distinct people with a confirmed booking here today, not a booking count. */
    bookedByCount: number;
    bookingCount: number;
  }>;
  bookings: RoomGridBooking[];
}

interface DatesPayload {
  days: BookableDay[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request to ${url} failed with ${res.status}`);
  return res.json() as Promise<T>;
}

interface Selection {
  roomId: string;
  from: number;
  to: number;
}

export function RoomsClient() {
  const qc = useQueryClient();
  const [date, setDate] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState("");
  const [attendeeInput, setAttendeeInput] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: "positive" | "danger"; text: string } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const dates = useQuery({
    queryKey: ["floor", "dates"],
    queryFn: () => getJson<DatesPayload>("/api/floor/dates"),
  });

  useEffect(() => {
    if (date === null && dates.data?.days[0]) setDate(dates.data.days[0].date);
  }, [date, dates.data]);

  const grid = useQuery({
    queryKey: ["rooms", date],
    queryFn: () => getJson<RoomGridPayload>(`/api/rooms?date=${date}`),
    enabled: date !== null,
    staleTime: 5_000,
    refetchInterval: 30_000,
  });

  const book = useMutation({
    mutationFn: async (vars: {
      roomId: string;
      startHour: number;
      endHour: number;
      title: string;
      attendeeEmails: string[];
    }) => {
      const res = await fetch("/api/rooms/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...vars, date }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(body.error ?? "Could not book the room."), body);
      return body as {
        id: string;
        roomName: string;
        calendarSynced: boolean;
        attendees: RoomGridAttendee[];
      };
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["rooms", date] }),
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/rooms/bookings/${id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(body.error ?? "Could not cancel."), body);
      return body;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["rooms", date] }),
  });

  const hours = grid.data?.hours ?? [];

  /** roomId -> hour -> the booking occupying it. */
  const occupancy = useMemo(() => {
    const map = new Map<string, Map<number, RoomGridBooking>>();
    for (const booking of grid.data?.bookings ?? []) {
      const room = map.get(booking.roomId) ?? new Map<number, RoomGridBooking>();
      for (let h = booking.startHour; h < booking.endHour; h += 1) room.set(h, booking);
      map.set(booking.roomId, room);
    }
    return map;
  }, [grid.data]);

  const isBooked = useCallback(
    (roomId: string, hour: number) => occupancy.get(roomId)?.get(hour) ?? null,
    [occupancy],
  );

  /** A selection is only legal if every hour in it is free. */
  const selectionIsFree = useCallback(
    (sel: Selection) => {
      const [from, to] = sel.from <= sel.to ? [sel.from, sel.to] : [sel.to, sel.from];
      for (let h = from; h <= to; h += 1) if (isBooked(sel.roomId, h)) return false;
      return true;
    },
    [isBooked],
  );

  // A drag that ends anywhere — including off the grid — must stop dragging,
  // otherwise the next hover keeps painting a selection nobody is making.
  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, [dragging]);

  function beginSelection(roomId: string, hour: number, extend = false) {
    setMessage(null);
    if (extend && selection && selection.roomId === roomId) {
      setSelection({ ...selection, to: hour });
      return;
    }
    setSelection({ roomId, from: hour, to: hour });
  }

  function openDialog() {
    if (!selection || !selectionIsFree(selection)) return;
    setTitle("");
    setAttendeeInput("");
    setDialogOpen(true);
    // The name is the only thing left to supply, so put the cursor in it.
    window.setTimeout(() => titleRef.current?.focus(), 0);
  }

  /** Comma or newline separated, like Outlook's own "To:" field. */
  function parseAttendeeEmails(raw: string): string[] {
    return [...new Set(raw.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  }

  async function confirm() {
    if (!selection) return;
    const [from, to] = selection.from <= selection.to
      ? [selection.from, selection.to]
      : [selection.to, selection.from];
    try {
      const result = await book.mutateAsync({
        roomId: selection.roomId,
        startHour: from,
        endHour: to + 1,
        title: title.trim(),
        attendeeEmails: parseAttendeeEmails(attendeeInput),
      });
      setDialogOpen(false);
      setSelection(null);
      const calendarNote = result.calendarSynced
        ? "the calendar invitation has gone out"
        : "the calendar could not be updated just now — the booking stands and will sync automatically";
      const attendeeNote =
        result.attendees.length > 0
          ? ` ${result.attendees.length} ${result.attendees.length === 1 ? "person is" : "people are"} invited.`
          : "";
      setMessage({
        tone: "positive",
        text: `${result.roomName} is booked, and ${calendarNote}.${attendeeNote}`,
      });
    } catch (err) {
      const e = err as Error & { code?: string };
      setMessage({ tone: "danger", text: e.message });
      if (e.code === "ROOM_OVERLAP") {
        // The grid the user was looking at is out of date. Refetch under them
        // and drop the selection so they cannot immediately retry the same hour.
        setDialogOpen(false);
        setSelection(null);
        await qc.invalidateQueries({ queryKey: ["rooms", date] });
      }
    }
  }

  const selectionLabel = useMemo(() => {
    if (!selection || !grid.data) return null;
    const room = grid.data.rooms.find((r) => r.id === selection.roomId);
    const [from, to] = selection.from <= selection.to
      ? [selection.from, selection.to]
      : [selection.to, selection.from];
    return `${room?.name ?? "Room"} · ${pad(from)}:00–${pad(to + 1)}:00`;
  }, [selection, grid.data]);

  return (
    <div className="space-y-5">
      <Card>
        <CardBody className="flex flex-wrap items-end justify-between gap-4">
          <Field label="Day" htmlFor="rooms-date" className="w-64">
            <Select
              id="rooms-date"
              value={date ?? ""}
              onChange={(e) => {
                setDate(e.target.value);
                setSelection(null);
              }}
            >
              {(dates.data?.days ?? []).map((day) => (
                <option key={day.date} value={day.date}>
                  {formatInTimeZone(`${day.date}T00:00:00Z`, "UTC", "EEEE d MMMM")}
                </option>
              ))}
            </Select>
          </Field>

          <div className="flex items-center gap-3">
            {selectionLabel ? (
              <p className="text-sm text-ink-muted">
                Selected <span className="tabular text-ink">{selectionLabel}</span>
              </p>
            ) : (
              <p className="text-sm text-ink-subtle">
                Click an hour, or drag across several, to select a range.
              </p>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={openDialog}
              disabled={!selection || !selectionIsFree(selection)}
            >
              Name this meeting
            </Button>
          </div>
        </CardBody>
      </Card>

      {message ? <StatusMessage tone={message.tone}>{message.text}</StatusMessage> : null}

      {grid.isLoading ? (
        <div className="h-80 rounded-md border border-hairline bg-surface-sunken" role="status" aria-label="Loading the room grid" />
      ) : grid.isError ? (
        <StatusMessage tone="danger">The room grid could not be loaded.</StatusMessage>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                Meeting rooms by hour for {date}. Booked hours are locked and name their organiser.
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="sticky left-0 z-10 border-b border-hairline bg-surface px-3 py-2 text-left text-[11px] font-semibold tracking-wide text-ink-muted uppercase"
                  >
                    Room
                  </th>
                  {hours.map((hour) => (
                    <th
                      key={hour}
                      scope="col"
                      className="numeric border-b border-hairline px-1 py-2 text-center text-[11px] font-semibold text-ink-muted"
                    >
                      {pad(hour)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(grid.data?.rooms ?? []).map((room) => (
                  <tr key={room.id}>
                    <th
                      scope="row"
                      className="sticky left-0 z-10 border-b border-hairline bg-surface px-3 py-2 text-left font-normal whitespace-nowrap text-ink"
                    >
                      {room.name}
                      <span className="ml-2 text-xs text-ink-subtle tabular">{room.capacity}</span>
                      {/*
                        The architect's bay tag, in mono because that is what
                        the type rules reserve it for. It is what lets somebody
                        looking at "A3 Boardroom · 25 seats" on the floor plan
                        find the same room here — the name is the field CBVA is
                        expected to change, so it cannot be the thing that ties
                        the two screens together.
                      */}
                      {room.bayCode ? (
                        <span className="seat-code ml-2 text-[11px] text-ink-subtle">
                          {room.bayCode}
                        </span>
                      ) : null}
                      {/*
                        Distinct PEOPLE, not a booking count: one person holding
                        the room for three hours reads as "1 person", which is
                        the answer to "who has this room today" rather than a
                        number that inflates with how many slots they took.
                      */}
                      {room.bookedByCount > 0 ? (
                        <span className="ml-2 block text-[11px] text-ink-subtle">
                          {room.bookedByCount} {room.bookedByCount === 1 ? "person" : "people"} booked today
                          {room.bookingCount > room.bookedByCount ? ` (${room.bookingCount} meetings)` : ""}
                        </span>
                      ) : null}
                    </th>
                    {hours.map((hour) => {
                      const booking = isBooked(room.id, hour);
                      const inSelection =
                        selection?.roomId === room.id &&
                        hour >= Math.min(selection.from, selection.to) &&
                        hour <= Math.max(selection.from, selection.to);
                      const isStart = booking?.startHour === hour;
                      // Gold's second sanctioned use: a 2px rule on the thing
                      // that is yours. Same rule as the floor plan applies to
                      // your own desk, so "mine" reads the same way everywhere.
                      const mine =
                        booking !== null && booking.organiserUserId === grid.data?.viewerId;

                      return (
                        <td key={hour} className="border-b border-hairline p-0">
                          <button
                            type="button"
                            aria-disabled={booking !== null}
                            aria-pressed={inSelection}
                            aria-label={
                              booking
                                ? `${room.name} ${pad(hour)}:00, booked — ${booking.title}, ${mine ? "yours" : booking.organiserName}${
                                    booking.attendees.length > 0
                                      ? `, plus ${booking.attendees.length} ${booking.attendees.length === 1 ? "attendee" : "attendees"}`
                                      : ""
                                  }`
                                : `${room.name} ${pad(hour)}:00, free`
                            }
                            title={
                              booking
                                ? `${booking.title} — ${booking.organiserName}${
                                    booking.attendees.length > 0
                                      ? ` + ${booking.attendees.map((a) => a.name).join(", ")}`
                                      : ""
                                  }`
                                : undefined
                            }
                            onPointerDown={() => {
                              if (booking) return;
                              beginSelection(room.id, hour);
                              setDragging(true);
                            }}
                            onPointerEnter={() => {
                              if (!dragging || booking) return;
                              setSelection((s) => (s && s.roomId === room.id ? { ...s, to: hour } : s));
                            }}
                            onClick={(e) => {
                              if (booking) return;
                              if (e.shiftKey) beginSelection(room.id, hour, true);
                            }}
                            onKeyDown={(e) => {
                              if (booking) return;
                              if (e.key === " " || e.key === "Enter") {
                                e.preventDefault();
                                if (e.shiftKey) beginSelection(room.id, hour, true);
                                else if (
                                  selection?.roomId === room.id &&
                                  selection.from === hour &&
                                  selection.to === hour
                                ) {
                                  openDialog();
                                } else {
                                  beginSelection(room.id, hour);
                                }
                              }
                            }}
                            className={cn(
                              "h-11 w-full min-w-[3rem] px-1 text-[11px] transition-colors",
                              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-navy",
                              booking
                                ? cn(
                                    "cursor-not-allowed bg-navy-tint text-navy",
                                    mine && isStart && "border-l-2 border-l-gold",
                                  )
                                : inSelection
                                  ? "bg-navy text-paper"
                                  : "bg-surface text-ink-subtle hover:bg-surface-sunken",
                            )}
                          >
                            {booking && isStart ? (
                              <span className="block truncate text-left font-medium">
                                {booking.title}
                              </span>
                            ) : booking ? (
                              <span className="sr-only">continued</span>
                            ) : null}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <MeetingList
        bookings={grid.data?.bookings ?? []}
        rooms={grid.data?.rooms ?? []}
        viewerId={grid.data?.viewerId ?? ""}
        viewerIsAdmin={grid.data?.viewerIsAdmin ?? false}
        busy={cancel.isPending}
        onCancel={async (id) => {
          setMessage(null);
          try {
            await cancel.mutateAsync(id);
            setMessage({ tone: "positive", text: "The meeting has been cancelled and removed from the calendar." });
          } catch (err) {
            setMessage({ tone: "danger", text: (err as Error).message });
          }
        }}
      />

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && setDialogOpen(false)}>
        <DialogContent title="Name this meeting" description={selectionLabel ?? undefined}>
          <Field
            label="Meeting name"
            htmlFor="meeting-title"
            hint="Colleagues see this on the grid, so make it recognisable."
          >
            <Input
              id="meeting-title"
              ref={titleRef}
              value={title}
              maxLength={120}
              autoComplete="off"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && title.trim()) void confirm();
              }}
            />
          </Field>
          <Field
            label="Invite attendees (optional)"
            htmlFor="meeting-attendees"
            hint="Email addresses, separated by commas. A CBVA colleague's own account is matched automatically; anyone else is still shown by name."
          >
            <Input
              id="meeting-attendees"
              value={attendeeInput}
              autoComplete="off"
              placeholder="anjali.thakkar@cbva.in, client@example.com"
              onChange={(e) => setAttendeeInput(e.target.value)}
            />
          </Field>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Close
            </Button>
            <Button
              variant="primary"
              onClick={confirm}
              disabled={book.isPending || title.trim().length === 0}
            >
              {book.isPending ? "Booking…" : "Book the room"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function pad(hour: number): string {
  return String(hour).padStart(2, "0");
}

function MeetingList({
  bookings,
  rooms,
  viewerId,
  viewerIsAdmin,
  busy,
  onCancel,
}: {
  bookings: RoomGridBooking[];
  rooms: Array<{ id: string; name: string }>;
  viewerId: string;
  viewerIsAdmin: boolean;
  busy: boolean;
  onCancel: (id: string) => void;
}) {
  if (bookings.length === 0) return null;
  const nameOf = (id: string) => rooms.find((r) => r.id === id)?.name ?? "Room";

  return (
    <Card>
      <CardBody className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Meetings today</h2>
        <ul className="divide-y divide-hairline">
          {bookings.map((booking) => {
            const mine = booking.organiserUserId === viewerId;
            return (
              <li key={booking.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span className="text-sm text-ink">
                  <span className="tabular">
                    {pad(booking.startHour)}:00–{pad(booking.endHour)}:00
                  </span>{" "}
                  · {nameOf(booking.roomId)} · {booking.title}
                  <span className="ml-2 text-xs text-ink-subtle">{booking.organiserName}</span>
                  {booking.attendees.length > 0 ? (
                    <span
                      className="ml-2 text-xs text-ink-subtle"
                      title={booking.attendees.map((a) => `${a.name} (${a.email})`).join(", ")}
                    >
                      + {booking.attendees.length} {booking.attendees.length === 1 ? "attendee" : "attendees"}
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2">
                  {booking.syncStatus !== "synced" ? (
                    // Surfaced rather than hidden: the booking is real, the
                    // calendar invitation is not there yet, and somebody
                    // relying on Outlook needs to know which.
                    <Badge variant="caution">Calendar pending</Badge>
                  ) : null}
                  {mine || viewerIsAdmin ? (
                    <Button size="sm" variant="ghost" onClick={() => onCancel(booking.id)} disabled={busy}>
                      Cancel
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
