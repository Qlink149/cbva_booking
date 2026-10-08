# Assumptions

Everything here was decided by us, not confirmed by CBVA. Each entry names the
file it affects so it can be found and changed when an answer arrives.

> **Sending this to the client? Send `docs/OPEN-QUESTIONS.md` instead.** It is
> the same material consolidated, ordered by how much it matters, and written
> for somebody who has not read the code. This file stays the engineering
> record — it names files and keeps the derivations.

**Phase 7 status.** **A11 is CLOSED as a disclosure problem and REOPENED as a
client question** — Zone C and D no longer carry invented names on screen; the
question "do wings C and D correspond to specific teams or functions?" goes to
CBVA instead. **A24 is unchanged in substance and materially easier to close:**
a `manual` anchor now survives `npm run build:floorplan`, which it did not
before, so a correction made in the editor is no longer undone by the next
rebuild. **A29 is new** — the fifth `F-FURNITURE HATCH` colour, now visible in
the texture. The client trio is still **A1**, **A16** and **A17**.

**Phase 6 status.** **A16 is DOWNGRADED** 🔴→🟠 — the drawing shows Zone B as a
flexible room, and the headline number no longer waits on it. **A3 is PARTLY
CLOSED** — five meeting rooms and their capacities now come from the drawing;
the names and the Outlook mailboxes do not. **A11 had two wrong entries** and
they are corrected. A23 grew four furniture heights. The client trio is now
**A1** (the HR grade list), **A16** (reworded) and **A17** (who owns room
booking).

**Phase 5 status.** A22 is CLOSED (the auto-release job is bounded). A24 is
PARTLY closed — the eleven desks no longer overlap, but their positions are
still inferred. A1, A2 and A17 remain open with the client and are answerable
through the admin screens rather than through code.

**Status key:** 🔴 blocking — the product is wrong until answered · 🟠 material —
changes numbers or behaviour · 🟡 cosmetic — safe to leave.

---

## The open client questions

### A1 — How do the 54 CAs split between Manager and Assistant Manager?

**Assumed:** 22 Manager (fixed seat) / 32 Assistant Manager (must book).

**Affects:** `src/lib/seed-data/inventory.ts` → `HEADCOUNT`, and by extension
every occupancy number in the product.

**Why it matters:** this single number sets the denominator for the entire
analytics product. The floor has 93 bookable desks — 141 total, minus 47
allocated to fixed grades, minus 1 blocked (PD-18, A13). We seeded 94 people
who must book, so demand and supply are close but not exactly balanced: the
floor is one desk short on our own guessed split. If the real split is 15/39,
demand rises to 101 against the same 93 desks and the floor is structurally
short by 8 — which is precisely the finding the partners are commissioning
this tool to produce. We cannot answer their question with a number we
invented.

**Corrected in Phase 8**, measured against the running system rather than
recalled: this entry and `docs/PROJECT.md` had said "94 bookable desks" and
"balance exactly" since Phase 1, without accounting for the one blocked desk
A13 introduces. The desk count is 93, not 94, and the seeded floor has never
actually been in exact balance — corrected here so the wrong one does not
reach a partner. `docs/OPEN-QUESTIONS.md` §1 carries the corrected table.

**WE NEED AN HR LIST**: name, email, grade, team, and whether they hold an
allocated seat. Nothing else in Phase 1 is as important as this.

---

### A2 — Which physical desks are allocated to fixed-grade staff?

**Assumed:** a deterministic allocation, 47 desks:

| Grade | Seats | Count |
|---|---|---|
| Director (management cabin) | D5-01 | 1 |
| Partner | A1-01…04, A2-01…04, C1-01…06, C2-01, C2-02 | 16 |
| Manager | C2-03, C2-04, C4-01…08, D6-01…04, D7-01…04, D8-01…04 | 22 |
| Admin / HR / IT | C3-01…08 | 8 |

Both passage runs (PA-01…16, PD-01…18) stay bookable.

**Affects:** `src/lib/seed-data/inventory.ts` → `FIXED_SEAT_ALLOCATION`.

**Why it matters:** the drawing gives bay sizes but not who sits where. This is
plausible — cabins and perimeter bays to fixed grades, open bays and passage
seats to the bookable pool — but it is invented. It determines which desks
appear as "Reserved (Fixed)" on the floor plan, so it will be visibly wrong to
anyone from CBVA looking at a demo.

**Sharper since Phase 2.** The plan now shows the real floor, so this is no
longer abstract: 47 specific desks in their real physical positions are drawn
as reserved. A partner opening `/floor` will recognise their own bay and see
the wrong desks greyed out. Answering this is now a five-minute edit in
`/admin/floor-plan` (change a seat's status, Save) rather than a code change.

---

### A3 — 🟠 PARTLY CLOSED in Phase 6 — the drawing settles how many rooms and how big; the names are still ours

**Was assumed (Phase 1):** six rooms — Boardroom 25, Conference A 10, Conference
B 8, Meeting Room 1 7, Meeting Room 2 6, Huddle Room 4.

**Now, from the drawing:** **five**, all in Zone A. Every zone-A room tag pairs
to a `N PAX.` annotation within 33 plan units:

| Bay | Name (ours) | Capacity (the drawing's) | Distance tag → PAX |
|---|---|---|---|
| A3 | Boardroom | **25** | 18.6 units |
| A9 | Meeting Room A9 | **10** | 32.2 |
| A8 | Meeting Room A8 | **7** | 25.9 |
| A7 | Meeting Room A7 | **5** | 25.3 |
| A6 | Meeting Room A6 | **5** | 25.9 |

**Two capacities were wrong and one room did not exist.** Phase 1 had an 8 and a
6 and a 4-person huddle room; the drawing has no 8, no 6 and no 4-person room in
Zone A at all. It reconciles independently: 25 + 10 + 7 + 5 + 5 = 52, plus the
`8 PAX` on the A1/A2 workstation run = 60, which is exactly the zone-A total,
and the sheet note *"CONFERENCE AREA AND CAFETERIA NOT INCLUDED"* is why those
52 are outside the 141.

**There are no meeting rooms in Zone B.** It has zero PAX annotations anywhere
and zero workstation hatch of either colour. See A16.

**Affects:** `src/lib/seed-data/inventory.ts` → `MEETING_ROOMS`,
`meeting_rooms.bay_code` (new in Phase 6, migration 0004).

**What is still open, and it is the part that blocks anything:**

1. **The names.** Still entirely ours. They are now bay-coded — "Meeting Room
   A9" rather than "Conference A" — which is one fewer invention, because the
   bay tag is the architect's. "Boardroom" is the drawing's own word, from
   *"EXISTING HERMENMILLER CHAIRS IN BOARD ROOM TO RETAIN - 25 NOS"*. CBVA will
   still have its own names, probably after clients or partners.
2. **The Outlook room resource mailbox** for each, null on every row.
   `meeting_rooms.outlook_resource_email`. This is what blocks the Graph
   calendar sync, and it is **A17** — unaffected by anything Phase 6 did.

**Each room now carries its bay code**, so the floor plan and `/rooms` join on
the architect's tag rather than on a display name CBVA is expected to change.

---

### A16 — 🟠 DOWNGRADED in Phase 6 — Zone B is a flexible room, and it no longer gates the headline number

**Assumed:** no bookable seats in Zone B.

**What the drawing settles, re-read at the vector level.** Everything below is
measured, not inferred from the layout:

| | |
|---|---|
| `N PAX.` annotations anywhere in Zone B | **zero** |
| `#FF0000` rapid-rail workstation hatch paths | **zero** |
| `#0037DD` screen-only workstation hatch paths | **zero** |
| `#4A9500` foldable-table hatch paths | **714** — more than the rest of the floor combined |
| `F-LOOSE FURNITURE` subpaths | 427 |
| the drawing's own note, inside this wing | *"Foldable table on castors: 2'-9" x 4'-0" = 5 nos, 2'-6" x 5'-0" = 3 nos"* |

A wing with no pax count, no workstation hatch of either type, and eight
foldable tables on castors is **a flexible room**, not a bank of desks. That is
as far as a drawing can settle it.

**So the question CBVA is asked has changed.** "Does anybody sit in Zone B?"
invites a confused yes — of course people sit in it, it has chairs. The
question now is:

> **Zone B is drawn as a flexible room with eight foldable tables on castors.
> Do staff work there on a normal day, or is it used only for training and
> all-hands?**

**Still open**, because if CBVA seats people there daily those desks become
bookable and the pool moves. **No longer load-bearing on the denominator:** the
Phase 5 headline number can be finalised on a pool of 93 once A1 closes, with
this noted as an upside risk rather than an unknown of the same size. That is
the change — from 🔴 blocking to 🟠 material.

**What was 🔴 about it, for the record.** Phase 2's chair detector found 33
unclaimed chairs here and nothing explained them; the sheet's
"CONFERENCE AREA AND CAFETERIA NOT INCLUDED" note covers Zone A and not this
wing. Thirty-three chairs around eight foldable tables and a sofa lounge is an
ordinary thing for a flexible room to contain, which is the explanation that
was missing.

---

### A16 (original derivation, retained)

**Assumed:** no. Zone B has zero bookable seats.

**Affects:** `src/lib/seed-data/inventory.ts` → `BAYS`, and therefore the
denominator of the Phase 5 headline number.

**What was detected:** the chair detector found **222** chair blocks and the bay
assignment claimed 130. The 92 it did not claim break down by wing as:

| Zone | Unassigned chairs | Explained? |
|---|---|---|
| A | 46 | **Yes, and the drawing says so outright** — see below. The 25-pax boardroom, the 10-pax and 8-pax conference rooms and the reception lounge. 25 + 10 + 8 = 43, plus lounge seating ≈ 46. |
| C | 7 | Visitor and spare chairs beside the bays. |
| D | 6 | As above. |
| **B** | **33** | **No.** |

### The drawing settles Zone A in the client's own words

The title block carries this, set immediately beneath the headline total:

```
TOTAL WORKING PEOPLE =   141 PAX
NOTE: CONFERENCE AREA AND CAFETERIA NOT INCLUDED.
```

So zone A's 46 surplus chairs are not merely *inferable* as conference and
lounge seating from their furniture type — **the architect states on the same
sheet, one line under the 141, that the conference area is excluded from that
count.** That is the line to quote if anyone at CBVA ever asks why a room full
of chairs is drawn with no bookable seats.

It is also a third independent confirmation of 141, alongside the per-bay PAX
annotations summing to it and the furniture schedule (93 + 4 workstations + 8
foldables + the passage runs). `npm run build:floorplan` now reads the title
block and **fails** if that figure and the bay schedule ever disagree; the note
is carried through into `detection-report.json` as `sheetExclusionNote`.

The supporting furniture evidence stands too: `RECEPTION`, `SOFA`,
`CENTER TABLE`, `SWIVEL CHAIR` ×2 and `3 grey + 1 black chair` all fall inside
the zone A polygon, as does the sheet note *"EXISTING HERMENMILLER CHAIRS IN
BOARD ROOM TO RETAIN - 25 NOS"* — verified by point-in-polygon against
`zones.json` rather than by reading the layout.

**Zone A therefore needs no question asked. Zone B is not covered by that note**
— it is neither conference area nor cafeteria, and it is the only wing with
unexplained chairs.

Zone B is the upper-left wing. Its annotations are room tags `K L M Q R`, a
`HUB ROOM`, `ELEC PANELS`, two lifts, one `CENTRE TABLE` / `SOFA` pair — and
**`MODULAR FURNITURE`**, which is workstation language, not lounge language.
Three `NO CHANGE AREA — ONLY REPAIR WORK` notes sit just outside the wing on
leader lines pointing into it. So the wing was excluded from the fit-out, which
is why it has no `N PAX.` count and why Phase 1 gave it no seats — but "excluded
from the refit" is not the same as "nobody sits there".

**One sentence from CBVA closes this: are the ~33 desks in the north-west wing
occupied by staff, and if so by how many?**

### What it changes, with the arithmetic shown

Measured from the seeded database: 141 desks — 47 fixed, 93 bookable, 1 blocked.
The floor plan's occupancy denominator is the **bookable pool (93)**, not the
total desk count.

Let `D_r` be the reported denominator and `D_t` the true one. For any booking
count `B`, reported utilisation is `B/D_r` and true utilisation is `B/D_t`, so
the **relative overstatement is `D_t/D_r − 1`, constant in `B`**. The
**percentage-point** gap is `B × (1/D_r − 1/D_t)`, which does depend on `B`.

Three different quantities, all real, none interchangeable:

| Quantity | Value |
|---|---|
| Total desks understated, as a fraction of the true total | 33 / 174 = **19.0%** |
| Total desks understated, as a fraction of the reported total | 33 / 141 = **23.4%** |
| Utilisation overstated, **if all 33 are bookable** (pool 93 → 126) | 126/93 − 1 = **35.5%** relative |
| Utilisation overstated, **if they split like the floor** (~33% fixed → pool 115) | 115/93 − 1 = **23.7%** relative |
| Point gap at the seeded 52 bookings, all-33-bookable case | 55.9% → 41.3% = **14.6 points** |

An earlier draft of this entry said "overstated by roughly 19%". That number is
the first row — *capacity* understated relative to the true total — and it was
wrongly attached to the word *occupancy*. The occupancy figure is out by 23.7%
or 35.5% depending on how the 33 split between fixed and bookable, which is
itself unknown. Corrected here so the wrong one does not reach a partner.

### When this has to close

**Not before Phase 3.** Booking and the auto-release rule do not care about the
denominator; they operate per seat. **Before the Phase 5 headline number** —
peak observed occupancy against the bookable pool — is finalised. Pair it with
**A1**: those two together fix the denominator, and nothing else does.

---

## 🟠 Material — changes behaviour or numbers

### A4 — Slot boundaries

**Assumed:** AM 09:00–13:00, PM 13:00–17:00 (Asia/Kolkata).

**Affects:** `src/lib/slots.ts` → `DEFAULT_SLOT_DEFINITIONS`, seeded into
`settings.slot_definitions`.

**Revised in Phase 3.** Phase 1 guessed 09:00–13:30 / 13:30–19:00; these are the
values the client brief states. Still not confirmed by CBVA themselves, and note
what they imply: the office day these describe is 09:00–17:00, so nothing is
bookable in the evening. If people routinely stay past five, PM's end is wrong
and every "attended" figure will be measuring a window that closes before they
leave.

**No longer costly to change.** ADR-007's warning — that these are baked into
`bookings.starts_at`/`ends_at` at write time — was closed by ADR-021. Editing a
boundary now backfills every affected booking in the same transaction. The
vocabulary itself is data too (ADR-020), so adding hourly slots is a settings
write rather than a migration.

### A5 — Booking window, cut-off and auto-release timings

**Assumed:** `booking_window_working_days` 5, `booking_window_days` 14,
`cutoff_minutes` 60, `auto_release_minutes` 120,
`check_in_opens_minutes_before` 30.

**Affects:** `scripts/seed.ts` (the settings row), `src/lib/db/schema.ts`,
`src/lib/booking-days.ts`.

The brief specifies the 2-hour auto-release rule, so 120 is solid. How close to a
slot staff may still cancel without penalty is invented — see A21 for the two
rules that had to be settled around it.

**Sharpened in Phase 3.** The window is now expressed in **working days** (5),
with `booking_window_days` (14) retained as the calendar-day ceiling the scan
stops at so an unusual run of holidays cannot walk it forward indefinitely. More
importantly, the window is now **enforced**: before Phase 3 the date strip was a
suggestion and a hand-edited URL could book any date at all, including one in
the past. One function returns the list, the strip renders it and the write path
validates against it, so the offer and the rule cannot drift apart.

**A note for CBVA.** If the 2-hour rule is ever shortened, or the firm moves to
hourly slots, check `auto_release_minutes` against the slot length. A grace
window longer than the slot means an un-checked-in booking can never be
released — by the time the window expires the slot is over and it settles as a
no-show instead. That is correct behaviour, and it silently removes the feature.

### A6 — The public holiday list

**Assumed:** 39 national and Maharashtra holidays across 2026–2027.

**Affects:** `src/lib/seed-data/holidays.ts`.

Every firm publishes its own list, and the lunar-calendar dates (Holi, both Ids,
Diwali, Janmashtami) vary by observance. The booking engine treats these as
non-working days, so **a wrong date means staff cannot book a day they are
expected in**. Replace with CBVA's official holiday circular before go-live.

### A7 — Who may book on behalf of someone else

**RESOLVED (Oct 2026): nobody.** CBVA asked for booking on somebody else's
behalf to be removed, for every grade, admins included. A desk is only ever
booked by the person who sits at it (`assertBookingForSelf()` in
`src/lib/booking/authorise.ts`), and the same rule applies to recurring series.
Historical on-behalf bookings are kept and still count in the analytics, under
their occupant. Admins can still **cancel** somebody else's booking. Meeting
rooms never had a book-for-someone-else path. The seed no longer generates
on-behalf bookings. `GET /api/people` and the person picker are gone.

The rest of this entry is the earlier assumption, kept for the record.

**Assumed (revised in Phase 3):** `is_admin`, plus Manager, Director and
Partner grades. The occupant must additionally be bookable-grade and active.

**Affects:** `src/lib/booking/authorise.ts` → `canBookOnBehalf()`,
`GET /api/people`, and the picker in the booking dialog.

Phase 1 assumed anyone could, and the seed still generates on-behalf bookings
from arbitrary colleagues — that seeded history is now looser than the live
rule, which is fine for demo data but worth knowing if anybody reads the seed as
documentation.

The narrower rule follows PROJECT.md's own grade table, which says Managers
"book on behalf of their team", and adds the admin/HR/IT staff who seat people
for a living. **Still a guess in one direction:** partners' secretaries are
admin staff and therefore covered, but if CBVA has a designated bookings
coordinator per team who is *not* a manager, they are currently locked out.

The list endpoint is gated on the same rule as the write, so somebody who may
not book for a colleague cannot enumerate the roster either.

### A8 — Email address format

**Assumed:** `firstname.lastname@cbva.in`.

**Affects:** `scripts/seed.ts`.

Real addresses come from the Entra tenant. This matters at cutover because
`users.email` is the join key between our roster and the Entra `preferred_username`
claim (see the TODO in `src/lib/adapters/production.ts`).

### A9 — Everyone is on Floor 4

**Assumed:** one active floor, number 4, all 141 people and all six rooms on it.

**Affects:** `scripts/seed.ts`.

The drawing covers Floor 4 only. The schema is already multi-floor
(`floors`, `zones`, `seats.floor_id`), so adding another is data, not migration.

### A10 — The demo clock offset is global

**Assumed:** one shared `settings.demo_offset_seconds` for the whole database.

**Affects:** `src/lib/clock.ts`, `src/app/api/clock/route.ts`.

Correct for a single-tenant partner demo, and required for server and client to
agree. But if two demos ever run against the same database at once, one person
advancing the clock moves it for the other. Acceptable for now; worth knowing
before a multi-audience demo day.

---

## 🟡 Cosmetic — safe to leave, easy to change

### A11 — Zone display names — 🟠 two were WRONG and are fixed; two are still ours

**Affects:** `src/lib/seed-data/inventory.ts` → `ZONES`.

**A and B were wrong, not merely unconfirmed.** Phase 1 called Zone B
"Boardroom & Conference". The drawing says the boardroom and all four meeting
rooms are in **Zone A** (bays A3, A9, A8, A7, A6), and Zone B has zero PAX
annotations and zero workstation hatch of either colour — it is the flexible
room. Phase 6's room labels put the contradiction on screen: a wing labelled
"Boardroom" beside a plan label reading "A3 Boardroom · 25 seats" in the *other*
wing is worse than no label at all.

| Zone | Was | Now | Evidence |
|---|---|---|---|
| A | Reception & Cabins | **Boardroom & Meeting Rooms** | the drawing's own A3/A6–A9 tags and PAX |
| B | Boardroom & Conference | **Flexible Room & Services** | no PAX, no workstation hatch, the castors note, the K/L/M/Q/R rooms |
| C | Audit Floor | **Zone C** | **none — the name was ours, and is gone** |
| D | Tax & Advisory Floor | **Zone D** | **none — the name was ours, and is gone** |

**C and D were NEUTRALISED in Phase 7, reversing the Phase 6 decision.** The
earlier argument was that a bare "Zone C" removes information without removing
the claim, and that logging the names here was enough. It was not, for a reason
that is obvious once stated: **a partner opening the floor plan does not read
this file.** They read "Audit Floor", and they either believe something untrue
about their own office or notice it is wrong and start doubting the rest of the
screen — including the parts that are right, which is most of it. A label nobody
can audit from the screen it appears on is not orientation, it is an unmarked
guess.

**So the question goes back to the only people who can answer it**, reworded
from a disclosure problem into a request, and it is in `OPEN-QUESTIONS.md`:

> **Do wings C and D correspond to specific teams or functions? If so we will
> label them.**

Nothing is lost by asking. The information was never ours to state, and the
answer is one line typed into Admin → Settings rather than a deploy.

**A and B keep their names because those are drawing-derived** — A's boardroom
and four meeting rooms are tagged and PAX-counted on the sheet, and B's zero
PAX, zero workstation hatch and the castors note make it the flexible room.
Lumping all four together as "labels only", as this entry did before Phase 6, is
what let a wrong one sit unexamined for five phases.

### A12 — Seat types per bay

**Assumed:** PA/PD → `passage`; A1, A2, D5 → `cabin`; C7 → `foldable`; the rest
`workstation`.
**Affects:** `src/lib/seed-data/inventory.ts` → `seatTypeForBay()`. The `cabin`
and `passage` calls follow the drawing; **`foldable` for C7 is a guess** made so
the enum has a live example.

### A13 — One blocked desk (PD-18)

**Assumed:** one desk out of service, so the "blocked" status has a live example
and analytics has to cope with capacity below the raw seat count.
**Affects:** `scripts/seed.ts`. Entirely invented.

### A14 — Staff names and teams

**Assumed:** 141 generated Mumbai-plausible names across six practice teams.
**Affects:** `src/lib/seed-data/names.ts`, `inventory.ts` → `TEAMS`.
Not real people. Superseded by the HR list in A1.

### A15 — Seat plan coordinates

**Assumed:** a temporary grid, bays in rows of three.
**Affects:** `scripts/seed.ts` → `buildSeats()`. **Known temporary** — Phase 2
replaces both columns from the CAD extraction in `tools/cad/`. Not a real open
question, listed so nobody mistakes the grid for the floor.

---

### A17 — 🔴 If the meeting rooms are already Outlook room mailboxes, we have recreated the double-booking problem through the back door

**The problem, plainly.** This product now enforces one booking per room per
time range, in the database, with an exclusion constraint that cannot be raced.
That guarantee holds for bookings made **through this app**. It says nothing
about a meeting booked in Outlook.

If Boardroom, Conference A and the rest exist as **room resource mailboxes** —
and in a Microsoft 365 tenant they almost certainly do, because that is how
anybody books a room from the Outlook calendar picker today — then staff will go
on booking them the way they always have. Our grid will show the hour as free.
Somebody will book it. Two groups will arrive.

That is not a smaller version of the problem CBVA asked us to solve. It is the
same problem, made harder to diagnose, because now there are two systems each
confident they are correct.

**What Phase 3 built, and what it does not do.** `CalendarSync.upsert()` writes
our booking out to the calendar, and the retry job makes sure it gets there even
if Graph is down. So Outlook will know about **our** bookings. Nothing tells us
about **theirs**. The sync is one-way, and a one-way sync cannot prevent a
conflict — it can only announce one.

**Affects:** `src/lib/rooms/service.ts`, `src/lib/adapters/production.ts`
(`GraphCalendarSync`), `meeting_rooms.outlook_resource_email` — which is still
null on all six rows, so nothing can be wired until A3 is answered.

**What we need from CBVA — one of these two, and it is their choice:**

1. **Exclusive booking rights.** The room mailboxes are configured so that only
   this application's service account may book them; everyone else is directed
   here. Simplest to build, and the only option that makes our constraint the
   actual truth. It costs staff the Outlook room picker they are used to.
2. **Two-way sync.** We subscribe to Graph change notifications on each room
   mailbox and mirror external bookings into `room_bookings` before showing the
   grid. Keeps Outlook working, but the guarantee weakens from "impossible" to
   "usually caught quickly" — a race between an Outlook booking and ours is
   resolved by whoever Graph tells us about first, which is not a constraint,
   it is a reconciliation.

**Until one is chosen, the honest position is that room double-booking is
prevented among people using this app and not prevented generally.** The desk
booking guarantee is unaffected — desks have no second system.

---

### A18 — Office hours for the room grid

**Assumed:** 08:00–20:00, in `settings.office_hours`.

**Affects:** `src/lib/settings.ts`, `src/lib/rooms/validation.ts`, and the
columns the grid draws.

Nobody has told us when the floor opens or closes. The range is wide enough not
to obstruct anybody and narrow enough that a range outside it is obviously a
mistake rather than a 3 a.m. meeting. It bounds the grid and is enforced at the
Zod layer (edge case 15).

---

### A19 — A QR check-in proves a booking, not a body in a chair

**Assumed:** scanning the sticker on a desk, while signed in and holding that
desk for the running slot, is good enough evidence that the desk is in use.

**Affects:** `src/app/checkin/[seatCode]/page.tsx`, `src/lib/qr.ts`, and every
occupancy figure that counts `checked_in`.

**Stated honestly, because analytics is the product.** The URL is printed on a
desk in an open-plan office, so it is not a secret and is not treated as one —
identity comes from the session. Somebody at home who knows the seat code and
holds that booking could check in without being in the building. Nothing in this
flow prevents that.

What it does establish is stronger than the alternative: a door swipe proves
presence on the floor but says nothing about which desk, and desk-level
occupancy is the number CBVA is commissioning. `bookings.check_in_method` records
which kind of evidence each check-in is (`qr`, `badge`, `app`, `admin`) so the
two are never blended.

**The strong pair is both.** A badge swipe at the door plus a QR scan at the
desk gives presence *and* location, and the schema is ready for it today. That
needs A-block: the badge vendor and export format are still unknown.

---

### A20 — When check-in opens

**Assumed:** `settings.check_in_opens_minutes_before` = 30.

**Affects:** `src/lib/booking/rules.ts` → `checkInOpensAt()`, the QR page and
the badge handler.

Somebody arriving twenty minutes early should be able to sit down and scan.
Somebody scanning the previous slot's desk at lunchtime should not accidentally
check in to the afternoon. Thirty minutes is a guess at where that line sits.

---

### A21 — The cut-off governs changes, not bookings

**Assumed:** `settings.cutoff_minutes` (60) closes **edit and cancel**. It does
not stop somebody booking a desk for a slot that has already started, and it
does not apply at all to a booking that has already been checked into.

**Affects:** `src/lib/booking/service.ts` (`createBooking`, `cancelBooking`),
and the disabled states on `/bookings`.

Two rules we had to invent, because the brief defines the cut-off only for edit
and cancel:

- **Booking late is allowed.** Extending the cut-off to creation would break the
  case the product most needs to support — somebody who came in unexpectedly, or
  somebody whose desk was just auto-released being told by our own email to
  "book another desk from the floor plan" and finding they cannot. What *is*
  refused is a slot that has already finished.
- **Cancelling after check-in is always allowed.** Check-in only happens after a
  slot starts, so it is always after the cut-off; without this carve-out edge
  case 5 is unreachable. And it is the right behaviour anyway — releasing a desk
  you are leaving hands the rest of the slot back to the floor.

Both are cheap to reverse if CBVA disagrees; both are settings-adjacent
behaviour rather than settings values, so changing them is a code change.

---

### A22 — ✅ CLOSED in Phase 5 — the auto-release job now has a blast radius bound

**Assumed:** that the clock the job reads is always sane, so an unbounded
`UPDATE` over every expired booking is safe.

**Affects:** `src/lib/booking/auto-release.ts` → `runAutoRelease()`,
`src/app/api/cron/jobs/route.ts`, `settings.demo_offset_seconds`.

**This is not hypothetical. It happened during Phase 3.** A test drove
`runAutoRelease` from a `FixedClock` set to January 2099. From that clock's point
of view every real booking in the seeded database had finished decades earlier,
so the job did exactly what it is built to do: **577 bookings were settled as
`completed_no_show` and the demo floor was emptied**, in one run, with no
confirmation and nothing to stop it. It was caught because the floor plan looked
wrong afterwards, not because anything complained.

**Why the current fix is not enough.** `runAutoRelease` now takes an optional
`onlySeatIds`, and the tests pass it. That closes the test hole and nothing else
— production never sets it, and the three transitions are still unbounded
`UPDATE`s with no `LIMIT`, no dry run, and no sanity check on the clock:

```
confirmed, grace expired, slot running   -> auto_released
confirmed, past ends_at                  -> completed_no_show
checked_in, past ends_at                 -> completed
```

**The production failure modes this leaves open**, none of which need a test to
reach:

1. **A bad `demo_offset_seconds`.** It is an `integer` column with no bound, set
   by `POST /api/clock` which accepts any `z.number().int()`. One fat-fingered
   value — or one demo left running with a large offset — and the next cron tick
   settles every future booking in the database. `APP_MODE=production` uses
   `SystemClock` and ignores the offset, so this is a demo-and-staging risk
   rather than a live one, but demo data is what CBVA will be shown.
2. **Server clock skew.** In production the job reads the system clock. A host
   that comes back from suspend, or a container with a wrong clock, has the same
   effect and no offset to blame.
3. **A settings edit.** `auto_release_minutes` accepts 5–720 today. Nothing
   stops it being set far below a slot length, which would release most of a
   floor within minutes of every slot start.

In all three the job is behaving correctly and the *input* is wrong — which is
exactly the case a bound is for.

**BUILT IN PHASE 5.** All three, plus the cause:

- **A batch cap**, `settings.auto_release_batch_cap`, default 250. When it
  trips the transition applies **NOTHING** — not a partial batch. That is the
  part worth defending: a plain `LIMIT 250` would have settled the 577 rows over
  three cron ticks instead of one, which is the same catastrophe three minutes
  slower and indistinguishable from normal operation in the audit log. A bound
  that only slows a runaway down is not a bound. A trip writes an
  `auto_release_capped` audit row and surfaces on `/admin/jobs`.
- **A horizon**, `settings.auto_release_horizon_days`, default 3. Anything older
  is left alone and COUNTED, so a backlog is visible rather than silently
  ignored, and cleared deliberately from `/admin/jobs`.
- **A dry run**, threaded through `runScheduledJobs` → `runAutoRelease` and
  `materialiseSeries`, exposed at `POST /api/cron/jobs?dryRun=1` and rendered on
  `/admin/jobs` as "what the next run would do".
- **The cause, fixed at source.** `demo_offset_seconds` is CHECKed to ±30 days
  in the database and clamped at `POST /api/clock`, which previously accepted
  any `z.number().int()`. No downstream bound can fix a bad clock, because from
  a bad clock's point of view the job is behaving perfectly.

**One thing the bound does NOT fix.** If CBVA moves to hourly slots the
legitimate volume of a single run quadruples and the default cap becomes wrong —
see A26.

**Why it is 🟠 and not 🔴.** Nothing built so far is wrong, the live rule is
correct, and `APP_MODE=production` does not read the demo offset. But the
analytics is the deliverable, and a job that can quietly rewrite thousands of
rows of attendance history is the one piece of this product that can corrupt the
number CBVA is buying — silently, and in a direction (more no-shows) that looks
plausible rather than obviously broken.

---

### A23 — 🟡 Every vertical dimension in the 3D view is invented

**Assumed:** walls 2.7 m, partitions 1.35 m, glazing 2.7 m, desks 0.74 m high
and 1.30 × 0.75 m, chairs 0.45 m to the seat. Wall extrusion widths are 70 mm
for structure, 55 mm for partitions and 40 mm for glazing.

**Phase 6 added four more, and one classification rule.** Static furniture
heights: tables 0.74 m, seating 0.42 m, planters 0.5 m, modular 0.9 m. They only
have to be plausible and *different enough that a table does not read as a
planter*.

The rule is sharper than the numbers and worth stating: inside
`F-LOOSE FURNITURE` a longest side of **40 plan units (2.82 m)** separates
`table` from `seating`. A boardroom table and a visitor's chair are on the same
CAD layer and the drawing does not label them, so something had to decide.
Nothing anybody sits on is 2.8 m long, which is why the threshold is safe in one
direction — but it is a guess, and one known consequence is that Zone B's
storage credenza run comes out as a 16.7 m "table": right shape, right height,
wrong noun.

**Affects:** `src/components/floor-plan/three/coords.ts` → `DIMENSIONS`.

**Why it matters:** the drawing is a plan. It carries no section, no ceiling
height and no furniture schedule with dimensions, so nothing in it says how tall
anything is. The plan dimensions are real — `mmPerUnit` is recovered from the
plot scale and the floor is 90.66 × 68.44 m — but every height on screen is a
plausible office number rather than a measured one.

Two of them are load-bearing rather than decorative. **Partition height decides
what you can see over**, which is the entire reason the shell is split into
three classes; set it to 2.7 m and the open-plan wings become a warren. And
**wall extrusion width is not wall thickness**: CAD draws both faces of a wall
as separate lines, so each face is extruded and the pair together makes the wall
read at the right width. Extruding each at a nominal 150 mm stacked them into
something twice the width of the line underneath, which is exactly what the
first render showed.

**What we need from CBVA:** a section or a ceiling height, and confirmation that
the desk-height partitions really are desk height. Three numbers change and
nothing else does. This is 🟡 because being wrong here looks slightly off rather
than producing a wrong booking or a wrong occupancy figure. Precedent: A15.

---

### A24 — 🟡 PARTLY CLOSED in Phase 5 — the eleven no longer overlap, but they are still inferred

**Assumed:** the eleven anchors Phase 2 could not detect — `C1-06`, `C3-08`,
`C3-09`, `C6-08`, `C6-09`, `C7-04`, `PA-16`, `D1-08`, `D1-09`, `D7-04`, `D8-04`
— are in roughly the right place.

**Affects:** `src/data/floorplan/seats.json`, produced by `interpolate()` in
`tools/cad/build_floorplan.py`; visible in
`src/components/floor-plan/three/seats.tsx`.

**Why it matters:** they are not. The 3D view found this, which is a fair
illustration of why building it was worth doing. Interpolated desks are spaced
by dividing up the bay rather than by the drawing's measured 1.62 m workstation
pitch, so fifteen pairs sit closer than the 1.30 m a desk is wide. The worst is
**C7-04, 6 cm from PA-15** — effectively the same desk drawn twice.

On the 2D plan, two anchors 6 cm apart on a 90-metre floor are the same pixel at
fit-to-floor zoom, so this has been on screen since Phase 2 and was invisible.
Two solid desks 6 cm apart are not.

**The overlap set is exactly the interpolated set, and that is the good news.**
Checked rather than assumed:

| | |
|---|---|
| pairs closer than 1.30 m | **15** |
| of those, detected + interpolated | 11 |
| of those, interpolated + interpolated | 4 |
| of those, **detected + detected** | **0** |
| closest detected-to-detected pair anywhere | **1.357 m** — clear of a desk |
| interpolated anchors *not* in a collision | **none** |

So the eleven inferred anchors are the entire problem, and all eleven of them
are a problem. The 130 detected anchors do not collide with each other at all;
the eight that appear in the table above are victims, each with an interpolated
neighbour placed on top of it. Detection is sound and needs no re-examination
before Phase 5 — this is bounded, known, and fixable by hand.

**What it does and does not affect.** This is visual and interaction, not
numerical. Nothing about booking: all 141 desks exist, are individually
bookable, and every constraint holds — this is where a desk is *drawn*, not
whether it is real. Seat identity and occupancy counts are untouched, so unlike
A1 and A16 it does **not** gate Phase 5's analytics.

It does gate the **demo**. Two desks at one pixel means a click resolves
ambiguously, and the person clicking is a partner watching for the first time.
Treat it as a pre-demo fix.

**Ours, not theirs.** A24 is deliberately not part of the client trio (A1, A16,
A17). Those are questions only CBVA can answer; this is a defect we introduced
and can fix ourselves — we need somebody who knows the floor for fifteen
minutes, not a decision.

**WHAT PHASE 5 DID.** `scripts/fix-interpolated-anchors.mjs` re-places each of
the eleven by continuing its bay's own axis from the last DETECTED desk in that
bay, stepping at the drawing's measured pitch (23.02 plan units = 1624 mm, from
`meta.json`'s scale note), then relaxing a step at a time until clear of every
desk on the floor — not just its own bay, because C7 runs straight at the PA
passage. Fifteen colliding pairs to zero, all eleven verified by
point-in-polygon to still sit inside their declared zone, and
`tests/unit/floorplan-geometry.test.ts` holds the committed file to it.

**They are still flagged `interpolated`, NOT `manual`, deliberately.** This
stops them overlapping; it does not make them right. The drawing genuinely does
not say where these chairs are, and marking them as a human correction would
claim a confidence nobody has and quietly close a question that is still open.
The demo risk is gone — no two desks share a pixel and a click resolves
unambiguously — and the accuracy question remains.

**How it gets closed properly.** `/admin/floor-plan` exists for exactly this (ADR-017):
drag the eleven, and the export writes them back to `seats.json` marked
`manual`, surviving `npm run db:reset` and arriving in a reviewable diff. That is
fifteen minutes with somebody from CBVA who knows the floor, and it is a better
answer than a cleverer interpolator, because the drawing genuinely does not say
where these eleven chairs are.

**PHASE 7 FOUND THAT LOOP HALF BROKEN, AND FIXED IT.** A correction survived
`npm run db:reset`, because the seed reads `seats.json` — and was silently
DISCARDED by the next `npm run build:floorplan`, which regenerated every anchor
from the PDF and knew nothing about `manual`. So the one route to closing this
entry was undone by an ordinary rebuild, with nothing reported. That is the
Phase 6 trap in its other direction, and it means A24 has been harder to close
than it looked for two phases.

`build_floorplan.py` now preserves a `manual` anchor verbatim — position,
rotation and flag — and fails loudly if one exists for a seat code the schedule
no longer has. Detected and interpolated anchors are still always regenerated,
because those are the drawing's own answer; a human correction outranks an
inference, which is the entire point of the editor.

Verified end to end rather than argued: C7-04 moved and marked `manual` survived
a full rebuild byte for byte, the de-collide relaxed the other eleven around it
(13 colliding pairs to 0), and it arrived in the database through `npm run seed`.

**So the remaining work is fifteen minutes of somebody's attention, and nothing
else.** The editor badges all eleven, the export writes them back, the rebuild
keeps them, and the reseed carries them into the database.

Deliberately **not** fixed by nudging the geometry in the renderer. A desk drawn
somewhere it is not is a data problem, and hiding it in one view would leave the
2D plan, the list view and Phase 5's analytics still wrong.

---

### A25 — 🟠 A no-show that was never released is counted as consuming its whole slot

**Assumed:** a `completed_no_show` booking — somebody claimed a desk, never
turned up, and the slot ended before the grace window could release it —
consumed the FULL slot in the seat-hours measure.

**Affects:** `src/lib/analytics/measures.ts` → `seatHoursConsumed`, and every
seat-hours figure on `/admin/analytics`.

**Why we chose it.** The row sat inside `seat_slot_unique`'s predicate from
`starts_at` until the job settled it, so nobody else could book that desk for one
second of that slot. If a no-show were free, the analytics could not answer
"what do no-shows cost us in desks", which is one of the questions the product
exists to answer.

**Why it is still an assumption.** It produces an asymmetry that is real but not
obviously fair: an auto-released no-show costs the grace window (2 hours), and a
`completed_no_show` costs the whole slot (4 hours) — and the ONLY difference
between them is whether the grace window happened to expire before the slot
ended. Somebody who fails to show up for a 30-minute slot is charged 30 minutes;
somebody who fails to show up for a 4-hour slot is charged 4 hours.

**Mitigated rather than hidden.** `seatHoursIfNoShowWereFree` computes the other
accounting over the same filters, and the CSV export carries both columns. The
gap between them is itself reportable — it is the cost of no-shows. CBVA can
pick without anything being rebuilt.

---

### A26 — 🟠 The auto-release grace window is a constant, and it should probably be a fraction of the slot

**Assumed:** `settings.auto_release_minutes` (120) is independent of slot length.

**Affects:** `src/lib/booking/auto-release.ts`, and — through it — which
terminal status every no-show lands in.

**The cliff.** At the seeded half-day slots (4 hours) a no-show is released
after 2 hours and settles as `auto_released`. **If CBVA moves to hourly booking
— which ADR-020 deliberately makes a settings change — the grace window becomes
LONGER THAN THE SLOT.** Auto-release then becomes unreachable: by the time the
window expires the slot is over, and every no-show settles as
`completed_no_show` instead.

Nothing breaks. No error appears. The feature silently stops existing, every
no-show starts costing a full slot instead of a partial one (A25), and the
seat-hours figure jumps for a reason nobody will connect to a settings change
made weeks earlier.

**What to do about it.** Either express the grace as a fraction of slot length,
or validate on save that it is meaningfully shorter than the shortest slot. The
settings screen currently warns in prose; it does not enforce.

`tests/integration/hourly-slots.test.ts` is the natural place to catch this,
since it already proves the whole lifecycle on a slot key that did not exist
when the code was written.

---

### A27 — 🟡 Capacity is not sound across a slot-definition change

**Assumed:** that slot definitions do not change mid-period, or that nobody
looks at a report spanning the change.

**Affects:** `src/lib/analytics/queries.ts` → `capacityByDaySlot`, and any
utilisation percentage over a range containing a settings edit.

**The mechanism.** `updateSettings()` backfills the derived bounds of LIVE
bookings only (ADR-021) — terminal rows keep the bounds they were written with,
correctly, because that is what actually happened. But `capacityByDaySlot`
computes slot length from the CURRENT definitions. So after a change, historical
numerators use the old slot length and historical denominators use the new one.

**Why it is 🟡 today.** Slots have never changed, the blast radius is one report,
and both halves are individually correct — it is only their ratio that is
mixed. It becomes material the moment CBVA edits a boundary (A4) or moves to
hourly (A26).

**The fix, when it is needed:** a small `slot_history` table written by
`updateSettings`, recording the length of each slot key over a date range, and
joined by the capacity query instead of the live definitions. Until then any
report spanning a slot change needs an as-of caveat.

---

### A28 — 🟡 The seeded check-in method mix is invented

**Assumed:** roughly 62% of check-ins are by desk QR, 26% by door badge and 12%
in the app.

**Affects:** `scripts/seed.ts`, and the QR-versus-badge split shown in the
analytics.

Before Phase 5 `check_in_method` was NULL on every seeded row, which made A19's
whole argument unqueryable — the distinction between desk-level and floor-level
evidence existed only as a column comment. The column is now populated so the
analytics can demonstrate the split, but **the proportions are a guess about
human behaviour, not a measurement**. The real ratio depends on where the badge
readers are and whether people habitually scan the sticker in front of them;
neither is known. The distinction between the two is real; these particular
numbers are illustrative.

---

### A29 — 🟡 `#B88A00` on `F-FURNITURE HATCH` is 1,148 paths and we do not know what it denotes

**Assumed:** it is the legend's **corian** finish, on the strength of the other
four `F-FURNITURE HATCH` colours mapping to named finishes and this being the
only one left unaccounted for.

**Affects:** `tools/cad/texture.py` → `MUTED`, where it is muted to `#A98B3E`.

**Why it is logged now rather than left.** Phase 6 found it and recorded it as
a curiosity — "nothing here depends on it". Phase 7 changed that: the texture
now paints every path in the drawing's own colour, so **1,148 paths of it are
visible on screen** in a colour we chose for something we have not identified.
A finish we guessed wrong is a wrong colour on the plan, which is cosmetic, but
it is no longer invisible and so it is no longer nothing.

**What is actually known:** 1,148 paths, on `F-FURNITURE HATCH`, inside the
building. It is not in the legend extract we hold. That is the whole of it —
this is a one-line record, not an investigation, and it is deliberately not
worth more than that until somebody at CBVA has a reason to care.

**Where the answer goes:** one entry in `MUTED`. Nothing else reads it.

### A30 — 🟡 "Managers and above" for meeting rooms is read as Manager, Director and Partner grades — not HR/IT admin staff

**Decided by CBVA (Oct 2026):** meeting rooms are bookable by Managers and
above. **Assumed by us:** that means the Manager, Director and Partner *grades*.
HR/IT admin staff (`admin_staff` grade, even with `is_admin`) can **not** book
rooms. They can still cancel somebody else's room booking, as before.

**Affects:** `src/lib/booking/authorise.ts` → `ROOM_BOOKING_GRADES` /
`canBookMeetingRooms()`; enforced in `src/lib/rooms/service.ts`, surfaced as a
read-only grid in `src/app/rooms/rooms-client.tsx`.

**Why it's worth confirming:** HR and admin teams often book the boardroom for
interviews, inductions and client visits. If CBVA expects them to, add
`admin_staff` to `ROOM_BOOKING_GRADES`. That is a one-line change, and the
tests in `tests/unit/booking-rules.test.ts` and
`tests/integration/room-rules.test.ts` say which way it is set.
