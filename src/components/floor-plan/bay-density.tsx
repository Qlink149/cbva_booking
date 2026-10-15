"use client";

import { motion } from "motion/react";

import type { FloorPlanSeat } from "@/components/floor-plan/types";
import { FULL_FLOOR_BOUNDS, PLAN_BOUNDS } from "@/lib/floorplan";
import { bayOccupancy, layoutBayChips, occupancyFraction } from "@/lib/floor-plan-lod";

interface BayDensityProps {
  seats: FloorPlanSeat[];
  activeZone: string | null;
  visible: boolean;
  reduceMotion: boolean;
  /** The layer's scale, so a chip can hold a constant SCREEN size. */
  scale: number;
}

/**
 * Chip size in CSS pixels, not plan units.
 *
 * A chip carries a bay code and a fraction, so unlike a seat marker it has an
 * absolute legibility floor: below about 9px the numerals stop being readable
 * and the whole layer is decoration. Sizing it in plan units made it 28x16px at
 * fit-to-floor -- the exact framing this layer exists to serve. So it is
 * divided by the layer scale, the same trick SeatMarker uses.
 */
const CHIP_W = 52;
const CHIP_H = 28;

/**
 * Bay-level occupancy, drawn only at whole-floor zoom.
 *
 * PRESENTATIONAL, AND AT NO POINT THE ACCESSIBLE PATH. This layer is
 * aria-hidden and pointer-events-none. The 158 seat <button>s stay in the DOM
 * at every zoom with their names intact -- they are simply painted as plain
 * dots underneath this, so a screen reader, the keyboard, the list view and
 * every e2e count behave exactly as they did. ADR-032's rule holds: a
 * rendering choice never degrades the accessible path.
 *
 * <rect>/<text>/<line>, never <path>. e2e/floor-plan.spec.ts counts SVG paths
 * inside the plan container to hold ADR-019's promise that the CAD linework
 * ships as a raster; bay chips drawn as paths would eat that allowance for
 * nothing.
 */
export function BayDensity({
  seats,
  activeZone,
  visible,
  reduceMotion,
  scale,
}: BayDensityProps) {
  const w = CHIP_W / scale;
  const h = CHIP_H / scale;
  // Clamped to the ZONE HULLS, not the plan box. Fit-to-floor frames the hulls,
  // so the plan box extends past the visible area and a chip clamped to it can
  // still land under the container's top edge -- which is exactly what one did.
  const chips = layoutBayChips(bayOccupancy(seats), w, h, FULL_FLOOR_BOUNDS);

  return (
    <motion.g
      aria-hidden="true"
      initial={false}
      animate={{ opacity: visible ? 1 : 0 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.15 }}
      style={{ pointerEvents: "none" }}
    >
      {chips.map((bay) => {
        const fraction = occupancyFraction(bay) ?? 0;
        const dimmed = activeZone !== null && bay.zone !== activeZone;
        const x = bay.chipX - PLAN_BOUNDS.x - w / 2;
        const y = bay.chipY - PLAN_BOUNDS.y - h / 2;
        const anchorX = bay.planX - PLAN_BOUNDS.x;
        const anchorY = bay.planY - PLAN_BOUNDS.y;
        const moved =
          Math.hypot(bay.chipX - bay.planX, bay.chipY - bay.planY) > w * 0.3;

        return (
          <g key={bay.bay} opacity={dimmed ? 0.2 : 1}>
            {/* A leader back to the desks, for the chips separation had to
                move. Without it a nudged chip claims the wrong bay. */}
            {moved && (
              <line
                x1={anchorX}
                y1={anchorY}
                x2={bay.chipX - PLAN_BOUNDS.x}
                y2={bay.chipY - PLAN_BOUNDS.y}
                className="stroke-ink-subtle"
                strokeWidth={0.7 / scale}
                opacity={0.5}
              />
            )}

            {/* The plate is opaque because it sits over the architect's
                drawing, and the numerals have to stay legible against whatever
                the drawing puts underneath -- red workstation hatch, across
                most of C and D. */}
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              rx={3 / scale}
              className="fill-paper stroke-hairline"
              strokeWidth={1 / scale}
            />

            {/* The fill IS the measure, drawn from the same two seat tokens a
                desk uses. No new colour enters the product here, and the
                fraction printed above it is the non-colour differentiator. */}
            <rect
              x={x}
              y={y + h - 3 / scale}
              width={w}
              height={3 / scale}
              className="fill-hairline"
            />
            {fraction > 0 && (
              <rect
                x={x}
                y={y + h - 3 / scale}
                width={w * fraction}
                height={3 / scale}
                className="fill-navy"
              />
            )}

            <text
              x={x + w / 2}
              y={y + 11 / scale}
              textAnchor="middle"
              className="fill-ink-muted font-mono"
              style={{ fontSize: 9 / scale, letterSpacing: "0.04em" }}
            >
              {bay.bay}
            </text>
            <text
              x={x + w / 2}
              y={y + 21 / scale}
              textAnchor="middle"
              className="fill-ink"
              style={{ fontSize: 11 / scale, fontWeight: 600 }}
            >
              {/* A fraction rather than a percentage, so a one-desk bay cannot
                  report "100% full" and read as a crisis. */}
              {bay.occupied}/{bay.capacity}
            </text>
          </g>
        );
      })}
    </motion.g>
  );
}
