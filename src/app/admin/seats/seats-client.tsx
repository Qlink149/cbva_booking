"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";

import { ApiError, getJson, request } from "@/components/admin/api";
import { Button } from "@/components/ui/button";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Select,
  StatusMessage,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Stat, StatRow } from "@/components/ui/stat";

interface SeatRow {
  id: string;
  seatCode: string;
  bay: string;
  zone: string;
  seatType: string;
  status: string;
  assignedUserId: string | null;
  assignedName: string | null;
  upcomingBookings: number;
  upcomingReleases: number;
  activeFrom: string;
  activeTo: string | null;
}

interface Person {
  id: string;
  displayName: string;
  grade: string;
}

const STATUS_TONE: Record<string, "neutral" | "navy" | "caution" | "danger"> = {
  bookable: "navy",
  fixed: "neutral",
  blocked: "caution",
  decommissioned: "danger",
};

/**
 * Desk inventory.
 *
 * This screen is how ASSUMPTIONS A2 gets answered — which of the 158 desks are
 * allocated, and to whom — without anybody touching the seed. It is also where
 * A13's single blocked desk lives, and where a desk that really breaks gets
 * recorded so the floor plan stops lying about it.
 */
export function SeatsClient() {
  const qc = useQueryClient();
  const [q, setQ] = React.useState("");
  const [zone, setZone] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [notice, setNotice] = React.useState<{
    tone: "positive" | "danger" | "caution";
    text: string;
  } | null>(null);
  const [confirming, setConfirming] = React.useState<{
    seatCode: string;
    next: string;
    affected: number;
  } | null>(null);

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (zone) params.set("zone", zone);
  if (status !== "all") params.set("status", status);

  const seats = useQuery({
    queryKey: ["admin", "seats", params.toString()],
    queryFn: () => getJson<{ seats: SeatRow[]; today: string }>(`/api/admin/seats?${params}`),
  });

  const people = useQuery({
    queryKey: ["admin", "people-for-seats"],
    queryFn: () => getJson<{ users: Person[] }>("/api/admin/users?limit=500"),
  });

  const patch = useMutation({
    mutationFn: (vars: {
      seatCode: string;
      body: Record<string, unknown>;
    }) =>
      request(`/api/admin/seats/${vars.seatCode}`, {
        method: "PATCH",
        body: JSON.stringify(vars.body),
      }),
    onSuccess: (_d, vars) => {
      setNotice({ tone: "positive", text: `${vars.seatCode} updated.` });
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ["admin", "seats"] });
    },
    onError: (err: ApiError, vars) => {
      // The 409 carries the bookings that would be cancelled, which is exactly
      // the information needed to decide — so it becomes a confirmation rather
      // than a dead end. ADR-025.
      if (err.code === "SEAT_HAS_FUTURE_BOOKINGS") {
        const affected = (err.details as { affected?: unknown[] })?.affected?.length ?? 0;
        setConfirming({
          seatCode: vars.seatCode,
          next: String(vars.body.status ?? vars.body.assignedUserId ?? ""),
          affected,
        });
        setNotice({ tone: "caution", text: err.message });
        return;
      }
      setNotice({ tone: "danger", text: err.message });
    },
  });

  const rows = seats.data?.seats ?? [];
  const counts = rows.reduce<Record<string, number>>((a, s) => {
    a[s.status] = (a[s.status] ?? 0) + 1;
    return a;
  }, {});

  return (
    <div className="space-y-6">
      {notice ? <StatusMessage tone={notice.tone}>{notice.text}</StatusMessage> : null}

      {confirming ? (
        <StatusMessage tone="caution">
          <span className="block">
            {confirming.seatCode} has {confirming.affected} booking
            {confirming.affected === 1 ? "" : "s"} still to come. Confirming
            cancels {confirming.affected === 1 ? "it" : "them"} and emails
            everybody affected.
          </span>
          <span className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                patch.mutate({
                  seatCode: confirming.seatCode,
                  body: { status: confirming.next, force: true },
                })
              }
            >
              Cancel {confirming.affected} booking
              {confirming.affected === 1 ? "" : "s"} and continue
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Leave it
            </Button>
          </span>
        </StatusMessage>
      ) : null}

      <StatRow>
        <Stat label="Bookable" value={counts.bookable ?? 0} hint="The pool every occupancy figure is measured against." />
        <Stat label="Allocated" value={counts.fixed ?? 0} hint="Fixed desks. They enter the data only when their owner releases one." />
        <Stat label="Out of service" value={counts.blocked ?? 0} hint="Blocked. Excluded from capacity." />
        <Stat label="Retired" value={counts.decommissioned ?? 0} hint="No longer a desk on the floor." />
      </StatRow>

      <Card>
        <CardHeader className="flex flex-wrap items-end gap-3">
          <CardTitle className="me-auto">All desks</CardTitle>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-ink-subtle">Search</span>
            <Input
              className="w-36"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="37"
              aria-label="Search desks by code"
            />
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-ink-subtle">Zone</span>
            <Select className="w-28" value={zone} onChange={(e) => setZone(e.target.value)}>
              <option value="">All</option>
              {["A", "B", "C", "D"].map((z) => (
                <option key={z} value={z}>
                  Zone {z}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-ink-subtle">Status</span>
            <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="bookable">Bookable</option>
              <option value="fixed">Allocated</option>
              <option value="blocked">Out of service</option>
              <option value="decommissioned">Retired</option>
            </Select>
          </label>
          <Button asChild size="sm" variant="ghost">
            <Link href="/admin/floor-plan">Move desks on the plan</Link>
          </Button>
        </CardHeader>
        <CardBody>
          {seats.isPending ? (
            <TableSkeleton label="Loading desks" rows={8} />
          ) : rows.length === 0 ? (
            <EmptyState title="No desks match those filters">
              Clear the search or widen the status filter.
            </EmptyState>
          ) : (
            <Table className="rows-lazy">
              <thead>
                <tr>
                  <Th>Desk</Th>
                  <Th>Bay</Th>
                  <Th>Zone</Th>
                  <Th>Status</Th>
                  <Th>Allocated to</Th>
                  <Th numeric>Booked ahead</Th>
                  <Th>Change status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <Td className="seat-code font-medium">{s.seatCode}</Td>
                    <Td>{s.bay}</Td>
                    <Td>{s.zone}</Td>
                    <Td>
                      <Badge variant={STATUS_TONE[s.status] ?? "neutral"}>{s.status}</Badge>
                      {s.upcomingReleases > 0 ? (
                        <span className="ms-2 text-xs text-ink-subtle">
                          {s.upcomingReleases} released
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {/*
                        The current holder is always an option, even before the
                        staff list has loaded.

                        Without it a native select whose `value` matches no
                        option falls back to the first one — so every allocated
                        desk read "Nobody — in the pool" for the second or two
                        the people query takes. That is not a cosmetic flicker:
                        it is the exact opposite of the truth on a control whose
                        other states CLEAR an allocation, and an admin acting on
                        it during that window would unseat somebody.

                        Disabled until the list arrives, for the same reason.
                      */}
                      <Select
                        className="w-48"
                        aria-label={`Allocate ${s.seatCode} to`}
                        value={s.assignedUserId ?? ""}
                        disabled={people.isPending || patch.isPending}
                        onChange={(e) =>
                          patch.mutate({
                            seatCode: s.seatCode,
                            body: { assignedUserId: e.target.value || null },
                          })
                        }
                      >
                        <option value="">Nobody — in the pool</option>
                        {s.assignedUserId &&
                        !(people.data?.users ?? []).some((p) => p.id === s.assignedUserId) ? (
                          <option value={s.assignedUserId}>
                            {s.assignedName ?? "Currently allocated"}
                          </option>
                        ) : null}
                        {(people.data?.users ?? []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.displayName}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    <Td numeric>{s.upcomingBookings}</Td>
                    <Td>
                      <Select
                        className="w-40"
                        aria-label={`Status of ${s.seatCode}`}
                        value={s.status}
                        onChange={(e) =>
                          patch.mutate({
                            seatCode: s.seatCode,
                            body: { status: e.target.value },
                          })
                        }
                      >
                        <option value="bookable">Bookable</option>
                        <option value="fixed">Allocated</option>
                        <option value="blocked">Out of service</option>
                        <option value="decommissioned">Retired</option>
                      </Select>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
