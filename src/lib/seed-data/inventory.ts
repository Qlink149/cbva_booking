import type { Grade } from "@/lib/db/schema";

/**
 * Floor 4 seat inventory, from the Neetaara furniture layout drawing
 * R009 (17-06-2025), now parked in tools/cad/. ADR-049.
 *
 * 158 working desks. R009 numbers every desk 1–158 on the plan and tags every
 * bay with a circled letter A–T, so both the seat codes and the bay names here
 * are the architect's own rather than anything we invented:
 *
 *   - A SEAT CODE IS THE DESK NUMBER, as a plain string: "1" … "158". It is
 *     what is printed beside the desk on the drawing and what will be on the
 *     QR sticker. No prefix, no padding — a reader looking for desk 37 on the
 *     floor is looking for "37".
 *   - A BAY IS ITS LETTER, and desks are numbered contiguously within a bay in
 *     letter order (A = 1–4, B = 5–8, C = 9–25 …). `firstDesk` below is that
 *     start; the build asserts the same ranges against the plan.
 *
 * The title block of the same sheet still lists the bays under the R007 names
 * (A1, D1–D8, PASSAGE, C1–C7, B1, B2) and sums them to 158. Those names are no
 * longer on the plan; the letters are. See ASSUMPTIONS A32.
 */
export interface BayDef {
  bay: string;
  zone: "A" | "B" | "C" | "D";
  count: number;
  /** The architect's number for the first desk in this bay. */
  firstDesk: number;
}

const SCHEDULE: Array<[bay: string, zone: BayDef["zone"], count: number]> = [
  ["A", "A", 4],
  ["B", "A", 4],

  ["C", "B", 17],

  ["D", "C", 6],
  ["E", "C", 4],
  ["F", "C", 9],
  ["G", "C", 9],
  ["H", "C", 9],
  ["I", "C", 9],
  ["J", "C", 4],

  ["K", "D", 9],
  ["L", "D", 9],
  ["M", "D", 9],
  ["N", "D", 9],
  ["O", "D", 1],
  ["P", "D", 4],
  ["Q", "D", 4],
  ["R", "D", 4],

  ["S", "D", 18], // the passage run through zone D
  ["T", "C", 16], // the passage run through zone C
];

export const BAYS: BayDef[] = (() => {
  let next = 1;
  return SCHEDULE.map(([bay, zone, count]) => {
    const def = { bay, zone, count, firstDesk: next };
    next += count;
    return def;
  });
})();

export const TOTAL_SEATS = BAYS.reduce((n, b) => n + b.count, 0); // 158

/**
 * ZONE NAMES — one comes from the drawing, three are deliberately bare (A11).
 *
 * A keeps its name because it IS drawing-derived: the boardroom and four
 * meeting rooms are in that wing. B lost its "Flexible Room" name with R009:
 * the drawing now places 17 numbered workstations there (bay C, desks 9–25,
 * the sheet's "B1 = 9 / B2 = 8" and "B. = 17 PAX"). What else that wing holds
 * is not something the drawing says, so it carries no claim, like C and D.
 *
 * C and D have carried no claim since Phase 7. They had been "Audit Floor" and
 * "Tax & Advisory Floor" — both invented — and a partner opening the floor plan
 * does not read ASSUMPTIONS.md; they read the label and either believe
 * something untrue about their own office or start doubting the rest of the
 * screen. The question goes to the only people who can answer it (OPEN
 * QUESTIONS: "do wings B, C and D correspond to specific teams?") and the
 * answer is typed into Admin → Settings rather than deployed.
 */
export const ZONES = [
  { code: "A", displayName: "Zone A — Boardroom & Meeting Rooms", sortOrder: 1 },
  { code: "B", displayName: "Zone B", sortOrder: 2 },
  { code: "C", displayName: "Zone C", sortOrder: 3 },
  { code: "D", displayName: "Zone D", sortOrder: 4 },
] as const;

/** Codes for one bay: the architect's desk numbers, "26" … "31" for bay D. */
export function seatCodes(bay: BayDef): string[] {
  return Array.from({ length: bay.count }, (_, i) => String(bay.firstDesk + i));
}

/** Desk numbers `from`..`to` inclusive, as seat codes. */
function desks(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
}

/**
 * ONE BLOCKED DESK — ASSUMPTION A13. The last desk of the zone-D passage run,
 * so the status vocabulary has a live example and the analytics have to cope
 * with capacity that is not the full seat count. Was PD-18 under R007.
 */
export const BLOCKED_SEAT_CODE = "142";

/**
 * FIXED SEAT ALLOCATION — ASSUMPTION. See docs/ASSUMPTIONS.md #2.
 *
 * The drawing gives bay sizes but does not say which physical desks are
 * allocated to whom. This is a deterministic, plausible allocation: cabins and
 * the perimeter bays go to fixed-seat grades, the open bays, zone B's 17 and
 * both passage runs stay bookable. 47 fixed against 111 bookable, matching
 * headcount exactly.
 *
 * Re-expressed in R009's desk numbers from the R007 allocation: the partners'
 * cabins A1/A2 are now desks 1–8, their C1 run is bay D (26–31) and C2's first
 * two are 32–33; the admin/HR/IT bank C3 is bay F, 36–43; the management
 * cabin D5 is bay O, 112.
 *
 * One deliberate change from a straight translation: R007 left C3 and C4 one
 * bookable desk short of full (C3-09, C4-09), which on R009 became bays F and
 * G showing a lone bookable desk each — a "0/1" chip on the floor plan that
 * reads as a fault rather than as a nearly reserved bay. The managers now take
 * F's ninth desk (44) and all of G (45–53), and give back R's last two
 * (123, 124), so F and G are wholly allocated and R keeps two bookable desks.
 * Same 47 allocated, same 111 who must book; only which desks differ.
 */
export const FIXED_SEAT_ALLOCATION: Array<{ codes: string[]; grade: Grade }> = [
  { codes: ["112"], grade: "director" },
  {
    codes: [
      ...desks(1, 8), // bays A and B, the partners' cabins
      ...desks(26, 31), // bay D
      "32",
      "33", // bay E, first two
    ],
    grade: "partner", // 16
  },
  {
    codes: [
      "34",
      "35", // bay E, last two
      "44", // bay F, its ninth desk after the admin bank
      ...desks(45, 53), // bay G, all nine
      ...desks(113, 122), // bays P, Q and half of R
    ],
    grade: "manager", // 22
  },
  {
    codes: desks(36, 43), // bay F, eight of nine
    grade: "admin_staff", // 8
  },
];

/**
 * seat_type, derived from the bay. S and T are the two passage runs — the
 * flip-down desks along the circulation route; J is the foldable training
 * bank (R007's C7); A, B and O are cabins (O being the single management cabin
 * on the drawing). ASSUMPTIONS A12.
 */
export function seatTypeForBay(bay: string): "workstation" | "passage" | "foldable" | "cabin" {
  if (bay === "S" || bay === "T") return "passage";
  if (bay === "A" || bay === "B" || bay === "O") return "cabin";
  if (bay === "J") return "foldable";
  return "workstation";
}

/**
 * MEETING ROOMS — five, all in Zone A, from the R007 drawing's annotations.
 *
 * Phase 1 seeded six provisionally (25, 10, 8, 7, 6, 4). Two capacities were
 * wrong and one room did not exist. Re-read at the vector level on R007, every
 * zone-A room tag paired to a PAX annotation within 33 plan units:
 *
 *     A3 -> 25 PAX (18.6 units)    A9 -> 10 PAX (32.2)
 *     A8 ->  7 PAX (25.9)          A7 ->  5 PAX (25.3)
 *     A6 ->  5 PAX (25.9)
 *
 * R009 dropped the room tags and their PAX with the rest of its annotation;
 * the rooms themselves are unchanged (identical shell, boardroom chairs still
 * drawn), so this schedule is carried forward and flagged — ASSUMPTIONS A33.
 *
 * `bayCode` is the join key to the floor plan, so a room on the plan and a row
 * on /rooms are the same thing rather than two lists that agree by convention.
 * These are R007 ROOM tags, a different vocabulary from the R009 BAY letters:
 * "A3" is the boardroom, "A" is the partners' cabin bay. The NAMES are still
 * ours (A3 aside, "Boardroom" is what R007's own "EXISTING HERMENMILLER CHAIRS
 * IN BOARD ROOM TO RETAIN - 25 NOS" note calls it). ASSUMPTIONS A3.
 */
export const MEETING_ROOMS = [
  { bayCode: "A3", name: "Boardroom", capacity: 25, amenities: { screen: true, vc: true, whiteboard: true } },
  { bayCode: "A9", name: "Meeting Room A9", capacity: 10, amenities: { screen: true, vc: true } },
  { bayCode: "A8", name: "Meeting Room A8", capacity: 7, amenities: { screen: true, vc: false } },
  { bayCode: "A7", name: "Meeting Room A7", capacity: 5, amenities: { screen: false, vc: false } },
  { bayCode: "A6", name: "Meeting Room A6", capacity: 5, amenities: { screen: false, vc: false } },
] as const;

/**
 * HEADCOUNT — from the drawing's title block: Partner 16, C.A 54, Article 62,
 * Admin/HR/IT 8, "B." 17, Management cabin 1. Total 158.
 *
 * ASSUMPTION (docs/ASSUMPTIONS.md #1): the drawing does not say how the 54 CAs
 * split between Manager and Assistant Manager. Seeded 22/32. WE NEED AN HR LIST.
 *
 * ASSUMPTION (A34): the sheet's new "B. = 17 PAX" line is the 17 workstations
 * in zone B and says nothing about who sits there. CBVA's decision (Oct 2026)
 * is that they are bookable hot desks, so 17 bookable-grade people are added —
 * 7 Assistant Managers and 10 Articles, keeping roughly the 1:2 ratio of the
 * rest of the roster — until the HR list replaces every number here.
 */
export const HEADCOUNT: Array<{
  grade: Grade;
  count: number;
  seatMode: "fixed" | "bookable";
}> = [
  { grade: "partner", count: 16, seatMode: "fixed" },
  { grade: "director", count: 1, seatMode: "fixed" },
  { grade: "manager", count: 22, seatMode: "fixed" },
  { grade: "assistant_manager", count: 39, seatMode: "bookable" },
  { grade: "article", count: 72, seatMode: "bookable" },
  { grade: "admin_staff", count: 8, seatMode: "fixed" },
];

export const TOTAL_HEADCOUNT = HEADCOUNT.reduce((n, h) => n + h.count, 0); // 158

/**
 * The 17 people R009 added, by grade — the part of HEADCOUNT above that was
 * not in R007's 141. The seed generates the original roster first, in the
 * order it always has, and these after it, so every one of the 141 existing
 * demo people keeps the email address they had (and with it their password
 * and their history). Reordering the roster would have renamed 71 people.
 */
export const R009_ADDED_PEOPLE: Partial<Record<Grade, number>> = {
  assistant_manager: 7,
  article: 10,
};

export const TEAMS = [
  "Audit & Assurance",
  "Direct Tax",
  "Indirect Tax",
  "Transaction Advisory",
  "Risk Advisory",
  "Corporate Finance",
] as const;

export const ADMIN_TEAMS = ["Administration", "Human Resources", "Information Technology"] as const;

export const GRADE_LABEL: Record<Grade, string> = {
  partner: "Partner",
  director: "Director",
  manager: "Manager",
  assistant_manager: "Assistant Manager",
  article: "Article",
  admin_staff: "Admin / HR / IT",
};
