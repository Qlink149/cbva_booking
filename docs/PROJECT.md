# Workspace — living spec

CBV & Associates LLP, Mumbai. Office seat and meeting room booking.

Keep this current. It describes what the product **is**, not what has been
built — the `PHASE-N-HANDOFF.md` docs cover the latter.

---

## 1. The problem

CBVA runs a one-day-a-week work-from-home policy. Two consequences:

1. Desks sit empty on an unpredictable pattern, and nobody knows which.
2. The firm cannot forecast next-day capacity, so it cannot tell whether it is
   paying for more desks than it needs.

Booking is the instrument, not the goal. **The deliverable is the occupancy
analytics that lets partners right-size desk count against headcount.** Every
design decision is judged against whether it produces trustworthy occupancy data.

## 2. Who uses it

| Grade | Seat | Uses the product to |
|---|---|---|
| Partner | Fixed | Read the analytics. Book meeting rooms. |
| Director | Fixed | As above. |
| Manager | Fixed | Book rooms. |
| Assistant Manager | **Books** | Book a desk for each day in office. |
| Article | **Books** | Same. The largest group — 62 of 141. |
| Admin / HR / IT | Fixed | Manage seat inventory; read analytics. |

Floor 4 today: **141 desks, 141 people, 47 fixed / 94 who must book against 93
bookable desks** (one of the 141, PD-18, is blocked — out of service) — supply
and demand are close but not exactly balanced: 94 people against 93 desks is
one short, not the round number it looks like at a glance. The Manager/
Assistant Manager split that produces the 94 is an assumption (ASSUMPTIONS A1);
see `docs/OPEN-QUESTIONS.md` for the full range this could actually be.

## 3. Core rules

- A desk is booked for a **slot**. The slots are **data**, not a fixed pair:
  `settings.slot_definitions` is an ordered list of named time ranges, seeded as
  AM 09:00–13:00 and PM 13:00–17:00. A full day is two bookings on the same
  desk. Moving the firm to hourly booking is a settings change (ADR-020).
- **One active booking per desk, per date, per slot.** Enforced by the database.
- **One desk per person, per date, per slot.** Also enforced by the database,
  and keyed on the *occupant* — booking a second desk for yourself is
  refused (ADR-022). Nobody books on somebody else's behalf: CBVA had it
  removed in Oct 2026 (ASSUMPTIONS A7).
- Cancelling or auto-releasing frees the slot **without deleting the row** — the
  history is the analytics.
- **Auto-release**: a booking not checked into within the grace window
  (`settings.auto_release_minutes`, 120) is released back into the pool
  automatically and marked `auto_released`. Past the slot it settles to
  `completed_no_show`.
- **Check-in** comes from a badge swipe at the door (`badge_events`), from a QR
  code on the desk, or from the app, and `bookings.check_in_method` records
  which. Check-in is what turns a booking into evidence of occupancy — an
  un-checked-in booking is a claim, not a fact, and the analytics must keep the
  two apart. It must also keep the *kinds* of evidence apart: a door swipe
  proves somebody reached the floor, a desk QR proves they used that desk.
- **The cut-off** (`settings.cutoff_minutes`) closes edit and cancel before a
  slot starts. It does not stop somebody booking a desk mid-slot — that is how
  an auto-released desk gets used — and it does not apply to a booking somebody
  has already checked into, because releasing a desk you are leaving hands the
  rest of the slot back to the floor.
- Meeting rooms are booked as **arbitrary time ranges**, not slots. Overlaps are
  rejected by the database.
- Weekends and rows in `holidays` are not bookable.

## 4. Data model

12 tables. Full DDL in `drizzle/`, schema in `src/lib/db/schema.ts`.

```
floors ─┬─ zones ── seats ── bookings ─┬─ users
        └─ meeting_rooms ── room_bookings
users ── badge_events
bookings/room_bookings ── notification_log
holidays · settings (singleton) · audit_log
```

Load-bearing details:

- `seats.plan_x` / `plan_y` / `rotation_deg` are in **plan coordinate space**,
  not pixels, and come from the architect's drawing via
  `npm run build:floorplan`. `src/data/floorplan/seats.json` is the source of
  truth; the seed reads it and `/admin/floor-plan` writes back to it. One plan
  unit is 70.5556 mm (the drawing plots at 1:200).
- `seats.status` (`bookable`/`fixed`/`blocked`/`decommissioned`) is the desk's
  own state. The seven **visual** statuses are a different, richer vocabulary —
  they combine seat status with the viewer's relationship to a booking.
- `bookings.booked_by_user_id` vs `occupant_user_id` — always the same for new
  bookings (book-on-behalf was removed, Oct 2026), but different on historical
  on-behalf rows, which are kept. Analytics must count the **occupant**.
- `badge_events` is a stub with no feed behind it, modelled now so a real reader
  webhook lands later with no schema change.
- `settings` is a singleton, enforced by a unique index on `((true))`.

## 5. Integrations, none of them connected

| Interface | Production target | Blocked on |
|---|---|---|
| `AuthProvider` | Microsoft Entra ID | Tenant app registration |
| `MailProvider` | Graph `sendMail` | `Mail.Send` consent + service account |
| `CalendarSync` | Graph `/events` | Room resource mailbox list — **and a decision about who owns room booking, see A17** |
| `CheckInSource` | Badge reader webhook | Vendor and export format unknown |

Each has a demo implementation good enough to demonstrate the whole flow and a
production stub that throws with a TODO naming the exact wiring. `APP_MODE`
selects between them in one file.

## 6. Time

Everything is reasoned about in **Asia/Kolkata**. Business logic reads time from
a `Clock`, never from the system — see the clock rule in `CLAUDE.md`. This is
what lets the demo advance the clock and have the real auto-release job produce
a real release.

## 7. Design principles

1. **Analytics is the product.** If a decision makes booking marginally nicer
   but occupancy data less trustworthy, it is the wrong decision.
2. **Professional services, not consumer SaaS.** Hairlines, 4px radius, no
   gradients, no shadows. It should look printed.
3. **Gold is rationed.** Under 5% of pixels, three sanctioned uses.
4. **Colour is never the only cue.** Seven seat statuses, each with a border
   treatment and glyph, verified desaturated on `/styleguide`.
5. **The database keeps its own integrity.** Race conditions are solved where
   they occur.
6. **Every assumption is written down.** Three questions are open with the
   client; `ASSUMPTIONS.md` is the list, with file references.

## 8. Roadmap

**Phase 1 — Foundation ✅**
Repo, pinned stack, design system, 12-table schema, both database constraints
with concurrency proofs, clock service, four adapters, realistic seed
(141 desks, 141 people, 45 working days of bookings), app shell, `/styleguide`.

**Phase 2 — CAD pipeline and 2D floor plan ✅**
`npm run build:floorplan` reads the 44 CAD layers with a stdlib PDF interpreter
and writes walls, zones, seat anchors and a baked texture into
`src/data/floorplan/`. 130 of 141 desks (92.2%) were located from the drawing's
own geometry by detecting the repeated chair block; 11 were interpolated and are
flagged as such. `/floor` renders the linework as one raster with 141 real
`<button>` seats over it, with pan/zoom, zone focus, a list view and the state in
the URL. `/admin/floor-plan` drags, rotates and retires desks and exports the
corrections back to the committed geometry.

**Phase 3 — Booking engine ✅**
Book, amend and cancel against the database constraints, with `23505` and
`23P01` handled as ordinary "someone just took that desk" outcomes. Editing is a
cancel-and-rebook inside one transaction, so a lost race leaves the original
booking intact. On-behalf booking for managers and above. Meeting rooms over
arbitrary ranges, with a one-way calendar sync that cannot lose a booking when
Graph is down. Auto-release as one conditional `UPDATE … RETURNING` per
transition — idempotent, concurrency-safe, and driven by the shared Clock, so
advancing the demo clock makes the real job run the real rule. Real QR check-in
at `/checkin/<seat_code>` with a printable sticker sheet. Eight notification
kinds as real HTML, queued inside the booking transaction and viewable at
`/admin/notifications`. ADR-007's `starts_at` drift is closed: editing slot
definitions backfills every affected booking in the same transaction.

The brief's eighteen edge cases are `tests/integration/phase3-edge-cases.test.ts`,
numbered to match. 139 tests, up from 83.

**Phase 4 — 3D floor plan** ✅
R3F v9 `mode="3d"` inside the existing `<FloorPlan>`, over the same seat array,
the same store and the same status vocabulary. The floor is the architect's own
baked drawing on one textured plane; the shell is `walls.json`, now split into
wall, partition and glazing and extruded as merged segment boxes; the 141 desks
and chairs are instanced primitives carrying booking status. 12 draw calls.
three and drei are lazily loaded, so `/floor` costs 6 kB more than it did.
Selecting a desk in 3D selects it in 2D, because it is one value.

**Phase 5 — Admin analytics and deploy** ✅
The deliverable. Three analytics screens over one measure vocabulary: Today
(live), Forecast (the next five working days, which CBVA said they have no way
to see) and Trends (eight weeks, the day-of-week pattern, and a bay heat map
against each bay's own desk count). **All three candidate occupancy measures
ship side by side** — seats booked, seats attended, seat-hours consumed —
because the auto-release accounting question is open and picking for the client
would put an invented assumption into a board pack. CSV export over the same
filters.

Five admin screens so that answering an open question is typing rather than
deploying: seat inventory, people, settings, the audit log (written since Phase
3 and read by nothing until now) and scheduled jobs. Three adoption features
against the risk that low contention means nobody bothers booking: who's in,
releasing an allocated desk, and recurring bookings. A22 closed — the
auto-release job is bounded, and the cap applies nothing when it trips.

⚠️ The headline number is still provisional. **A1** and **A16** together fix its
denominator, and the screen says so inline rather than presenting a confident
figure built on a guess.

Deployed at https://cbva-workspace.vercel.app.

**Phase 6 — Visual fidelity to the drawing ✅**
No seat identity, no seat count, no booking logic, no analytics. The partition
layer turned out to be 97% not partitions — 6,444 paths of which 200 are walls,
separable by stroke colour, which the PDF parser had been discarding. The shell
drops to 462 polygons with the envelope and every room divider intact. The
meeting rooms are the five the drawing actually shows (A3 25, A9 10, A8 7, A7 5,
A6 5) rather than six from a first reading, each carrying its bay code so the
plan and `/rooms` join on the architect's tag rather than on a name CBVA will
change. 318 pieces of static furniture — the boardroom table and its chair ring,
the meeting rooms, both lounges, the foldable tables, the credenzas — so the two
seatless wings stop reading as broken; none of it interactive, at four draw
calls. Room labels in both views say why those wings have no desks.

Two traps closed on the way: the "byte-identical" gate had been **vacuously
green** since Phase 5 (it compared two builds to each other, never to the
repository, while a rebuild silently reverted the A24 fix), and the drawing
confirms all 141 seats rather than 133 — the `8 PAX` on the A1/A2 run was being
skipped by the guard that keeps meeting-room capacities out of the desk count.

**One step did not ship.** Typing each seat as rapid-rail or screen-only against
the drawing's stated 93 and 4 does not reconcile — 34 of 141 anchors have no
hatch of any colour near them. The gate said nothing ships if it does not
reconcile, so nothing did. `PHASE-6-HANDOFF.md` §4 has the measurements.

**Phase 7 — Fidelity, level of detail, and the close ✅**
The plan texture now carries the drawing's own 29 colour combinations, 8 line
weights, mixed joins, fills and its **11 embedded photographs** — which a
vector-only extractor could not see at all, so their absence had been silent for
five phases. Ported into the existing stdlib parser rather than adopting the
PyMuPDF reference (ADR-046): no pip step, one parser feeding both the geometry
and the texture, and the audit's exact constants reproduce in both. One SVG per
raster width, because a zero-width PDF stroke means one DEVICE pixel and 62% of
this drawing is zero-width.

**Status LOD**, recommended in Phase 4 and never built (ADR-048). Past a
threshold both views stop drawing per-seat status — unreadable at that distance
in principle — and answer the density question per bay instead. The threshold
falls out of the marker size rather than being chosen. Draw calls went **down**,
16 → 13, because one merged plate mesh replaces up to six glyph meshes.

Three guards that had never been watched failing now have been: the CAD audit
(two ways), `prod:check` (three ways against a damaged throwaway database), and
the texture-contrast regression gate, which compares against the Phase 6 texture
and so distinguishes a regression from a figure that was already there.

Zones C and D stopped carrying invented names. A `manual` seat anchor now
survives `npm run build:floorplan`, which it did not — so the one route to
closing A24 was being undone by an ordinary rebuild.

**And one incident, caused and documented.** `next start` reads
`.env.production.local`, so Phase 6's own recommended way to run the e2e suite
against a production build points it at the **deployed database** — and passes
while doing it. Production came back with 65 of 95 desks auto-released. Repaired
with `prod:seed`, closed by `npm run start:local`. `PHASE-7-HANDOFF.md` §7.

240 tests, up from 215.

## 9. Open questions

See `ASSUMPTIONS.md`. The five that block real use:

1. **The HR list** — how the 54 CAs split Manager / Assistant Manager, and who
   holds an allocated seat. This sets the denominator for every number the
   product reports.
2. **Which physical desks are fixed**, so the plan shows the right ones reserved.
   Now visible: the plan draws 47 specific desks as reserved, in their real
   positions.
3. **The real meeting rooms** — 🟠 **partly closed in Phase 6.** The drawing
   gives five rooms and their capacities. Still needed: the names CBVA uses, and
   the Outlook resource mailbox for each.
4. **Who owns meeting room booking — this app, or Outlook?** If the six rooms
   already exist as Outlook resource mailboxes, staff will go on booking them
   from Outlook, our grid will show the hour free, and two groups will arrive.
   Our exclusion constraint is airtight for bookings made here and blind to
   bookings made there, and the calendar sync is one-way. CBVA has to choose
   exclusive booking rights for this app or two-way sync. Full statement in
   ASSUMPTIONS A17. **This is new in Phase 3 and it is the one that can
   embarrass the product in front of staff.**

5. **Is Zone B used as a workspace on a normal day?** 🟠 **Downgraded in Phase
   6.** Re-read at the vector level the wing has zero pax annotations, zero
   workstation hatch of either type, 714 foldable-table hatch paths and the
   drawing's own "foldable table on castors" note inside it — it is a flexible
   room, and the 33 unexplained chairs are explained. Still open, because a
   drawing cannot say whether staff work there daily; no longer load-bearing on
   the denominator, so the headline number can be finalised on a pool of 93 once
   question 1 closes. ASSUMPTIONS A16.
