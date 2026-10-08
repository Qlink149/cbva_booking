"use client";

/**
 * Every booking write the client makes.
 *
 * One module, so the cache invalidation is written once. Two keys have to move
 * after any desk write — `["floor", date, slot]`, which the plan and the list
 * view read, and `["bookings","mine"]`, which My Bookings reads — and a write
 * that updates one but not the other leaves the user looking at two screens
 * that disagree.
 *
 * Note the keys are invalidated EXACTLY, never by prefix: `["floor","dates"]`
 * shares the "floor" prefix with the seat query, and a prefix invalidation
 * would refetch the date strip on every booking for no reason.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { FloorPlanPayload, FloorPlanSeat, SlotKey } from "@/components/floor-plan/types";

export interface ApiError extends Error {
  code?: string;
  status?: number;
  details?: unknown;
}

/**
 * Turns a failed response into an Error carrying the machine-readable code.
 *
 * The code is what the UI branches on: SEAT_TAKEN refreshes the map,
 * OCCUPANT_ALREADY_BOOKED shows the booking that is in the way, PAST_CUTOFF
 * disables the form. A message alone would force string matching.
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      details?: unknown;
    };
    const err = new Error(body.error ?? `Request failed with ${res.status}`) as ApiError;
    err.code = body.code;
    err.status = res.status;
    err.details = body.details;
    throw err;
  }
  return res.json() as Promise<T>;
}

export interface MyBookingRow {
  id: string;
  seatCode: string;
  bay: string;
  zone: string;
  bookingDate: string;
  slot: string;
  startsAt: string;
  endsAt: string;
  status: string;
  source: string;
  checkedInAt: string | null;
  checkInMethod: string | null;
  updatedAt: string;
  occupantUserId: string;
  occupantName: string;
  bookedByUserId: string;
  bookedByName: string;
  bookedForSomeoneElse: boolean;
}

export interface MyBookingsPayload {
  now: string;
  upcoming: MyBookingRow[];
  past: MyBookingRow[];
}

export const bookingKeys = {
  mine: ["bookings", "mine"] as const,
  floor: (date: string | null, slot: SlotKey) => ["floor", date, slot] as const,
};

export function useMyBookings() {
  return useQuery({
    queryKey: bookingKeys.mine,
    queryFn: () => request<MyBookingsPayload>("/api/bookings"),
    staleTime: 5_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return async (date: string | null, slot: SlotKey) => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: bookingKeys.mine }),
      qc.invalidateQueries({ queryKey: bookingKeys.floor(date, slot), exact: true }),
    ]);
  };
}

export interface CreateBookingVars {
  seatCode: string;
  bookingDate: string;
  slot: SlotKey;
}

/**
 * Book a desk, optimistically.
 *
 * The seat is painted as taken the instant the button is pressed, because the
 * plan is a map of 141 squares and the one that just changed has to be obvious.
 * On failure the previous snapshot is put back — which matters most in exactly
 * the case the optimism is wrong: somebody else got the desk first, and the map
 * must not be left showing it as yours.
 */
export function useBookSeat() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();

  return useMutation({
    mutationFn: (vars: CreateBookingVars) =>
      request<{ id: string; seatCode: string; updatedAt: string }>("/api/bookings", {
        method: "POST",
        body: JSON.stringify(vars),
      }),

    onMutate: async (vars) => {
      const key = bookingKeys.floor(vars.bookingDate, vars.slot);
      await qc.cancelQueries({ queryKey: key, exact: true });
      const previous = qc.getQueryData<FloorPlanPayload>(key);
      if (previous) {
        qc.setQueryData<FloorPlanPayload>(key, {
          ...previous,
          occupied: previous.occupied + 1,
          seats: previous.seats.map((s): FloorPlanSeat =>
            s.seatCode === vars.seatCode ? { ...s, status: "your_booking" } : s,
          ),
        });
      }
      return { previous, key };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(context.key, context.previous);
    },

    onSettled: (_data, _err, vars) => invalidate(vars.bookingDate, vars.slot),
  });
}

export interface EditBookingVars {
  bookingId: string;
  expectedUpdatedAt: string;
  seatCode: string;
  bookingDate: string;
  slot: SlotKey;
  /** The slot the booking is moving away from, so both views are invalidated. */
  previousDate: string;
  previousSlot: SlotKey;
}

export function useEditBooking() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ bookingId, previousDate: _d, previousSlot: _s, ...body }: EditBookingVars) =>
      request<{ id: string; updatedAt: string }>(`/api/bookings/${bookingId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    // An edit moves a booking between two slots, so both have to be refetched.
    // No optimistic update: the destination may be taken, and a plan that shows
    // the move landing and then undoes it reads as a glitch.
    onSettled: async (_data, _err, vars) => {
      await invalidate(vars.previousDate, vars.previousSlot);
      await invalidate(vars.bookingDate, vars.slot);
    },
  });
}

export interface CancelBookingVars {
  bookingId: string;
  expectedUpdatedAt?: string;
  bookingDate: string;
  slot: SlotKey;
}

export function useCancelBooking() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();

  return useMutation({
    mutationFn: ({ bookingId, expectedUpdatedAt }: CancelBookingVars) =>
      request<{ id: string; status: string }>(`/api/bookings/${bookingId}`, {
        method: "DELETE",
        body: JSON.stringify(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
      }),

    onMutate: async (vars) => {
      const key = bookingKeys.floor(vars.bookingDate, vars.slot);
      await qc.cancelQueries({ queryKey: key, exact: true });
      const previous = qc.getQueryData<FloorPlanPayload>(key);
      return { previous, key };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(context.key, context.previous);
    },
    onSettled: (_d, _e, vars) => invalidate(vars.bookingDate, vars.slot),
  });
}

export interface CheckInVars {
  bookingId?: string;
  seatCode?: string;
  method?: "qr" | "app";
  bookingDate?: string;
  slot?: SlotKey;
}

export function useCheckIn() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (vars: CheckInVars) =>
      request<{ id: string; seatCode: string; alreadyCheckedIn: boolean }>("/api/check-in", {
        method: "POST",
        body: JSON.stringify({
          bookingId: vars.bookingId,
          seatCode: vars.seatCode,
          method: vars.method ?? "app",
        }),
      }),
    onSettled: (_d, _e, vars) => invalidate(vars.bookingDate ?? null, vars.slot ?? "AM"),
  });
}
