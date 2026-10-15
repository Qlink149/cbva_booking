"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState, Table, Td, Th } from "@/components/ui/primitives";
import { SeatSwatchWithGlyph } from "@/components/seat/seat-swatch";
import {
  SEAT_STATUSES,
  SEAT_STATUS_TOKENS,
  type SeatVisualStatus,
} from "@/components/seat/seat-status";
import type { FloorPlanSeat } from "@/components/floor-plan/types";

/**
 * The same seats as a filterable table.
 *
 * This is not a consolation prize for screen reader users. A plan is a poor
 * tool for "show me every free desk in Zone D" and some people will always
 * prefer a list, so it carries the same information and the same actions.
 */
export function ListView({
  seats,
  onActivateSeat,
}: {
  seats: FloorPlanSeat[];
  onActivateSeat: (seat: FloorPlanSeat) => void;
}) {
  const [zone, setZone] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [query, setQuery] = useState("");

  const zones = useMemo(
    () => Array.from(new Set(seats.map((s) => s.zone))).sort(),
    [seats],
  );
  const statuses = useMemo(
    () => SEAT_STATUSES.filter((s) => seats.some((seat) => seat.status === s)),
    [seats],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return seats.filter(
      (s) =>
        (zone === "all" || s.zone === zone) &&
        (status === "all" || s.status === status) &&
        (q === "" ||
          s.seatCode.toLowerCase().includes(q) ||
          s.bay.toLowerCase().includes(q) ||
          (s.occupantName ?? "").toLowerCase().includes(q)),
    );
  }, [seats, zone, status, query]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="list-zone" className="mb-1 block text-xs text-ink-muted">
            Zone
          </label>
          <select
            id="list-zone"
            name="list-zone"
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            className="h-9 rounded-sm border border-hairline bg-surface px-2 text-sm"
          >
            <option value="all">All zones</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                Zone {z}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="list-status" className="mb-1 block text-xs text-ink-muted">
            Status
          </label>
          <select
            id="list-status"
            name="list-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-9 rounded-sm border border-hairline bg-surface px-2 text-sm"
          >
            <option value="all">Any status</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {SEAT_STATUS_TOKENS[s].label}
              </option>
            ))}
          </select>
        </div>
        <div className="grow">
          <label htmlFor="list-search" className="mb-1 block text-xs text-ink-muted">
            Search seat, bay or person
          </label>
          <input
            id="list-search"
            name="seat-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // Seat codes are not words. Autocorrect and spellcheck fight the
            // user over "37" and "S".
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="37, S, Anand…"
            className="h-9 w-full rounded-sm border border-hairline bg-surface px-2 text-sm"
          />
        </div>
      </div>

      <p role="status" aria-live="polite" className="mb-2 text-xs text-ink-muted">
        {rows.length} of {seats.length} seats
      </p>

      {rows.length === 0 ? (
        <EmptyState title="No seats match those filters">
          Widen the zone or status filter, or clear the search.
        </EmptyState>
      ) : (
        <Table>
          <caption className="sr-only">
            Every seat on Floor 4 for the selected date and slot
          </caption>
          <thead>
            <tr>
              <Th scope="col">Seat</Th>
              <Th scope="col">Zone</Th>
              <Th scope="col">Bay</Th>
              <Th scope="col">Status</Th>
              <Th scope="col">Occupant</Th>
              <Th scope="col">
                <span className="sr-only">Action</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((seat) => {
              const token = SEAT_STATUS_TOKENS[seat.status as SeatVisualStatus];
              return (
                <tr key={seat.seatCode}>
                  <Td>
                    <span className="seat-code text-xs">{seat.seatCode}</span>
                  </Td>
                  <Td>{seat.zone}</Td>
                  <Td>{seat.bay}</Td>
                  <Td>
                    <SeatSwatchWithGlyph status={seat.status} code={token.label} />
                  </Td>
                  <Td>{seat.occupantName ?? "—"}</Td>
                  <Td>
                    {token.interactive ? (
                      <Button size="sm" variant="secondary" onClick={() => onActivateSeat(seat)}>
                        Book
                      </Button>
                    ) : (
                      <span className="text-xs text-ink-subtle">Not bookable</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
