"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { BayDensity } from "@/components/floor-plan/bay-density";
import { SeatMarker } from "@/components/floor-plan/seat-marker";
import { SeatHoverCard } from "@/components/floor-plan/seat-hover-card";
import { ZoomControls } from "@/components/floor-plan/controls";
import { usePanZoom, type Rect } from "@/components/floor-plan/use-pan-zoom";
import type { FloorPlanSeat } from "@/components/floor-plan/types";
import {
  FULL_FLOOR_BOUNDS,
  PLAN_BOUNDS,
  floorplanMeta,
  floorplanZones,
  zoneSeatBounds,
  type ZoneCode,
} from "@/lib/floorplan";
import {
  LOD_2D_ENTER_BAY,
  LOD_2D_EXIT_BAY,
  resolveLod,
  type LodLevel,
} from "@/lib/floor-plan-lod";
import { PLAN_LABELS, labelText, nonBookableSummary } from "@/lib/floorplan-labels";
import { cn } from "@/lib/utils";

interface PlanCanvasProps {
  seats: FloorPlanSeat[];
  activeZone: ZoneCode | null;
  focusedSeatCode: string | null;
  reduceMotion: boolean;
  /** Changes whenever the date or slot does, driving the state crossfade. */
  crossfadeKey: string;
  onFocusSeat: (code: string | null) => void;
  onActivateSeat: (seat: FloorPlanSeat) => void;
  /** Editor hook: dragging is off on /floor and on in /admin/floor-plan. */
  onDragSeat?: (seatCode: string, planX: number, planY: number) => void;
  /** The bay occupancy chips (A1). Off by default; the per-seat dot fill in
   *  SeatMarker is the density signal that survives this being off. */
  showOccupancyLabels?: boolean;
  /** The room labels over zones A and B (A1). On by default — without them
   *  those wings read as broken rather than as furnished rooms. */
  showRoomLabels?: boolean;
  className?: string;
}

/**
 * A paper halo behind each plan label, and ink rather than ink-subtle.
 *
 * These labels are <text> lying DIRECTLY on the architect's drawing with
 * nothing behind them. That was fine while the drawing was baked as pale
 * greyscale. Phase 7 bakes it in its own colours, and measuring the composited
 * pixels found ink-subtle reaching only 4.02:1 against the drawing's darker
 * linework -- below the 4.5:1 floor, and varying with whatever the label
 * happens to sit over, which is the worse property.
 *
 * `paint-order: stroke` draws the stroke first and the fill on top, so a
 * paper-coloured stroke becomes a halo AROUND each glyph rather than a smear
 * across it. The effective background is then paper wherever the label lands,
 * so the ratio no longer depends on the drawing at all.
 *
 * The label, not the texture. The drawing is the thing being reproduced
 * faithfully; a label drawn over it is ours to make legible.
 */
const HALO: React.CSSProperties = {
  paintOrder: "stroke",
  stroke: "var(--cbva-paper)",
  strokeWidth: 3,
  strokeLinejoin: "round",
};

const DIRECTIONS: Record<string, [number, number]> = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowUp: [0, -1],
};

export function PlanCanvas({
  seats,
  activeZone,
  focusedSeatCode,
  reduceMotion,
  crossfadeKey,
  onFocusSeat,
  onActivateSeat,
  onDragSeat,
  showOccupancyLabels = false,
  showRoomLabels = true,
  className,
}: PlanCanvasProps) {
  const { containerRef, size, transform, setTransform, fitTo, zoomAt, handlers } =
    usePanZoom();
  const [animating, setAnimating] = useState(true);
  const seatRefs = useRef(new Map<string, HTMLButtonElement>());

  // Tight to the zone's own seats, not the convex hull (A4). See
  // zoneSeatBounds' doc comment for the core-overlap arithmetic this avoids.
  const target: Rect = useMemo(
    () => (activeZone ? zoneSeatBounds(seats, activeZone) : FULL_FLOOR_BOUNDS),
    [activeZone, seats],
  );

  // Zone focus is an animated reframing rather than a jump, so it stays
  // obvious which part of the floor you just moved to.
  useEffect(() => {
    if (size.width === 0) return;
    setAnimating(true);
    setTransform(fitTo(target));
  }, [fitTo, setTransform, size.width, target]);

  const beginPan = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      setAnimating(false);
      handlers.onPointerDown(e);
    },
    [handlers],
  );

  /* ---- what changed since the last date/slot, for the crossfade ---- */
  const previous = useRef<{ key: string; statuses: Map<string, string> } | null>(null);
  const changed = useMemo(() => {
    const now = new Map(seats.map((s) => [s.seatCode, s.status] as const));
    const prev = previous.current;
    previous.current = { key: crossfadeKey, statuses: now };
    if (!prev || prev.key === crossfadeKey) return new Set<string>();
    const out = new Set<string>();
    for (const [code, status] of now) {
      if (prev.statuses.get(code) !== status) out.add(code);
    }
    return out;
  }, [seats, crossfadeKey]);

  /* ---- keyboard ---- */
  const byCode = useMemo(
    () => new Map(seats.map((s) => [s.seatCode, s] as const)),
    [seats],
  );

  const move = useCallback(
    (from: FloorPlanSeat, dx: number, dy: number) => {
      // Geometrically adjacent within the bay: the nearest seat whose bearing
      // best matches the arrow pressed. Bays are runs and benches, so this is
      // what "the next desk along" actually means on this floor.
      let best: { seat: FloorPlanSeat; cost: number } | null = null;
      for (const candidate of seats) {
        if (candidate.seatCode === from.seatCode) continue;
        const inBay = candidate.bay === from.bay;
        const vx = candidate.planX - from.planX;
        const vy = candidate.planY - from.planY;
        const dist = Math.hypot(vx, vy);
        if (dist < 0.001) continue;
        const alignment = (vx * dx + vy * dy) / dist;
        if (alignment < 0.35) continue;
        // Prefer staying inside the bay; only leave it if nothing lines up.
        const cost = dist / alignment + (inBay ? 0 : 400);
        if (best === null || cost < best.cost) best = { seat: candidate, cost };
      }
      if (best) {
        seatRefs.current.get(best.seat.seatCode)?.focus();
      }
    },
    [seats],
  );

  const onSeatKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, seat: FloorPlanSeat) => {
      const dir = DIRECTIONS[e.key];
      if (dir) {
        e.preventDefault();
        move(seat, dir[0], dir[1]);
        return;
      }
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const inBay = seats.filter((s) => s.bay === seat.bay);
        const pick = e.key === "Home" ? inBay[0] : inBay[inBay.length - 1];
        if (pick) seatRefs.current.get(pick.seatCode)?.focus();
      }
    },
    [move, seats],
  );

  // Zoom from the keyboard, on the plan itself rather than only the buttons.
  const onCanvasKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setAnimating(true);
        zoomAt(1.3);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setAnimating(true);
        zoomAt(1 / 1.3);
      } else if (e.key === "0") {
        e.preventDefault();
        setAnimating(true);
        setTransform(fitTo(target));
      }
    },
    [fitTo, setTransform, target, zoomAt],
  );

  /* ---- roving tabindex: one stop for the plan, arrows for the rest ---- */
  const rovingCode =
    (focusedSeatCode && byCode.has(focusedSeatCode) ? focusedSeatCode : null) ??
    seats.find((s) => s.status === "available")?.seatCode ??
    seats[0]?.seatCode ??
    null;

  // A desk is ~23 plan units apart along a bench run, so at fit-to-floor
  // (scale ~0.5) neighbouring seats are 11px apart. Markers track that pitch
  // rather than a fixed pixel size, and clamp so they stay hittable when the
  // whole cruciform is framed and stop growing once zoomed in.
  const seatSizePx = Math.min(34, Math.max(13, transform.scale * 16));
  const focused = focusedSeatCode ? byCode.get(focusedSeatCode) : undefined;

  /* ---- level of detail (see src/lib/floor-plan-lod.ts) ----
     Below the threshold the marker is pinned at its 13px floor while the
     desk pitch keeps shrinking, so the chips collide and the glyphs stop
     being readable. Rather than render seven statuses nobody can tell apart,
     the plan answers the question that framing actually asks: how full is
     each bay. The seat buttons stay in the DOM throughout; only their paint
     changes. Hysteresis, so a settling spring cannot make it flicker. */
  const [lod, setLod] = useState<LodLevel>("bay");
  useEffect(() => {
    // A4: an explicit zone pick is "show me this wing's desks", a distinct
    // signal from the ambient pan/zoom the hysteresis exists to damp — so it
    // forces seat detail outright rather than trusting the fit scale to land
    // on the right side of the threshold. zoneSeatBounds already clears the
    // threshold with margin at every viewport ≥ ~490px; below that a wing's
    // own physical extent cannot fit at per-seat scale regardless of framing,
    // and forcing the LOD here is the honest fallback rather than pretending
    // it fits. Whole-floor framing and free zoom are untouched.
    if (activeZone) {
      setLod("seat");
      return;
    }
    setLod((prev) =>
      resolveLod(prev, transform.scale, LOD_2D_ENTER_BAY, LOD_2D_EXIT_BAY),
    );
  }, [transform.scale, activeZone]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative touch-none overflow-hidden rounded-md border border-hairline bg-paper",
        className,
      )}
      onKeyDown={onCanvasKeyDown}
      {...handlers}
      onPointerDown={beginPan}
      data-lod={lod}
      role="application"
      // Focusable so the plan itself can take the zoom keys. Without it the
      // +/-/0 shortcuts only fired when a seat happened to hold focus.
      tabIndex={0}
      aria-label={`Floor 4 plan. Use the arrow keys to move between seats, plus and minus to zoom, and 0 to fit the floor. ${nonBookableSummary()}`}
    >
      <motion.div
        className="absolute top-0 left-0 origin-top-left will-change-transform"
        style={{ width: PLAN_BOUNDS.width, height: PLAN_BOUNDS.height }}
        animate={{ x: transform.x, y: transform.y, scale: transform.scale }}
        transition={
          reduceMotion || !animating
            ? { duration: 0 }
            : { type: "spring", stiffness: 190, damping: 30, mass: 0.8 }
        }
      >
        {/* The drawing itself: one static raster, never in the live DOM as
            paths. The wall layer alone is 8,603 of them.

            Held back to 55% so it reads as the substrate it is. At
            fit-to-floor a desk is about 11px across, and against full-strength
            CAD linework the seat chips simply disappear — the drawing is
            context, the seats are the content. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={
            transform.scale > 2
              ? floorplanMeta.texture["4096"]
              : floorplanMeta.texture["2048"]
          }
          alt=""
          aria-hidden="true"
          draggable={false}
          width={PLAN_BOUNDS.width}
          height={PLAN_BOUNDS.height}
          decoding="async"
          className="pointer-events-none absolute inset-0 h-full w-full select-none opacity-55"
        />

        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`${PLAN_BOUNDS.x} ${PLAN_BOUNDS.y} ${PLAN_BOUNDS.width} ${PLAN_BOUNDS.height}`}
          aria-hidden="true"
        >
          {floorplanZones.zones.map((zone) => (
            <motion.polygon
              key={zone.code}
              points={zone.polygon.map((p) => p.join(",")).join(" ")}
              className="fill-navy stroke-navy"
              strokeWidth={1}
              initial={false}
              animate={{
                fillOpacity: activeZone === zone.code ? 0.05 : 0,
                strokeOpacity: activeZone === zone.code ? 0.35 : 0,
              }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.18 }}
            />
          ))}

          {/*
            Room labels. Zones A and B have no bookable desks at all — a
            boardroom, four meeting rooms, two lounges and a flexible room —
            so without these the wings read as a fault rather than as rooms.

            <text>, not <path>: e2e/floor-plan.spec.ts counts paths inside this
            container to hold ADR-019's promise that the CAD linework is a
            raster and never thousands of nodes. Text costs nothing against it.

            The bay code is JetBrains Mono because that is what the type rules
            reserve it for — seat codes, bay labels, plan annotations.
          */}
          {showRoomLabels
            ? PLAN_LABELS.map((label) => (
                <g key={label.code} className="fill-ink" style={HALO}>
                  <text
                    x={label.planX}
                    y={label.planY - 5}
                    textAnchor="middle"
                    className="font-mono"
                    style={{ fontSize: 11, letterSpacing: "0.04em" }}
                  >
                    {label.code}
                  </text>
                  <text
                    x={label.planX}
                    y={label.planY + 9}
                    textAnchor="middle"
                    style={{ fontSize: 12 }}
                  >
                    {labelText(label)}
                  </text>
                </g>
              ))
            : null}

          <BayDensity
            seats={seats}
            activeZone={activeZone}
            visible={lod === "bay" && showOccupancyLabels}
            reduceMotion={reduceMotion}
            scale={transform.scale}
          />
        </svg>

        {seats.map((seat) => (
          <div key={seat.seatCode} className="contents">
            <SeatMarkerHost
              seat={seat}
              sizePx={seatSizePx}
              scale={transform.scale}
              isFocused={focusedSeatCode === seat.seatCode}
              isDimmed={activeZone !== null && seat.zone !== activeZone}
              justChanged={changed.has(seat.seatCode)}
              reduceMotion={reduceMotion}
              tabIndex={rovingCode === seat.seatCode ? 0 : -1}
              register={seatRefs}
              onActivate={onActivateSeat}
              onFocus={(s) => onFocusSeat(s.seatCode)}
              onBlur={() => onFocusSeat(null)}
              onKeyDown={onSeatKeyDown}
              onDrag={onDragSeat}
              layerScale={transform.scale}
              lod={lod}
            />
          </div>
        ))}
      </motion.div>

      <div className="absolute right-3 bottom-3 z-30">
        <ZoomControls
          onZoomIn={() => {
            setAnimating(true);
            zoomAt(1.3);
          }}
          onZoomOut={() => {
            setAnimating(true);
            zoomAt(1 / 1.3);
          }}
          onFit={() => {
            setAnimating(true);
            setTransform(fitTo(target));
          }}
        />
      </div>

      {focused ? (
        <SeatHoverCard
          seat={focused}
          screenX={(focused.planX - PLAN_BOUNDS.x) * transform.scale + transform.x}
          screenY={(focused.planY - PLAN_BOUNDS.y) * transform.scale + transform.y}
          containerWidth={size.width}
          reduceMotion={reduceMotion}
        />
      ) : null}
    </div>
  );
}

/**
 * Wraps SeatMarker with the bits that are about the canvas rather than the
 * seat: the ref registry for keyboard focus, the change pulse, and the
 * editor's drag.
 */
function SeatMarkerHost({
  seat,
  register,
  justChanged,
  reduceMotion,
  onDrag,
  layerScale,
  ...rest
}: {
  seat: FloorPlanSeat;
  register: React.RefObject<Map<string, HTMLButtonElement>>;
  justChanged: boolean;
  reduceMotion: boolean;
  onDrag?: (seatCode: string, planX: number, planY: number) => void;
  layerScale: number;
} & Omit<
  React.ComponentProps<typeof SeatMarker>,
  "seat" | "reduceMotion"
>) {
  const hostRef = useCallback(
    (el: HTMLDivElement | null) => {
      const button = el?.querySelector("button");
      if (button) register.current.set(seat.seatCode, button);
      else register.current.delete(seat.seatCode);
    },
    [register, seat.seatCode],
  );

  const dragProps = onDrag
    ? {
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
          e.stopPropagation();
          const start = { x: e.clientX, y: e.clientY, px: seat.planX, py: seat.planY };
          const target = e.currentTarget;
          target.setPointerCapture(e.pointerId);
          const onMove = (ev: PointerEvent) => {
            onDrag(
              seat.seatCode,
              start.px + (ev.clientX - start.x) / layerScale,
              start.py + (ev.clientY - start.y) / layerScale,
            );
          };
          const onUp = () => {
            target.removeEventListener("pointermove", onMove);
            target.removeEventListener("pointerup", onUp);
          };
          target.addEventListener("pointermove", onMove);
          target.addEventListener("pointerup", onUp);
        },
      }
    : {};

  return (
    <div ref={hostRef} className="contents" {...dragProps}>
      <SeatMarker seat={seat} reduceMotion={reduceMotion} {...rest} />
      {/* The crossfade's second half: seats whose status actually changed get
          a single expanding ring, so the eye is told where to look instead of
          having to diff 158 squares itself. */}
      <AnimatePresence>
        {justChanged && !reduceMotion ? (
          <motion.span
            key={`${seat.seatCode}-pulse`}
            aria-hidden="true"
            className="pointer-events-none absolute rounded-sm border border-gold"
            style={{
              left: seat.planX - PLAN_BOUNDS.x,
              top: seat.planY - PLAN_BOUNDS.y,
              width: 22,
              height: 22,
              marginLeft: -11,
              marginTop: -11,
              zIndex: 12,
            }}
            initial={{ opacity: 0.9, scale: 0.6 }}
            animate={{ opacity: 0, scale: 1.8 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
