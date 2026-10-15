/**
 * Room labels for the floor plan.
 *
 * WHY. Zone A holds eight cabin desks and otherwise no bookable desks at all —
 * a 25-person boardroom, four meeting rooms, two lounges and storage. Without
 * a label that wing reads as a fault in the drawing. One word each turns "the
 * model looks empty and broken" into "that wing is meeting rooms", which is a
 * large change in how the plan reads for a very small amount of geometry.
 *
 * The POSITIONS and the CAPACITIES come from the drawing (`rooms.json`, R007's
 * room tags and PAX annotations, carried forward under R009 — ASSUMPTIONS
 * A33). Only the display NAMES are
 * ours, and they are not defined here twice: the five real meeting rooms take
 * their name from `MEETING_ROOMS`, joined on the bay code, which is the whole
 * reason `meeting_rooms.bay_code` exists. A room renamed on the /rooms screen
 * is renamed on the plan by construction.
 *
 * Safe in a client bundle: `inventory.ts`'s only import is a `import type`,
 * which is erased. See ADR-039 for the trap this is avoiding.
 */
import { floorplanRooms, floorplanZones } from "@/lib/floorplan";
import { MEETING_ROOMS } from "@/lib/seed-data/inventory";

export type PlanLabel = {
  /** The architect's bay tag, or the zone code for a whole-wing label. */
  code: string;
  name: string;
  /** Seats, where the drawing states one. */
  pax: number | null;
  planX: number;
  planY: number;
};

/** The zone-A bays that are not meeting rooms. The drawing gives them no PAX. */
const NON_ROOM_BAYS: Record<string, string> = {
  A4: "Storage",
  A5: "Lounge",
};

/**
 * Whole-wing labels, from the zone polygon's own anchor. Under R007 zone B was
 * labelled "Flexible room" here because it held no desks and the drawing's
 * own castors note sat inside it. R009 places 17 numbered workstations in
 * that wing (bay C, desks 9–25), so the label would now sit on top of bookable
 * desks and say something the drawing no longer says. Empty, deliberately;
 * the hook stays so a wing label can come back from the drawing, not from us.
 */
const ZONE_LABELS: Record<string, string> = {};

const roomNameByBay = new Map<string, string>(
  MEETING_ROOMS.map((r) => [r.bayCode, r.name]),
);

export const PLAN_LABELS: PlanLabel[] = [
  ...floorplanRooms.rooms.map((r) => ({
    code: r.bayCode,
    name: roomNameByBay.get(r.bayCode) ?? NON_ROOM_BAYS[r.bayCode] ?? r.bayCode,
    pax: r.pax,
    planX: r.planX,
    planY: r.planY,
  })),
  ...floorplanZones.zones
    .filter((z) => z.code in ZONE_LABELS)
    .map((z) => ({
      code: z.code,
      name: ZONE_LABELS[z.code],
      pax: null,
      planX: z.labelAnchor[0],
      planY: z.labelAnchor[1],
    })),
];

/** "Boardroom · 25 seats" — what a reader needs, in the order they need it. */
export function labelText(label: PlanLabel): string {
  return label.pax === null ? label.name : `${label.name} · ${label.pax} seats`;
}

/**
 * The same information the labels carry, as a sentence.
 *
 * The labels live inside an `aria-hidden` SVG in 2D and inside a canvas in 3D,
 * so on their own they would be visible-only — and what they convey is not
 * decoration. It is the answer to "why does a third of this floor have no
 * desks on it", which is exactly the question a screen reader user cannot see
 * the answer to.
 */
export function nonBookableSummary(): string {
  const rooms = PLAN_LABELS.filter((l) => l.pax !== null)
    .sort((a, b) => (b.pax ?? 0) - (a.pax ?? 0))
    .map((l) => `${l.name} (${l.pax} seats)`);
  const other = PLAN_LABELS.filter((l) => l.pax === null).map((l) => l.name);
  return (
    `Zone A has no bookable desks apart from the eight cabin desks in bays A and B. ` +
    `It holds ${rooms.join(", ")}` +
    (other.length ? `, and ${other.join(", ").toLowerCase()}` : "") +
    `.`
  );
}
