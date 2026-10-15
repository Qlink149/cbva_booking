"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Magnet, Redo2, RotateCw, Save, Undo2 } from "lucide-react";

import { FloorPlan } from "@/components/floor-plan/floor-plan";
import { ZoneFilter } from "@/components/floor-plan/controls";
import type { FloorPlanPayload, FloorPlanSeat, SlotKey } from "@/components/floor-plan/types";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "@/components/ui/primitives";
import { nearestDetectedModule } from "@/lib/floorplan";
import type { ZoneCode } from "@/lib/floorplan";
import type { SeatDbStatus } from "@/lib/seat-visual-status";

interface Geometry {
  planX: number;
  planY: number;
  rotationDeg: number;
  status: SeatDbStatus;
}

/** One undoable change. Both halves are stored so redo is symmetric. */
interface Edit {
  seatCode: string;
  before: Geometry;
  after: Geometry;
}

const SEAT_STATUS_OPTIONS: SeatDbStatus[] = [
  "bookable",
  "fixed",
  "blocked",
  "decommissioned",
];

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request to ${url} failed with ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * The seat position editor.
 *
 * This exists because automatic detection is an inference (under R007 it got
 * 130 of 141 desks; under R009 every desk is numbered and snaps onto its own
 * chair block) and will never
 * get all of them, and because furniture moves. Fifteen minutes of dragging
 * turns a 92% floor into a correct one, and CBVA needs the same tool the first
 * time a bay is reconfigured.
 *
 * It renders through the same <FloorPlan> component as /floor rather than a
 * second, drifting copy — the only difference is that it passes onDragSeat.
 */
export function FloorPlanEditor({ date, slot }: { date: string; slot: SlotKey }) {
  const [overrides, setOverrides] = useState<Record<string, Geometry>>({});
  const [undoStack, setUndoStack] = useState<Edit[]>([]);
  const [redoStack, setRedoStack] = useState<Edit[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [zone, setZone] = useState<ZoneCode | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dragStart = useRef<Geometry | null>(null);

  const floor = useQuery({
    queryKey: ["floor", date, slot],
    queryFn: () => getJson<FloorPlanPayload>(`/api/floor?date=${date}&slot=${slot}`),
    staleTime: Infinity,
  });

  const seats = useMemo(() => {
    const base = floor.data?.seats ?? [];
    const list = base.map((seat) => {
      const o = overrides[seat.seatCode];
      return o
        ? {
            ...seat,
            planX: o.planX,
            planY: o.planY,
            rotationDeg: o.rotationDeg,
            seatStatus: o.status,
            anchorSource: "manual" as const,
          }
        : seat;
    });
    return zone === null ? list : list.filter((s) => s.zone === zone);
  }, [floor.data, overrides, zone]);

  const seatByCode = useMemo(
    () => new Map(seats.map((s) => [s.seatCode, s] as const)),
    [seats],
  );
  const current = selected ? seatByCode.get(selected) : undefined;

  const geometryOf = useCallback(
    (seat: FloorPlanSeat): Geometry => ({
      planX: seat.planX,
      planY: seat.planY,
      rotationDeg: seat.rotationDeg,
      status: seat.seatStatus,
    }),
    [],
  );

  /** Apply without recording history — used by drag, which records on release. */
  const applyLive = useCallback((seatCode: string, next: Geometry) => {
    setOverrides((o) => ({ ...o, [seatCode]: next }));
  }, []);

  const commit = useCallback((edit: Edit) => {
    setOverrides((o) => ({ ...o, [edit.seatCode]: edit.after }));
    setUndoStack((s) => [...s.slice(-49), edit]);
    setRedoStack([]);
  }, []);

  const onDragSeat = useCallback(
    (seatCode: string, planX: number, planY: number) => {
      const seat = seatByCode.get(seatCode);
      if (!seat) return;
      if (dragStart.current === null) {
        dragStart.current = geometryOf(seat);
        setSelected(seatCode);
      }
      applyLive(seatCode, { ...geometryOf(seat), planX, planY });
    },
    [applyLive, geometryOf, seatByCode],
  );

  // A drag is one undo step, not one per pointermove.
  useEffect(() => {
    const end = () => {
      const start = dragStart.current;
      dragStart.current = null;
      if (!start || !selected) return;
      const seat = seatByCode.get(selected);
      if (!seat) return;
      const after = geometryOf(seat);
      if (start.planX === after.planX && start.planY === after.planY) return;
      setUndoStack((s) => [...s.slice(-49), { seatCode: selected, before: start, after }]);
      setRedoStack([]);
    };
    window.addEventListener("pointerup", end);
    return () => window.removeEventListener("pointerup", end);
  }, [geometryOf, seatByCode, selected]);

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      const edit = stack[stack.length - 1];
      if (!edit) return stack;
      setOverrides((o) => ({ ...o, [edit.seatCode]: edit.before }));
      setRedoStack((r) => [...r, edit]);
      return stack.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setRedoStack((stack) => {
      const edit = stack[stack.length - 1];
      if (!edit) return stack;
      setOverrides((o) => ({ ...o, [edit.seatCode]: edit.after }));
      setUndoStack((u) => [...u, edit]);
      return stack.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [redo, undo]);

  const change = useCallback(
    (patch: Partial<Geometry>) => {
      if (!current) return;
      const before = geometryOf(current);
      commit({ seatCode: current.seatCode, before, after: { ...before, ...patch } });
    },
    [commit, current, geometryOf],
  );

  const snap = useCallback(() => {
    if (!current) return;
    // Searches every chair block the extraction found, including the ones no
    // seat was assigned to — which is exactly where detection went wrong.
    const nearest = nearestDetectedModule(current.planX, current.planY, 60);
    if (!nearest) {
      setMessage(`No detected workstation within 60 units of ${current.seatCode}.`);
      return;
    }
    const before = geometryOf(current);
    commit({
      seatCode: current.seatCode,
      before,
      after: {
        ...before,
        planX: nearest.x,
        planY: nearest.y,
        rotationDeg: nearest.rotationDeg,
      },
    });
    setMessage(`${current.seatCode} snapped ${nearest.distance.toFixed(1)} units.`);
  }, [commit, current, geometryOf]);

  const save = useCallback(async () => {
    const entries = Object.entries(overrides);
    if (entries.length === 0) return;
    setSaving(true);
    setMessage(null);
    try {
      for (const [seatCode, g] of entries) {
        const res = await fetch(`/api/admin/seats/${seatCode}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            planX: g.planX,
            planY: g.planY,
            rotationDeg: Math.round(g.rotationDeg) % 360,
            status: g.status,
          }),
        });
        if (!res.ok) throw new Error(`${seatCode}: ${res.status}`);
      }
      const exported = await fetch("/api/admin/floor-plan/export", { method: "POST" });
      const body = (await exported.json()) as { manual?: number; error?: string };
      if (!exported.ok) throw new Error(body.error ?? "export failed");
      setMessage(
        `Saved ${entries.length} seat${entries.length === 1 ? "" : "s"} and exported ` +
          `seats.json (${body.manual ?? 0} now marked manual). Re-seeding will keep these positions.`,
      );
      setOverrides({});
      setUndoStack([]);
      setRedoStack([]);
      await floor.refetch();
    } catch (err) {
      setMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [floor, overrides]);

  const interpolated = seats.filter((s) => s.anchorSource === "interpolated");
  const dirty = Object.keys(overrides).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ZoneFilter active={zone} onChange={setZone} />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={undo}
            disabled={undoStack.length === 0}
          >
            <Undo2 aria-hidden="true" />
            Undo
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={redo}
            disabled={redoStack.length === 0}
          >
            <Redo2 aria-hidden="true" />
            Redo
          </Button>
          <Button size="sm" variant="primary" onClick={save} disabled={dirty === 0 || saving}>
            <Save aria-hidden="true" />
            {saving ? "Saving…" : `Save ${dirty || ""}`.trim()}
          </Button>
        </div>
      </div>

      {message ? (
        <p role="status" aria-live="polite" className="text-xs text-ink-muted">
          {message}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        {floor.isLoading ? (
          <div
            className="h-[clamp(24rem,64vh,46rem)] rounded-md border border-hairline bg-surface-sunken"
            role="status"
            aria-label="Loading the floor plan"
          />
        ) : (
          <FloorPlan
            seats={seats}
            mode="2d"
            activeZone={zone}
            focusedSeatCode={selected}
            onFocusSeat={(code) => code && setSelected(code)}
            onActivateSeat={(seat) => setSelected(seat.seatCode)}
            onDragSeat={onDragSeat}
            className="h-[clamp(24rem,64vh,46rem)] w-full"
          />
        )}

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{current ? current.seatCode : "No seat selected"}</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              {current ? (
                <>
                  <p className="text-xs text-ink-muted">
                    Zone {current.zone} · Bay {current.bay}
                  </p>
                  <p className="text-xs">
                    Position{" "}
                    <span className="tabular">
                      {current.planX.toFixed(1)}, {current.planY.toFixed(1)}
                    </span>
                  </p>

                  <div>
                    <label
                      htmlFor="seat-rotation"
                      className="mb-1 block text-xs text-ink-muted"
                    >
                      Rotation
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="seat-rotation"
                        name="seat-rotation"
                        autoComplete="off"
                        type="number"
                        min={0}
                        max={359}
                        step={15}
                        value={Math.round(current.rotationDeg)}
                        onChange={(e) =>
                          change({
                            rotationDeg:
                              ((Number(e.target.value) % 360) + 360) % 360,
                          })
                        }
                        className="tabular h-9 w-24 rounded-sm border border-hairline bg-surface px-2 text-sm"
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          change({ rotationDeg: (current.rotationDeg + 15) % 360 })
                        }
                      >
                        <RotateCw aria-hidden="true" />
                        15°
                      </Button>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="seat-status" className="mb-1 block text-xs text-ink-muted">
                      Seat status
                    </label>
                    <select
                      id="seat-status"
                      name="seat-status"
                      value={current.seatStatus}
                      onChange={(e) => change({ status: e.target.value as SeatDbStatus })}
                      className="h-9 w-full rounded-sm border border-hairline bg-surface px-2 text-sm"
                    >
                      {SEAT_STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>

                  <Button size="sm" variant="secondary" onClick={snap} className="w-full">
                    <Magnet aria-hidden="true" />
                    Snap to nearest detected workstation
                  </Button>

                  <p className="text-xs text-ink-subtle">
                    Drag the seat on the plan, or use the fields above. Ctrl+Z undoes,
                    Ctrl+Shift+Z redoes.
                  </p>
                </>
              ) : (
                <p className="text-xs text-ink-muted">
                  Click a seat on the plan to move, rotate or retire it.
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Positions needing a look</CardTitle>
            </CardHeader>
            <CardBody>
              {interpolated.length === 0 ? (
                <p className="text-xs text-ink-muted">
                  Every seat in this view came from detected geometry.
                </p>
              ) : (
                <>
                  <p className="mb-2 text-xs text-ink-muted">
                    These bays came up short in the drawing, so the position was
                    extended along the run&rsquo;s own axis. Check them first.
                  </p>
                  <ul className="flex flex-wrap gap-1">
                    {interpolated.map((seat) => (
                      <li key={seat.seatCode}>
                        <button
                          type="button"
                          onClick={() => setSelected(seat.seatCode)}
                          className="seat-code rounded-sm border border-caution px-1.5 py-0.5 text-[11px] text-caution"
                        >
                          {seat.seatCode}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2">
                    <Badge variant="caution">{interpolated.length} interpolated</Badge>
                  </p>
                </>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
