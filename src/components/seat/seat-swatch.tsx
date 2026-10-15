import { cn } from "@/lib/utils";
import {
  SEAT_STATUS_TOKENS,
  type SeatVisualStatus,
} from "@/components/seat/seat-status";

interface SeatSwatchProps {
  status: SeatVisualStatus;
  /** Seat code, e.g. "37" (the architect's desk number). Rendered in mono, as the type rules require. */
  code?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizes = {
  sm: "size-6 text-[9px]",
  md: "size-10 text-[10px]",
  lg: "size-14 text-xs",
} as const;

/**
 * The atom every seat rendering in this product is built from — the legend on
 * /styleguide, the Phase 2 floor plan, the Phase 5 analytics tables.
 *
 * Renders status with a border treatment and a glyph as well as a colour, so it
 * survives greyscale and colour-vision deficiency.
 */
export function SeatSwatch({ status, code, size = "md", className }: SeatSwatchProps) {
  const token = SEAT_STATUS_TOKENS[status];
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-sm leading-none select-none",
        sizes[size],
        token.className,
        className,
      )}
      role="img"
      aria-label={code ? `Seat ${code}: ${token.srLabel}` : token.srLabel}
    >
      {code ? (
        <span className="seat-code font-medium">{code}</span>
      ) : token.glyph ? (
        <span aria-hidden="true">{token.glyph}</span>
      ) : null}
    </span>
  );
}

/**
 * Seat with the glyph shown alongside the code — used where a seat is large
 * enough to carry both, so the non-colour cue is never dropped for space.
 */
export function SeatSwatchWithGlyph({
  status,
  code,
  className,
}: Omit<SeatSwatchProps, "size">) {
  const token = SEAT_STATUS_TOKENS[status];
  return (
    <span
      className={cn(
        "inline-flex h-10 min-w-20 items-center justify-center gap-1.5 rounded-sm px-2 leading-none",
        token.className,
        className,
      )}
      role="img"
      aria-label={code ? `Seat ${code}: ${token.srLabel}` : token.srLabel}
    >
      <span className="seat-code text-[11px] font-medium">{code ?? "—"}</span>
      {token.glyph ? (
        <span aria-hidden="true" className="text-[11px] opacity-80">
          {token.glyph}
        </span>
      ) : null}
    </span>
  );
}
