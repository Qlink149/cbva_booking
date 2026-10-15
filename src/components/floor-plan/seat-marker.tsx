"use client";

import { memo } from "react";
import { motion } from "motion/react";

import { SEAT_STATUS_TOKENS } from "@/components/seat/seat-status";
import type { FloorPlanSeat } from "@/components/floor-plan/types";
import type { LodLevel } from "@/lib/floor-plan-lod";
import { PLAN_BOUNDS } from "@/lib/floorplan";
import { countsAsOccupied } from "@/lib/seat-visual-status";
import { cn } from "@/lib/utils";

/**
 * One seat on the plan.
 *
 * A real <button>, so it is keyboard reachable, gets the global focus ring and
 * announces itself, rather than an SVG shape wearing role="button".
 *
 * It takes its colour, border treatment and glyph straight from
 * SEAT_STATUS_TOKENS. There is no second colour map anywhere in Phase 2 — the
 * greyscale and colour-blind guarantee proven on /styleguide only holds
 * because that table has exactly one consumer vocabulary.
 */
interface SeatMarkerProps {
  seat: FloorPlanSeat;
  /** Rendered size in CSS pixels, before the layer's scale is applied. */
  sizePx: number;
  /** The layer's current scale, so the marker can hold a constant screen size. */
  scale: number;
  isFocused: boolean;
  isDimmed: boolean;
  reduceMotion: boolean;
  /**
   * "bay" means the plan is framed too wide for per-seat status to be read at
   * all, so the seat paints as a plain dot and BayDensity answers the question
   * instead. The BUTTON IS UNCHANGED in every other respect -- same hit box,
   * same tab order, same accessible name, same status in `data-status`. Only
   * the paint differs, so nothing a keyboard or a screen reader can observe
   * moves with the zoom.
   */
  lod: LodLevel;
  tabIndex: number;
  onActivate: (seat: FloorPlanSeat) => void;
  onFocus: (seat: FloorPlanSeat) => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>, seat: FloorPlanSeat) => void;
}

function SeatMarkerImpl({
  seat,
  sizePx,
  scale,
  isFocused,
  isDimmed,
  reduceMotion,
  lod,
  tabIndex,
  onActivate,
  onFocus,
  onBlur,
  onKeyDown,
}: SeatMarkerProps) {
  const token = SEAT_STATUS_TOKENS[seat.status];
  // Markers hold a constant on-screen size, so a seat stays hittable when the
  // whole cruciform is framed and does not become a billboard when zoomed in.
  const unit = sizePx / scale;
  const aggregate = lod === "bay";
  const showCode = !aggregate && sizePx >= 26;

  const label = [
    `Seat ${seat.seatCode}`,
    `Zone ${seat.zone}`,
    `bay ${seat.bay}`,
    token.srLabel,
    seat.occupantName ? `— ${seat.occupantName}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <motion.button
      type="button"
      data-seat={seat.seatCode}
      data-status={seat.status}
      data-zone={seat.zone}
      data-bay={seat.bay}
      tabIndex={tabIndex}
      // aria-disabled, never the `disabled` attribute. A disabled button is
      // removed from the tab order entirely, which would make arrow navigation
      // dead-end at every booked desk and would stop a keyboard user ever
      // reading who has it. The seat stays focusable and announces its state;
      // it simply does not act.
      aria-disabled={!token.interactive}
      aria-label={label}
      onClick={() => {
        if (token.interactive) onActivate(seat);
      }}
      onFocus={() => onFocus(seat)}
      onBlur={onBlur}
      onPointerEnter={() => onFocus(seat)}
      onPointerLeave={onBlur}
      onKeyDown={(e) => onKeyDown(e, seat)}
      className={cn(
        "absolute flex items-center justify-center p-0 leading-none",
        "focus-visible:z-20",
        // The hit box is deliberately the SAME SIZE at both levels. Shrinking
        // the target along with the paint would trade an unreadable chip for
        // an unclickable one, which is not a better answer.
        aggregate
          ? "rounded-full border-0 bg-transparent"
          : cn("rounded-sm", token.className),
        token.interactive ? "cursor-pointer" : "cursor-default",
        isDimmed && "opacity-25",
      )}
      style={{
        left: seat.planX - PLAN_BOUNDS.x,
        top: seat.planY - PLAN_BOUNDS.y,
        width: unit,
        height: unit,
        marginLeft: -unit / 2,
        marginTop: -unit / 2,
        fontSize: Math.max(5, unit * 0.34),
        zIndex: isFocused ? 15 : 10,
      }}
      // A spring, not an ease — the seat should feel like it is being picked
      // up. Kept short so it never gets in the way of a fast booking.
      animate={{
        scale: reduceMotion ? 1 : isFocused ? 1.35 : 1,
        rotate: seat.rotationDeg,
      }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { type: "spring", stiffness: 520, damping: 26, mass: 0.5 }
      }
    >
      {aggregate ? (
        // A plain dot, not the seven-status vocabulary — that IS illegible at
        // this framing. But whether the desk is currently held is a coarse,
        // two-state fact that survives the zoom out just fine: a filled dot
        // for booked/checked-in/yours, a hollow one for everything else. This
        // is the density signal that has to survive "occupancy labels off"
        // (A1's hard constraint) — the same two seat tokens a chip uses,
        // applied per desk instead of averaged per bay, so it needs no new
        // colour and no opacity ramp (ADR-048 is explicit that a ramp does
        // not belong on this layer).
        <span
          aria-hidden="true"
          className={cn(
            "rounded-full",
            isFocused
              ? "bg-navy"
              : countsAsOccupied(seat.status)
                ? "bg-navy"
                : "border border-ink-subtle bg-transparent",
          )}
          style={{ width: unit * 0.34, height: unit * 0.34 }}
        />
      ) : showCode ? (
        <span
          className="seat-code font-medium"
          aria-hidden="true"
          // The plan is rotated with the wings; the label is not, or half the
          // floor would read upside down.
          style={{ transform: `rotate(${-seat.rotationDeg}deg)` }}
        >
          {seat.seatCode}
        </span>
      ) : token.glyph ? (
        <span aria-hidden="true" style={{ transform: `rotate(${-seat.rotationDeg}deg)` }}>
          {token.glyph}
        </span>
      ) : null}
    </motion.button>
  );
}

export const SeatMarker = memo(SeatMarkerImpl);
