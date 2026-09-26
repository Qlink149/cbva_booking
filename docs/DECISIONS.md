# Architecture Decision Record

Newest last. Each entry records what was decided, why, and what it costs.

---

## ADR-001 — Two Neon connection strings, pooled and direct

**Decision.** `DATABASE_URL` points at Neon's pooled PgBouncer endpoint and is
used by the Next.js runtime. `DATABASE_URL_UNPOOLED` points at the direct
endpoint and is used by drizzle-kit, the seed script and Vitest.

**Why.** The URL supplied was the pooled one. PgBouncer in transaction mode
hands each statement to whichever backend is free, which breaks DDL sequencing
(`CREATE EXTENSION` in particular) and makes "two transactions racing for the
same row" untestable — the concurrency tests are a Phase 1 acceptance criterion.

**Cost.** Two environment variables instead of one, and a rule to remember.
`src/lib/db/index.ts` exposes `db()` and `directDb()` so the choice is explicit
at the call site rather than ambient.

---

## ADR-002 — `pg` (node-postgres), not `@neondatabase/serverless`

**Decision.** Drizzle runs on node-postgres.

**Why.** The serverless driver multiplexes over HTTP/WebSocket and does not give
long-lived sessions with real `BEGIN`/`COMMIT` semantics. The constraint tests
need two independent sessions holding open transactions against each other.
Correctness proof beats cold-start latency at this stage.

**Cost.** No edge runtime for database routes. Acceptable — this is an internal
tool for one office in one timezone.

**Revisit if** the app is ever deployed to edge functions.

---

## ADR-003 — Both integrity rules live in the database

**Decision.** `seat_slot_unique` (partial unique index) and `no_room_overlap`
(GiST exclusion constraint) are hand-written SQL in
`drizzle/0001_constraints.sql`. **No app-level pre-check exists anywhere.**

**Why.** An application "is this seat free?" check has a race window between the
read and the write. Two people tapping Book at the same moment is exactly the
case that must not double-book, and it is exactly the case a pre-check misses.
Postgres closes the window for free.

Both are **partial**: only `confirmed`/`checked_in` bookings and `confirmed`
room bookings participate. A cancelled booking therefore frees the slot while
its history survives, which analytics depends on — a deleted no-show is a
no-show that never happened.

**Cost.** Drizzle cannot express either, so `0001_constraints.sql` is
hand-written and hand-registered in `drizzle/meta/_journal.json`. Any future
`drizzle-kit generate` must not clobber it. The insert path must handle `23505`
and `23P01` as ordinary user-facing outcomes ("someone just took that seat"),
not as 500s — that is Phase 3's job.

**Proven by** `tests/integration/*.test.ts`, including two concurrent-session
tests that assert the loser blocks and then fails.

---

## ADR-004 — Supporting constraints the brief did not ask for

**Decision.** Added alongside the two required ones:

- `CHECK (ends_at > starts_at)` on both `bookings` and `room_bookings`.
- `seats_assigned_user_unique` — a seat is allocated to at most one person.
- `settings_singleton` — a unique index on `((true))`, so the settings table
  cannot grow a second row.
- `users.fixed_seat_id → seats.id`, added here because `users` and `seats`
  reference each other and one direction has to come after both tables exist.

**Why.** The range check is not decorative: an empty or inverted range
(`starts_at = ends_at`) overlaps nothing by definition and slips straight past
the exclusion constraint. Without the CHECK, a zero-length meeting is a legal
way to double-book a room. The singleton index matters because `DemoClock` reads
`settings` with `LIMIT 1` and would silently pick an arbitrary row.

---

## ADR-005 — The demo clock offset lives in the database

**Decision.** `settings.demo_offset_seconds`, a column the brief did not name.
`DemoClock` takes the offset as a constructor argument and stays synchronous and
pure; `getClock()` reads it server-side, and the browser reads it from
`GET /api/clock`.

**Why.** The offset has to be shared between server and client — otherwise the
server thinks a slot has started and the browser does not — and it has to
survive a page refresh and a server restart. In-memory state fails both.

**Cost.** A database round-trip per `getClock()`, and the offset is global (see
ASSUMPTIONS A10).

---

## ADR-006 — ESLint errors on `new Date()`, rather than a convention

**Decision.** `no-restricted-syntax` errors on zero-arg `new Date()` and
`Date.now()` across `src/**`, `scripts/**` and `tests/**`, with an override for
`src/lib/clock.ts`, `scripts/**`, `tests/**`, `e2e/**`.

**Why.** The clock pattern only works if it is total. One stray `new Date()` in
an auto-release code path silently opts that path out of the demo, and the bug
appears as "the demo does not work" during a partner presentation. A convention
in a document does not survive five phases; a failing lint does.

**Verified.** A probe file containing both violations was added, observed
erroring with the custom messages, and removed.

---

## ADR-007 — `bookings.starts_at`/`ends_at` are stored derived columns

**Decision.** Built as the brief specifies, written from a single
`deriveSlotBounds()` in `src/lib/slots.ts`.

**The concern, stated plainly.** These are derived from `booking_date` + `slot` +
`settings.slot_definitions` at write time. The moment an admin edits a slot
boundary, every historical row silently disagrees with the settings that
supposedly define it — and analytics is the product, so silently wrong history
is the worst failure mode available.

**Why build it anyway.** The auto-release job needs to range-scan
`starts_at` cheaply, and a `timestamptz` index is the right tool. Deriving on
read would make the hot path a per-row timezone computation.

**Mitigation now.** Exactly one function computes them. **Fix in Phase 3:** make
editing `slot_definitions` trigger a backfill migration, or move to a generated
column. Do not add a second copy of the derivation.

> **✅ Closed in Phase 3 by ADR-021.** Editing `slot_definitions` now backfills
> every affected booking in the same transaction, and a change that would orphan
> a live booking is refused outright. The second copy of the derivation that had
> crept into `scripts/seed.ts` was deleted at the same time — there is one
> `deriveSlotBounds()` again, and `tests/integration/hourly-slots.test.ts` proves
> a moved boundary carries its bookings with it.

---

## ADR-008 — The seed rebuilds bookings rather than upserting them

**Decision.** Reference data (users, seats, zones, rooms, holidays, settings) is
upserted on its natural key via UUID v5 ids. Bookings and room bookings are
**deleted and regenerated** on every run. The script refuses to run when
`APP_MODE=production`.

**Why.** All randomness comes from a fixed-seed PRNG, so the output is
deterministic — but the *stream* shifts whenever the generator changes. During
development, tuning the attendance curve moved every meeting by an hour, and
stale rows from the previous stream collided with the new ones. The room
exclusion constraint caught it, correctly and loudly. Rebuilding makes a re-run
safe both after a code change and when run twice unchanged, which is what
"idempotent" has to mean in practice.

**Cost.** The seed is destructive to booking data. Guarded by the `APP_MODE`
check, and by the fact that no real booking exists yet.

---

## ADR-009 — Deterministic UUID v5 ids for seeded rows

**Decision.** Every seeded row's primary key is `uuidv5(naturalKey, FIXED_NS)` —
`uuidv5("seat|C3-04")`, `uuidv5("user|priya.shah@cbva.in")`.

**Why.** Makes `onConflictDoUpdate` possible on rows whose natural key is not
the primary key, keeps ids stable across re-seeds so a bookmarked URL survives,
and makes the seed diffable.

**Cost.** Seeded ids are guessable. Irrelevant for an internal tool behind SSO;
would matter if these ids were ever capability tokens.

---

## ADR-010 — Seat status is a component, not a colour map

**Decision.** `src/components/seat/seat-status.ts` holds the seven statuses with
their label, description, classes, glyph and screen-reader name.
`SeatSwatch` is the only thing that renders a seat.

**Why.** The brief requires statuses to be distinguishable without colour. That
guarantee is only as good as its weakest render, and Phases 2, 4 and 5 each draw
seats in a different medium (SVG plan, 3D mesh, table cell). One vocabulary,
imported everywhere, is the only way the guarantee survives.

`/styleguide` renders all seven normally **and desaturated, side by side**. That
comparison is the acceptance test — if two become indistinguishable there, the
fix belongs in `seat-status.ts`.

---

## ADR-011 — `motion`, and what `framer-motion` is doing in the lockfile

**Decision.** `motion@12.23.24` is the direct dependency; imports are from
`motion/react`. `framer-motion@12.43.0` appears in `package-lock.json`.

**Why it is there.** `motion` is the renamed successor to `framer-motion` and
re-exports it; the package depends on it internally. Nothing in `src/` imports
`framer-motion`, and it is not a direct dependency. This satisfies the brief's
"do not install framer-motion" — the package cannot be removed without removing
`motion` itself.

---

## ADR-012 — R3F v9 pinned now, three phases early

**Decision.** `three@0.182.0`, `@react-three/fiber@9.7.0`,
`@react-three/drei@10.7.8` installed in Phase 1 despite being unused until
Phase 4.

**Why.** As the brief asked: surface version conflicts today. R3F v8 does not
support React 19 and v10 is alpha, so v9 is the only viable line. Verified: the
three packages install against React 19.1 with no peer warnings and `npm run
build` passes.

**Cost.** ~55 unused packages in `node_modules`. They are not imported, so they
do not reach the client bundle.

---

## ADR-013 — Client state split: TanStack Query vs Zustand

**Decision.** Anything that lives on the server — bookings, seats, the clock,
the session — is TanStack Query. Zustand (`src/lib/store/ui.ts`) holds only
ephemeral UI state: the focused seat, the active slot tab, panel open/closed.

**Why.** The line blurs by default, and once server data is mirrored into
Zustand it starts drifting from the database. Phase 2's floor plan is where that
temptation appears.

**Corollary found in testing:** invalidating the Query cache does **not**
re-render server components. Mutations that change identity or time
(`useSwitchRole`, `useShiftClock`) must also call `router.refresh()`. Switching
role updated the header but not the page body until this was fixed.

---

## ADR-014 — Skills installed

`vercel-labs/agent-skills@web-design-guidelines` (as instructed),
`giuseppe-trisciuoglio/developer-kit@nextjs-app-router`,
`pedronauck/skills@drizzle-postgres`. The web interface guidelines were fetched
and built against directly — hence the skip link, `:focus-visible` rings,
`aria-live` on the role switcher, `tabular-nums` on number columns,
`text-wrap: balance` on headings, `autocomplete`/`spellcheck` on inputs,
`Intl.DateTimeFormat` for dates, and the `prefers-reduced-motion` block.

No useful accessibility skill was found for React/Radix specifically; the
dedicated accessibility pass is Phase 5 regardless.

---

## ADR-015 — The CAD reader is stdlib Python, not PyMuPDF

`tools/cad/extract_floorplan.py` proved that filtering the PDF's 44 optional
content groups gives exact geometry. Phase 2 needed three things from the
drawing — layer-tagged paths, layer-tagged text with positions, and the block
transforms — and all three are recoverable from the page content streams with
nothing but `zlib`.

So `tools/cad/cadparse.py` interprets them directly. The cost is ~350 lines of
PDF operator handling. The benefit is that `npm run build:floorplan` works on a
clean checkout with no pip step, which matters because the geometry is the one
thing in this repo that cannot be re-derived from anything else.

It is verified by reproducing the known per-layer path counts exactly (9,403 on
layer `0`; 6,444 partition; 6,053 furniture hatch; 165 wall; 57 column). A
parser that mishandled the graphics state would not land on those numbers.

---

## ADR-016 — Seats are detected from chairs, not desks

The obvious primitive is the desk. It does not work: a 9-pax bay is drawn as
one continuous run of hatched desktop, so clustering it yields a single blob
and shape-matching a "workstation module" has nothing repeatable to match.

Chairs do work. Each is a 7-point ~8pt block on layer `0` (AutoCAD block
geometry plots as layer 0), there is exactly one per seat, and they do not
touch each other. Filtering for that footprint yields **93** components — and
the drawing's own schedule reads *"Work Station with rapid rail… = 93 nos"*.
That agreement, arrived at from two independent directions, is what justified
building the rest of the pipeline on it.

Assignment to bays is a **globally greedy capacity-constrained match**, not
nearest-anchor per chair. Nearest-anchor let one bay tag act as a magnet for a
whole wing: A2 collected 22 chairs against a schedule of 4.

Result: 130/141 detected, 11 interpolated, no bay over its scheduled count.

---

## ADR-017 — `seats.json` is the source of truth for geometry, not the database

Seat position had to live somewhere that survives `npm run db:reset` and is
reviewable in a diff, but also had to be editable at runtime, because furniture
moves and detection is 92% right.

So: the build writes `src/data/floorplan/seats.json` and commits it; the seed
reads it; the editor writes the database live **and** exports back to the file,
marking moved seats `source: "manual"`. Fifteen minutes of dragging becomes a
committed artefact rather than a state one `db:reset` away from being lost.

The alternative — database wins after first insert — was rejected because the
corrections would exist only in whichever database happened to receive them.

`buildSeats()` reconciles the file against `BAYS` strictly and throws on any
mismatch, so a drift between the drawing and the inventory stops the seed rather
than quietly producing a floor with missing desks.

---

## ADR-018 — Seats use `aria-disabled`, never `disabled`

Non-bookable seats were originally `disabled`. An axe run and a keyboard test
showed the cost: `disabled` removes an element from the tab order, so arrow
navigation dead-ended at every booked desk, and a keyboard user could never
land on a reserved desk to hear whose it was.

Seats are now always focusable, carry `aria-disabled`, and guard inside their
own `onClick`. A seat you cannot book is still a seat you need to be able to
read.

---

## ADR-019 — The plan texture is one raster at 55% opacity

The wall layer is 8,603 paths and the furniture layer 49,342. Neither goes in
the live DOM; the drawing is baked to webp at build time and the only
interactive nodes are the 141 seats. `e2e/floor-plan.spec.ts` asserts fewer
than 50 SVG paths on the page so this cannot be quietly undone.

The opacity is not decoration. At fit-to-floor a desk is about 11px across, and
against full-strength CAD linework the seat chips are invisible — the first
screenshot review showed exactly that. The drawing is context; the seats are the
content, and the contrast between them has to say so.

---

## ADR-020 — `bookings.slot` is text; the slot vocabulary is settings data

**Decision.** The `slot` Postgres enum is dropped. `bookings.slot` is `text`, and
`settings.slot_definitions` is an ordered, zod-validated list of
`{key, label, start, end}`.

**Why.** The brief requires that moving CBVA from half days to hourly booking be
a settings change, not a refactor. A two-value enum makes that impossible —
`H09` is not a legal value, and adding eight of them is a migration plus a type
change plus every switch statement that reads it. Their own document says
"hourly"; the only worked example in it is a half day. We ship half days and
keep the door open, at the cost of one column type.

**Cost.** The database no longer polices the slot vocabulary, so `requireSlot()`
does, at the write boundary, with an error naming the legal values. Overlapping
definitions are the one thing no database rule catches — two slots covering the
same hour would let one person hold two desks for the same real time while both
partial unique indexes stayed happy — so `slotDefinitionsSchema` rejects
overlaps explicitly.

**Proven by** `tests/integration/hourly-slots.test.ts`, which reconfigures
settings and then runs book → check in → edit → cancel → auto-release against a
slot key that did not exist when the code was written.

---

## ADR-021 — Editing slot definitions backfills derived bounds, in the same transaction

**Decision.** `PATCH /api/admin/settings` recomputes `bookings.starts_at` and
`ends_at` for every live booking inside the same transaction that writes the new
definitions. If the new definitions drop a slot key a live booking still uses,
the change is **refused** with that list.

**Why.** This closes the concern ADR-007 left open. Those columns are derived at
write time and stored so the auto-release job can range-scan a `timestamptz`
index instead of re-deriving a timezone conversion per row. The cost was that
editing a boundary made every historical row silently disagree with the settings
that supposedly defined it — and since analytics is the product, silently wrong
history is the worst failure available. Either both move or neither does.

The refusal matters as much as the backfill: a booking whose slot key no longer
exists has no start time that could be computed for it. There is no correct
value to write, so the only honest options are to refuse or to destroy data, and
refusing is the one that can be undone.

**Cost.** A settings edit is O(live bookings) — a few hundred rows at CBVA's
scale. `scripts/backfill-slot-bounds.ts` runs the identical computation from the
command line for a database edited by hand.

---

## ADR-022 — `occupant_slot_unique`: one person, one desk, per slot

**Decision.** A second partial unique index, beside `seat_slot_unique`:

```sql
CREATE UNIQUE INDEX occupant_slot_unique
  ON bookings (occupant_user_id, booking_date, slot)
  WHERE status IN ('confirmed', 'checked_in');
```

**Why.** Edge cases 9 and 10 in the brief are the same rule seen from two sides
— a person may not hold two desks in one slot, and an on-behalf booking for
somebody who already has one must be refused. Keying on the **occupant** gives
the carve-out the brief asks for free: booking *for* a different person is a
different key, so it is allowed with no special case in the code.

It lives in the database for ADR-003's reason. An application "does this person
already have a desk?" check has a race window between the read and the write,
and two browser tabs is all it takes.

**Verified before adding.** The seeded database was queried first — zero
occupant/date/slot groups with more than one live booking — so the index went on
without touching data.

**Cost.** One more constraint name the insert path recognises. The conflicting
booking is fetched *after* the rejection, purely to put it in the error message.
That read is an explanation, not a pre-check.

---

## ADR-023 — Edit is cancel-and-rebook inside one transaction

**Decision.** Changing a booking's date, slot or desk is a conditional cancel
followed by an insert, in a single transaction, with an optimistic lock on
`updated_at`.

**Why.** Updating the row in place would have to move it through a state where
it holds neither desk, or both. Cancel-and-rebook keeps `seat_slot_unique`
protecting the user throughout: if the desk they are moving to is taken between
opening the dialog and pressing Save, the insert trips `23505`, the transaction
rolls back, and **the original booking is still theirs**. They never end up with
nothing.

**What the optimistic lock is actually for.** `updated_at` cannot distinguish
two writes that land inside the same clock tick — under a frozen demo clock,
every write shares an instant. The thing that genuinely makes concurrent edits
safe is the conditional UPDATE, which matches zero rows once somebody else has
moved the booking out of an active status. The timestamp's job is to get the
*message* right, which is why a stale write is classified by re-reading the row:
a booking a person cancelled is a conflict worth reloading, a booking the job
auto-released has ended, and "reload and try again" would be a lie.

The comparison is `date_trunc('milliseconds', updated_at)`. Postgres timestamps
carry microseconds; the value the client echoes back has been through
`Date.toISOString()` and lost them. Comparing raw would fail every edit of a row
written by the column's `DEFAULT now()`.

---

## ADR-024 — Two new booking statuses, because analytics reads statuses

**Decision.** `booking_status` gains `cancelled_after_check_in` and
`cancelled_by_admin`.

**Why.** The brief requires cancelling after checking in to be counted
separately from a plain cancellation (edge case 5), and cases 7, 8 and 12 need
"the firm took this desk away" separate from "this person chose not to come in".

Both could be derived — `checked_in_at IS NOT NULL`, or an actor comparison —
but that relies on every future analytics query remembering the qualifier. A
status is what a `GROUP BY` reads. Occupancy is the product; the vocabulary it
groups by should not need a footnote.

Both are outside the `seat_slot_unique` predicate, so both free the desk.
`checked_in_at` is deliberately preserved on a `cancelled_after_check_in` row:
that somebody turned up is evidence, and cancelling later does not un-happen it.

---

## ADR-025 — Taking a desk out of service is refused, unless forced

**Decision.** Setting a seat to `fixed`, `blocked` or `decommissioned` while
live future bookings exist is refused with a 409 listing them. `force: true`
performs it, cancelling each booking as `cancelled_by_admin` and notifying every
affected occupant and booker. Deactivating a user does the same with no `force`
— there is no defensible reason to leave those bookings standing when nobody is
coming.

**Why.** The brief said "block the status change, or force-cancel with
notification — pick one, log the decision." Refusing is the safe default: an
admin dragging desks around in the editor should not silently unseat four
people, and the list is exactly the information needed to decide. But refusing
outright is also wrong — a desk really does break, and an admin who cannot
record that ends up with a floor plan that lies. `force` makes the destruction
deliberate and auditable rather than accidental.

The cancellations go through the ordinary `cancelBooking` service rather than a
bulk `UPDATE`, so each gets its notification, its audit row and its status
transition from the same code path an individual cancellation uses. A bulk
update would be faster and would silently skip all three.

---

## ADR-026 — `notification_log` is the outbox; `MailProvider` is only transport

**Decision.** Notifications are rendered and inserted **inside** the booking
transaction with `status = 'queued'`, and delivered afterwards by a dispatcher
that catches everything. `DemoMailProvider` no longer writes rows; it resolves.

**Why.** Three properties fall out, and none is available if the adapter owns
the row:

1. **A committed booking always has its message.** Enqueue is part of the atomic
   unit, so a crash cannot leave one without the other.
2. **A send failure can never roll back a booking.** Sending happens after
   commit, outside the transaction, with its errors recorded on the message.
3. **The retry path is real rather than decorative.** Under the old design the
   demo adapter could not fail, so nothing exercised attempts, backoff or the
   `failed` state.

Bodies are rendered at enqueue time and stored. In demo mode that is what makes
`/admin/notifications` a genuine mailbox; in production it is the record of what
the firm actually told somebody, and re-rendering it later from a booking that
has since changed would quietly rewrite history.

**Cost.** Email HTML hand-copies five design tokens (`EMAIL_PALETTE` in
`src/lib/notifications/render.ts`), because mail clients cannot read CSS custom
properties. That duplication is written down rather than pretended away.

---

## ADR-027 — Auto-release is one conditional `UPDATE … RETURNING` per transition

**Decision.** Three statements. No job table, no advisory lock, no leader
election:

- `confirmed`, past the grace window, slot still running → `auto_released`
- `confirmed`, past `ends_at` → `completed_no_show`
- `checked_in`, past `ends_at` → `completed`

**Why.** Every property the brief asks for is a consequence of the shape:

- **Idempotent** — the second run's predicate no longer matches, because the
  first moved the row out of `confirmed`.
- **Safe to run concurrently** — under READ COMMITTED a second runner blocks on
  the locked row, re-evaluates the predicate against the committed version, and
  finds it no longer qualifies.
- **Only this run notifies** — `RETURNING` hands back exactly the rows this
  statement transitioned.
- **Never touches the wrong row** — `checked_in` and every cancelled state are
  outside every predicate, by name.
- **A rewound clock corrupts nothing** — the predicates simply stop matching,
  and terminal statuses are terminal.

The separate no-show branch is edge case 3. Releasing a desk for a slot that has
already finished would be theatre — there is no remaining time for anybody to
use it — so it settles as evidence about attendance rather than availability.

**The trap this created, recorded because it bit.** The job is global by design,
and a test that drives it from a fixed clock years away settles the ENTIRE
seeded database, because from that clock's point of view every real booking
finished decades ago. It did exactly that once, marking 577 seeded future
bookings as no-shows and emptying the demo floor. `runAutoRelease` therefore
takes an optional `onlySeatIds`, used by tests and never by production.

---

## ADR-028 — QR check-in is session-authenticated, not a secret URL

**Decision.** Every bookable desk gets a printed sticker pointing at
`/checkin/<seat_code>`. The URL carries no token; identity comes from the
session, and the check-in is recorded with `check_in_method = 'qr'`.
`qrcode@1.5.4` is added to the pinned stack and renders SVG server-side.

**Why the flow exists at all.** A door swipe proves somebody entered the floor.
It does not prove they used C3-04. Occupancy analytics built only on swipes
cannot distinguish a full floor from a half-full one where everybody walked past
the same reader — precisely the question the partners are commissioning this
product to answer — and it makes the whole thing depend on an access-control
vendor whose export format nobody has seen. A sticker on the desk removes both
problems.

**Why no token.** The sticker is on a desk in an open-plan office, so anything
printed on it is known to everyone who walks past and treating the URL as a
secret would be security theatre. What the flow proves is: *this person, who
holds this desk for this slot, said they are at it.* Materially stronger than a
turnstile, and honestly weaker than physical presence — recorded in ASSUMPTIONS
A19, with the note that badge and QR together are the strong pair.

**Cost.** One dependency, added rather than substituted. SVG rather than a
data-URI PNG so the sheet prints crisply at any size with no network dependency,
which matters when 93 of them are being run off on an office printer.

---

## ADR-029 — Jobs on an interval in dev, a Vercel cron in production

**Decision.** `runScheduledJobs()` — auto-release, notification dispatch,
calendar retry — is called from three places: a 60-second interval registered in
`src/instrumentation-node.ts` during development, a Vercel cron hitting
`POST /api/cron/jobs` every five minutes in production, and a button in the demo
panel. The route is protected by `CRON_SECRET`, compared in constant time, and
accepts both the `Authorization: Bearer` form Vercel sends and an
`x-cron-secret` header.

**Why an interval in dev.** Without something on a timer the auto-release rule
only fires when somebody remembers to press a button — which is exactly how a
demo goes wrong in front of a partner. All three callers run the same code
against the same Clock, so advancing the demo clock makes the real job run the
real rule.

**Why the constant-time compare.** This route mutates bookings. A naive `===`
leaks the secret one byte at a time to anybody willing to measure, and the fix
is four lines.

**A shape that is load-bearing.** `instrumentation.ts` is compiled for the edge
runtime as well as Node, and anything reaching `pg` from an edge bundle fails to
resolve `fs` — taking the whole dev server down with it. The Node-only work
therefore lives in a separate module imported inside the
`NEXT_RUNTIME === "nodejs"` guard, which is the only shape Next tree-shakes
reliably. `next.config.ts` also marks `pg` as a server-external package.

---

## ADR-030 — The 3D shell is merged segment boxes, not extruded shapes

**Decision.** `walls.json` becomes three merged meshes — wall, partition,
glazing — by turning every SEGMENT of every chain into one oriented box and
merging with `mergeGeometries`. Not `THREE.Shape` into `ExtrudeGeometry`.

**Why.** `ExtrudeGeometry` needs a *simple closed* shape, and earcut silently
produces holes, inverted faces or NaN vertices when the outline self-touches or
does not close. 437 of the 534 chains in `walls.json` are open polylines, and
several closed ones touch themselves where corridors meet. CAD linework chained
end to end has no obligation to be a simple polygon, and this drawing's is not.
Extruding shapes would have reintroduced, one layer further in, exactly the
class of failure the whole Phase 2 simplification exists to avoid.

A segment box cannot fail to triangulate. A chain that doubles back merely
overlaps itself. After merging it is still **one draw call per class**, which is
the only thing the shape approach was buying.

**Cost.** 1,431 segments and ~34k triangles rather than a few thousand, and
corners are mitred by overrunning each box by one wall thickness rather than by
being genuinely joined. At this camera distance neither is visible.

**Two things measuring it turned up.**

The **longest polygon in generator 2's `walls.json` was not a wall.** It was a
61-point, 971-unit run of 45-degree zig-zag inside a 35-unit box in zone A — a
hatch fill that survived the length filter. Invisible flat; a thicket extruded.
The two populations separate cleanly on how often a chain doubles back: that one
reverses direction at 100% of its vertices, the five longest real walls at
0–40%. `is_hatch()` drops chains reversing at 80% or more over six points or
more, and a unit test holds the committed file to it.

The **400-polygon budget predated glazing.** `G-GLASS` and `W-WINDOW` were
excluded from `walls.json` entirely, which is defensible when glazing is one
more line on a flat drawing and wrong when the difference between a room and a
box is whether you can see through it. Chained per class the shell is 97 wall,
157 partition and 280 glazing; squeezing that into 400 threw away 45% of the
curtain wall's length. The ceiling moved to 600, with per-class budgets so one
noisy class can no longer silently truncate another.

---

## ADR-031 — The 3D bundle is lazy, and `mode` is shared state

**Decision.** Everything that imports `three` lives under
`src/components/floor-plan/three/`, reached only through
`next/dynamic(..., { ssr: false })` in `three-view.tsx`. `mode` is a field on the
Zustand store and a query parameter, exactly like `date`, `slot`, `zone` and
`view`.

**Why lazy.** three, drei and the scene are 855 KB raw, 224 KB gzipped. Most
people who open `/floor` never press the 3D toggle, and `/floor`'s First Load JS
went from 232 kB to 238 kB — the toggle and the store field, not the renderer.
The rule that keeps this true is structural rather than a convention: nothing
above `three/` may import from it, and a stray `import type` is enough to break
it, so the boundary is one directory and one dynamic import.

**Why `mode` is in the store rather than local state.** The architecture rule
since Phase 2 is that 2D and 3D render the same seat array through the same
store. If `mode` were local to the floor screen, the *selection* would have to
be mirrored between two renderings, and mirrored state drifts. Instead
`selectedSeatCode` — declared in Phase 2 and unused ever since — is now the one
value both write, so "pick a desk in 3D, switch to 2D, the same desk is
selected" is true by construction rather than by synchronisation.
`e2e/floor-plan-3d.spec.ts` asserts it anyway.

**Cost.** A `mode=3d` link asks the recipient's browser for 224 KB before it can
show anything, and there is a visible beat while it arrives. The alternative —
three on the critical path for everybody — is worse.

---

## ADR-032 — 3D is not the accessible path, and says so

**Decision.** The 3D canvas is `role="img"` with a summary label, not
`role="application"`. It has no keyboard seat navigation. The `ModeToggle` sits
beside the plan/list toggle rather than inside the canvas, and the list view
stays one click away at all times.

**Why.** Phase 2 made every seat a real `<button>` with geometric arrow
adjacency, roving tabindex and an accessible name (ADR-018). None of that is
reproducible in a WebGL canvas without inventing a parallel focus model that
would be worse than the one already sitting behind the toggle. Claiming
`role="application"` would announce an interactive widget and then fail to
behave like one, which is worse than announcing a picture.

So 3D is additive: a wayfinding and demonstration view, with two fully operable
renderings of the same data permanently adjacent. The toggle is a labelled
radiogroup, and it never disappears.

**The fallback ladder, for the same reason.** No WebGL, a lost context, or any
throw inside the scene all land on the 2D plan with one quiet line of
explanation, via `detectWebgl()`, a `webglcontextlost` listener and a local
error boundary. There is deliberately no `error.tsx` anywhere in this app; a
route-level error page would replace the whole floor screen when all that has
failed is one optional rendering of it. A blank black rectangle in front of a
partner is worse than never having offered 3D at all.

---

## ADR-033 — Both pools carry an `error` listener, because otherwise a blip is fatal

**Decision.** `makePool()` in `src/lib/db/index.ts` attaches
`pool.on("error", …)` to both the pooled and the direct pool. It logs and
returns.

**Why.** `pg` emits `error` on an *idle* client when the server goes away —
Neon suspending an idle compute, wifi blinking, a DNS lookup failing. `error`
is one of Node's special-cased events: with no listener it is not swallowed, it
is rethrown as an `uncaughtException`. So a condition the pool recovers from by
itself, by discarding the client and opening a new one, instead killed the
process.

This was not theoretical. Two full e2e runs in one afternoon were destroyed by
a transient `getaddrinfo ENOTFOUND …neon.tech`, which surfaced as
`uncaughtException: Connection terminated unexpectedly` from the dev server and
failed every test after it. The suite could not be verified green until this was
fixed, which is how it was found.

The same blip during a live demo would have ended the demo, in front of the
people the product is being sold to.

**Cost.** None worth naming. The handler declines to die and logs; the pool's
own recovery is unchanged. It is deliberately not silent, because a pool
erroring repeatedly is a real signal and should be visible in the server log.

---

## ADR-034 — Charts are hand-rolled inline SVG, with a validated palette

**Decision.** No chart library. `src/components/analytics/charts/` holds a
`ChartFrame` plus bar, line and heat-map components, all inline SVG, all drawing
from tokens added to the one `:root` block in `globals.css`.

**Why.** Three reasons, in ascending order of how much they would have cost to
work around. A chart library is a large runtime dependency for four chart types
in a stack that is pinned exactly on purpose. Every library ships rounded
corners, drop shadows and its own type scale, all of which have to be fought
token by token in a design system whose entire thesis is hairlines and 4px
radii. And a partner is going to **print** these, so greyscale legibility is a
requirement rather than a nicety — which the bay heat map's single-hue ramp and
every status glyph exist to satisfy.

**The palette was measured, not chosen.** The brand colours fail as a
categorical set: navy and the green fall under the chroma floor, and amber
against green sits at ΔE 12.8 for normal vision — two series a full-colour
reader cannot reliably separate. So charts get their own steps in the same hue
families, validated against `--paper` on lightness band, chroma floor, CVD
separation, normal-vision floor and contrast.

**The ORDER of `--cbva-chart-1..4` is part of the result.** The checks are on
ADJACENT pairs; amber beside red fails the normal-vision floor at ΔE 12.7, and
putting green between them passes. Reordering those four tokens is not a style
change. Two-series charts — which is most of them, because most are split by
slot — use a separate blue/green pair that separates far better (ΔE 25.0) and
keeps amber off the largest filled areas, since a bar chart is the easiest place
in a product to accidentally spend 40% of the pixels on something a partner
reads as gold.

**Cost.** More code than importing recharts, and every new chart type is ours to
write. Bought: no dependency, no bundle, no fight with the design system, and
charts that survive a photocopier.

---

## ADR-035 — The measure vocabulary is one module, and it refuses to answer the open question

**Decision.** `src/lib/analytics/measures.ts` is the single definition of what
occupancy means — the same role `SEAT_STATUS_TOKENS` plays for seat colour. All
eight booking statuses are partitioned explicitly by what each is evidence OF,
and **all three candidate measures ship side by side** rather than one being
chosen.

**Why not pick one.** CBVA has not decided how an auto-released desk should be
accounted for. Picking for them and presenting a single confident number would
be the most damaging thing this product could do, because the number would be
quoted in a board pack and the assumption behind it would not. Showing seats
booked, seats attended and seat-hours consumed over identical filters — with the
definitions on screen beside them — turns the open question into something the
data can help answer.

**Three traps the module exists to close**, each of which produces a
plausible-looking wrong number rather than an error:

1. **`released_at` is overloaded.** The job writes it on the
   `completed_no_show` transition as well as on `auto_released`, and the seed
   writes a *different* value for the same status. `coalesce(released_at,
   cancelled_at, ends_at)` therefore under-counts no-show hours by ~50% on demo
   data and 0% in production. Every arm `CASE`s on status.
2. **"Seats booked" is three numbers.** `seat_slot_unique` is partial, so an
   auto-released desk is legitimately rebooked and both rows complete —
   `count(*)` can exceed capacity, `count(distinct seat_id)` cannot be a demand
   figure. The gap between them IS the rebooking finding.
3. **Grouping by weekday cannot use a distinct count.** Over eight weeks nearly
   every desk is used on some Monday, so every weekday returns ~93 and the chart
   that exists to show Mondays are dead renders flat. Aggregate per day first,
   then average. The same trap bit the heat map one query later, where it drew
   bay SIZE instead of bay utilisation.

**Cost.** Three columns where a client might have wanted one, and an explainer
that has to be maintained alongside the SQL.

---

## ADR-036 — Releasing an allocated desk is a row, not a status change

**Decision.** `seat_releases` records that a fixed desk is in the pool for one
date and slot. `seats.status` is untouched.

**Why not flip the seat status.** Status is a property of the DESK; this is a
property of a desk on a DAY. Flipping it would need flipping back, would be
wrong for every other date simultaneously, and would leave the floor in a state
nobody could reconstruct if a job died halfway. A row per (seat, date, slot) is
the only shape that is correct for one day without being wrong for the next.

**Revoking sets `revoked_at`, never deletes.** Same shape and same reason as
`seat_slot_unique`: a desk released and later reclaimed is a fact about how the
floor was used, and the history is the analytics.

**One boolean, and NO eighth seat status.** `seatVisualStatus` takes
`releasedByOwner` and skips the fixed branch. The seven-status vocabulary is
proven desaturated on `/styleguide`, bridged by the 3D materials, and rendered
in three media; an eighth would mean re-proving the colour-vision guarantee for
a state that is not visually distinct anyway. A released desk simply stops being
reserved and flows through the existing paths, which also means
`countsAsCapacity` picks it up for free — which is the entire point of the
feature.

**The race is revoke-versus-book, and it stays in the database.** The insert
takes the release `FOR UPDATE` in the same statement; revoke is the mirror
conditional `UPDATE ... WHERE NOT EXISTS (live booking)`. Reading first and then
inserting would reintroduce exactly the window ADR-003 closed.

**Reclaiming a taken desk is refused, with the colleague named**, and forcible
only by an admin — ADR-025's precedent. A forced reclaim goes through the
ordinary `cancelBooking` and lands as `cancelled_by_admin`, which is the honest
status and is precisely why ADR-024 kept it separate from a no-show.

---

## ADR-037 — A cancelled occurrence IS the recurring series' exception record

**Decision.** `booking_series` has no exceptions table and no skip list.
`booking_series_occurrence_unique` on `(series_id, booking_date, slot)` is
**deliberately NOT partial on status**, so a cancelled occurrence still occupies
the key and the materialiser's `ON CONFLICT DO NOTHING` finds it.

**Why.** The obvious design is a `series_exceptions` table listing skipped
dates. That is a second piece of state describing the same fact, and the two
drift: cancel a booking through the ordinary path and the exception row is not
written, so the job recreates it tomorrow and the user cancels the same day
twice. Making the tombstone *be* the cancelled booking means there is nothing to
keep in sync, and the ordinary cancel path needs no knowledge of series at all.

**The cost, and it is a real one.** `editBooking` is cancel-and-rebook
(ADR-023), so the rebooked row **must** be inserted with `series_id = NULL`. It
has detached from the series by definition, and leaving the id on it collides
with its own tombstone. Miss it and every edit of a recurring booking throws a
raw index name at the user. It is one line, it is commented at the site, and
`mapPgError` handles that constraint anyway so the failure would be a sentence
rather than a stack trace.

**Idempotence is the index, not a watermark.** A "last materialised at" column
would be wrong the first time somebody winds the demo clock backwards — which is
a thing this product actively invites.

**A lost race is a notification, not a failure.** Somebody taking the desk first
is the ordinary case. Known `BookingError` codes are absorbed, recorded and
emailed once — keyed on `(kind, series_id, occurrence_date, recipient_email)`,
because the booking that would have carried the usual key was never created.
Anything unrecognised still throws, because a bug must stay a bug.

---

## ADR-038 — When the auto-release cap trips, nothing is applied

**Decision.** `runAutoRelease` selects `cap + 1` candidate ids per transition.
If more come back than the cap allows, that transition applies **nothing**,
writes an `auto_release_capped` audit row, logs, and surfaces on `/admin/jobs`.

**Why not a `LIMIT`.** A `LIMIT 250` is the obvious implementation and it is
worse than useless. The incident this bound exists for settled 577 bookings in
one run from a clock set to 2099; with a limit it would have settled them over
three cron ticks instead — the same catastrophe, three minutes slower, and now
indistinguishable from normal operation in the audit log. **A bound that only
slows a runaway down is not a bound.** Stopping dead is what makes a human look.

**Counting before updating is safe here in a way a freeness check is not**, and
the distinction is worth stating because it superficially resembles the thing
ADR-003 forbids. The cap is a safety valve, not a uniqueness rule: a couple of
rows appearing between the count and the `UPDATE` changes nothing that matters.
The uniqueness argument still lives entirely in the `eq(status, ...)` inside
each `UPDATE`, which is what makes a concurrent second runner a no-op — and that
clause must survive any future refactor of this file.

**The horizon is deliberately not applied to the release transition.** Its
predicate already carries `ends_at > now`, so every candidate is a slot still
running and nothing can be older than the horizon. Adding the clause would be
dead code that looks load-bearing.

**Cost.** A settings-backed cap that will be wrong if the floor or the slot
count changes materially — logged as A26 — and one extra query per transition.

---

## ADR-039 — Analytics types live apart from analytics queries, because `pg` cannot reach the browser

**Decision.** `src/lib/analytics/types.ts` holds every row interface and the
weekday labels, and imports nothing. `queries.ts` re-exports it for server
callers; client components import from it directly.

**Why.** `queries.ts` imports `@/lib/db`, which imports `pg`, which needs `fs`.
A client component importing a single label constant from it dragged the whole
Postgres driver into the browser bundle and the build failed with
`Module not found: Can't resolve 'fs'`.

This is ADR-031's trap one layer down, and it fails the same way: not with a
wrong number but with a build error or a bundle four times bigger than it should
be. The subtlety is that **types survive erasure and runtime values do not** —
the file had been importing types safely for an hour before one
`WEEKDAY_LABELS` broke it.

**Cost.** One more file, and a rule to remember: nothing in `types.ts` may
import anything with a runtime dependency.

---

## ADR-040 — Error boundaries wrap widgets, never routes

**Decision.** `<WidgetBoundary>` wraps each analytics card. There is still no
`error.tsx` anywhere in this application.

**Why.** ADR-032 took this position in Phase 4 for the 3D view and it holds
harder on an analytics screen. A route-level error page replaces the entire
screen when what has actually failed is one card — and a partner looking at a
blank page cannot tell whether the product is broken or the floor is empty,
which is the worst possible ambiguity for a product whose whole claim is that
its numbers can be trusted. Nine widgets and one bad query should be eight good
widgets and one apology.

The fallback names the widget, because "something went wrong" on a screen with
nine panels is not information.

**Cost.** A boundary per card rather than one per route, and a class component
in a codebase that otherwise has none.

---

## ADR-041 — On a public demo URL, an admin session is not an authorisation

**Decision.** `POST /api/cron/jobs` accepts **only** the shared secret whenever
one is configured. The admin-session shortcut is gone. The demo panel calls
`POST /api/admin/jobs` instead.

**Why, and it was found by probing the deployment rather than by reading the
code.** The route previously accepted an admin session as an alternative to the
secret whenever `APP_MODE` was not exactly `production`. On a laptop that is
harmless and convenient. On a public demo URL it is a hole, and a subtle one:
the demo `AuthProvider` deliberately resolves an unknown visitor to a seeded
admin, so **"is the caller an admin?" is true for anybody on the internet.** The
deployed endpoint answered 200 to an unauthenticated POST — a stranger could
drive the job loop.

The A22 bounds meant they could not have emptied the floor with it. That is not
a reason to leave it open.

**The general lesson, worth more than the fix:** every authorisation check that
depends on "who is signed in" is only as strong as the auth adapter behind it,
and the demo adapter is deliberately permissive. Any endpoint that must be safe
on a public demo needs something the adapter cannot fabricate — here, a secret.

**The no-secret case stays open deliberately.** `npm run dev` configures
nothing, and a laptop should not be locked out of its own demo.

**Cost.** The demo panel now goes through a second route. That is arguably
better anyway: it puts running the jobs on the same footing as every other admin
action rather than giving it a private front door with different rules.

---

## ADR-042 — The partition layer carries a colour key, so read it

**Decision.** `walls.json`'s `partition` class takes only **black-stroked**
paths from `P-FULLHEIGHT PARTITION`. `cadparse.py` retains stroke and fill
colour per path, riding them on the `q`/`Q` graphics-state stack alongside the
CTM. The filter is scoped to that one layer; `I-PART-FULL` passes through whole.

**Why.** The layer is 6,444 paths and 200 of them are partitions. By stroke:

| stroke | paths | length | extent |
|---|---|---|---|
| `#FF4405` | 5,012 | 34,916 | C and D wings only |
| `#0037DD` | 1,152 | 1,473 | one narrow vertical band |
| `#000000` | **200** | **9,347** | the whole floor |
| `#006EDD` | 52 | 351 | |
| `#8AB85C` | 28 | 398 | one 31×31 unit symbol |

The black paths average 47 units each and are spread over the whole plan: the
real room dividers. The orange averages 7 units and sits inside the workstation
bays: the dot fill of the solid rapid-rail benches. Flat on a drawing that is
texture; extruded to 1.35 m it is a wall through the middle of every bay.

The colour was there all along and the parser discarded it — `RG` and `rg` fell
through to the operand reset. Recovering it is three branches, because every
colour in this file is a plain 3-operand DeviceRGB: there is not one `sc`,
`scn`, `SCN`, `g`, `G`, `k` or `K` operator in the whole content stream.

**Colour must ride the `q`/`Q` stack.** The drawing sets `RG` inside nested
blocks; a bare global leaks one block's colour into the next and mis-attributes
paths wholesale. That is the one line in this change that is easy to get wrong
and produces plausible-looking output when you do.

**Measured, and the numbers are the argument.** wall 97 → 97 polygons and
11,875 → 11,875 units; glazing 280 → 280 and 14,692 → 14,692 — both classes
untouched. partition 157 → 85, 14,119 → 8,850. Rendered before and after and
diffed: all 80 removed polygons lie inside a C or D bay along a bench run. No
room divider and no part of the envelope goes.

**The envelope, written down because it was not obvious.** The outer cruciform
is `W-WALL` — 165 black paths, bbox `[89 109 1361 1058]`, the only layer
touching all four edges of `PLAN_BOX (85, 95, 1370, 1065)`, chaining to 71
polygons of which the longest (858 units) is the outline itself. `C- COLOUMN`
adds 23 chains for the core ring. It is named explicitly in `WALL_CLASSES`, so
it is not arriving by accident and cannot leave by accident.
`P-FULLHEIGHT PARTITION` black is inset ~80 units on every side and is interior
only, which is why filtering it cannot touch the shell.

**Cost, and the deliberate limits.** Only the extruded shell filters. The baked
texture still paints every colour on this layer — it is the architect's drawing
and nothing is deleted from it — and `planmask` still floods the whole layer,
because narrowing its input would move `interiorCoverage` off 0.5775 and with it
`coreCentre` and every zone hull. `zones.json`, `detected-modules.json`,
`detection-report.json` and both webps came back byte-identical, which is the
evidence that it did not.

---

## ADR-043 — The de-collide step belongs in the build, because the gate proving otherwise was vacuous

**Decision.** `npm run build:floorplan` runs
`scripts/fix-interpolated-anchors.mjs --write` between the Python extract and
the rasterise. `validate()` additionally refuses any build in which two desks
sit closer than 1.30 m.

**Why.** Phase 5 fixed A24 by running that script **by hand, once**, over the
committed `seats.json`. From that moment the build no longer reproduced the
repository: regenerating from the PDF reverted all eleven interpolated anchors
and took the floor from 0 colliding desk pairs back to 15, the worst 6 cm apart.

**Nothing reported it, and the check that should have is the interesting part.**
Phases 4 and 5 both gated on the geometry coming back "byte-identical". That
gate compared two consecutive **builds to each other**. Two runs of a
deterministic program always agree, so it passed — while the property anyone
reading it would assume, that the build produces the file in the repository, had
been false since the hand-edit. **A false green is worse than a red**: a red is
a bug, a false green is a bug plus a reason not to look for it. Reproduced
before fixing: a Phase 6 build moved exactly those eleven anchors and no others.

The de-collide is a fair thing to automate. It is deterministic — each
interpolated desk is re-placed along its own bay's axis at the drawing's
measured 23.02-unit (1,624 mm) pitch, then relaxed a step at a time until clear
of every other desk on the floor — and it already refused to write if any
collision remained.

**It must run once, on fresh extractor output.** Run over its own result the
relaxation would measure against already-moved neighbours instead of the ones
the extractor produced, and the fixed point is not guaranteed to be the same.

**The guard is the durable half.** Verified by negative test: silent on the
committed file, fires on a synthetic 7 cm nudge, and fires on the real pre-A24
geometry naming `C7-04` and `PA-15` at 0.061 m. The script and the assertion can
now only drift apart loudly.

**Cost.** The build depends on a second script, and `seats.json` stays
pretty-printed where every other generated file is compact — that formatting is
the fix's own output and changing it would be churn for nothing.

**A note for anyone verifying byte-identity on Windows.** This repository is
checked out with `core.autocrlf=true`, so git rewrites LF to CRLF in the working
tree and a raw `sha256sum` of a checked-out file does not match its blob.
`git diff --exit-code` is the gate; a hash comparison is only valid between two
files the build itself wrote.

---

## ADR-044 — Static furniture is massing from the CAD, and it is inert

**Decision.** `furniture.json` carries one minimum-area **oriented** box per
chained outline on `F-LOOSE FURNITURE`, `LANDSCAPE` and `I-FURN-MODU`, tagged
`table` / `seating` / `planter` / `modular`. `three/static-furniture.tsx` draws
them as one `<Instances>` per kind. Nothing in it is interactive.

**Why it exists.** The renderer draws a mesh only where a **bookable seat**
exists. Zone A is a 25-person boardroom, four meeting rooms, a lounge and
storage; Zone B is a flexible room with eight foldable tables on castors, a sofa
lounge and a run of storage credenzas. Neither has a single bookable desk, so
both wings rendered as bare plate — which reads as *broken* rather than as "that
wing is meeting rooms". **No seat was added to fix that.** There are no seats
there; seats.json is right, and the gap was in the rendering.

**Massing, not outline extrusion.** `ExtrudeGeometry` needs a simple closed
shape and most of these chains are open polylines — the same reason ADR-030
gives for the walls, one layer further out. A slab is enough: the baked drawing
underneath already carries the real linework at full fidelity, so every box sits
on its own drawn footprint and reads as the thing it covers.

**Oriented, not axis-aligned.** The building is a cruciform and its two side
wings are drawn at 45°. An axis-aligned box round a sofa in Zone B is half again
too big and points the wrong way.

**The constraint that matters most: zero interactivity.** Every mesh sets
`raycast={() => null}` and nothing enters the DOM. The moment non-bookable
furniture becomes clickable, somebody tries to book the boardroom from the floor
plan and desk booking and room booking — two deliberately separate flows — merge
into one.

Note *which* failure is possible, because the first test written for this tested
the wrong one. Furniture has no pointer handler, so it can never **steal** a
pick: it has no seat code to report. What it can do is **block** one, by
standing in front of a desk without the raycast opt-out. The guard is therefore
the existing pick test, which filters to Zone D — a wing that now carries 81
furniture boxes of its own — and still resolves a desk. A sweeping "is anything
else pickable" test was written, measured at ~2.7 s per pointer move under
SwiftShader, and deleted: it timed out at 240 s while proving nothing the cheap
test does not.

**Measured.** 318 boxes — 11 table, 229 seating, 72 planter, 6 modular; by wing
A 148, B 73, D 81, C 16. Draw calls **11 → 15**, one per kind. Triangles
**38,848 → 42,664**. Budget is 60 calls and 120k triangles.

**Colour comes from the chrome tokens, never from `SEAT_STATUS_TOKENS`.** This
furniture has no status and must never look as though it has one. It is pale and
low-contrast on purpose: context, not content.

**Cost, and what is invented.** The heights (table 0.74 m, seating 0.42 m,
planter 0.5 m, modular 0.9 m) are guesses, like every other vertical dimension
in this view — ASSUMPTIONS A23. So is the one classification rule: a 40-plan-unit
(2.82 m) longest side splits `table` from `seating` inside `F-LOOSE FURNITURE`,
because a boardroom table and a visitor's chair are the same CAD layer and the
drawing does not label them. Nothing anybody sits on is that long. One
consequence to know: the Zone B credenza run comes out as a 16.7 m `table`,
which is the right shape and height and the wrong noun.

---

## ADR-045 — Room labels: extracted, joined on the bay code, and drawn as a floor decal

**Decision.** `rooms.json` carries zone A's room schedule — the architect's own
bay tags and their PAX — read from the same text spans seat detection reads and
kept strictly apart from it. Display names come from `MEETING_ROOMS`, joined on
`bayCode`. 2D draws `<text>` in the existing overlay; 3D draws a **floor decal**,
one merged mesh over one strip atlas.

**Why labels at all.** Zones A and B hold no bookable desks apart from A1 and
A2. Even with the furniture layer, a wing with no desks reads as a fault unless
something says what it is. "Boardroom · 25 seats" is a very small amount of
geometry for a large change in how the plan is read.

**Extracted, not typed.** `bay_anchors` skips every zone-A tag so a meeting
room's capacity can never be imported as a desk count — A3's 25 becoming 25
bookable desks is exactly the bug that guard exists to prevent. It is left
untouched; `room_labels()` reads the same spans separately. Every tag pairs to a
PAX within 33 plan units: A3→25, A9→10, A8→7, A7→5, A6→5. A4 (storage) and A5
(lounge) carry none, correctly.

**This independently re-verified the room inventory** seeded one commit earlier
(ADR — see A3). The five capacities came out of the drawing twice, by two
different routes, and agreed.

**Joined on the bay code, which is why that column exists.** The only other
shared key is the display name, and the name is the one field CBVA is expected
to change. Rename a room on `/rooms` and the plan follows by construction.

**A decal rather than a floating label**, weighed in this order:

1. **The top-down preset is the acceptance test** for the whole 3D view — press
   it and the model should resolve into the sheet CBVA handed us. A decal lies
   in the plan and reproduces it. A billboard turns to face the camera and
   breaks exactly when the view is meant to prove itself.
2. **Cost.** drei's `<Text>` is per-label SDF geometry and one draw call each.
   Nine labels is nine; a floor with thirty would spend half a budget of 60 on
   decoration. Here every label is a quad in world space with its atlas row
   baked into its UVs, all merged into one `BufferGeometry` — **one draw call
   and one texture, however many labels there are.** The same merge as the walls
   (ADR-030) and the same atlas trick as the status glyphs. Per-instance UV
   offsets would have needed a custom shader; baking them into vertices needs
   nothing.
3. **Subordination.** Lying flat keeps them quieter than anything standing up.

**Depth testing is off, and that was found by looking.** The first version lay
on the floor with depth testing on and was invisible: a 16 m boardroom table is
0.74 m high and covers its own label completely. A label the furniture hides is
not a label. They now draw last and are never occluded, still flat in the plan.
The cost is that at a low orbit a label can show through the wing in front of
it — which is how map labels behave anyway.

**The honest limit.** A decal is foreshortened at every angle but straight down,
so in 3D these read at wing framing and shrink to marks at whole-floor framing.
That is the right way round: at sixty metres up the question is "how full is the
floor", not "what is that room" — the same LOD argument Phase 4 made about
per-seat status. The **2D plan carries the same labels as real text and reads
at fit-to-floor**, and 2D is the default and the accessible view.

**Accessibility.** The 2D labels live in an `aria-hidden` overlay and the 3D
ones inside a canvas, so on their own they would be visible-only — and what they
convey is the answer to "why does a third of this floor have no desks on it".
`nonBookableSummary()` puts the same sentence into both views' accessible
labels, from the same data, so the two cannot drift.

**Cost.** Nine labels are hard-positioned by the drawing, so a room the drawing
does not tag gets none. Zone B is labelled from its zone polygon's anchor
because it carries no tag at all.

---

## ADR-046 — The full-fidelity texture is a stdlib PORT, not an adopted PyMuPDF renderer

**Decision.** The colour-accurate plan texture is emitted by
`tools/cad/texture.py`, built on the repo's existing stdlib PDF reader
`cadparse.py`. The PyMuPDF reference implementation that established the
approach is kept as `tools/cad/reference_render_plan_full.py` and is **not**
wired into the build.

**What the old texture was throwing away.** `write_texture_svg` flattened every
path into eight hand-picked greyscale layer groups with one stroke width each.
That grouping was written to answer "where are the walls", which it does
correctly, and was then promoted into being the presentation texture, which it
was never designed for. Measured against the source PDF:

| | in the drawing | kept by the old texture |
|---|---|---|
| painted paths | 80,428 (79,827 inside `PLAN_BOX`) | all, but re-coloured |
| distinct (stroke, fill) combinations | **29** | 1 per layer group |
| stroke widths | **8** (0.15 … 1.41 pt, plus zero) | 1 per layer group |
| line joins | 49,257 miter / 30,570 round | all round |
| filled paths | **149** | 0 — everything `fill="none"` |
| embedded bitmaps in the plan | **11** | 0, structurally unseen |

The eleven bitmaps are the solid B.P.G storage credenzas. A vector-only
extractor cannot see them at all, which is why their absence was completely
silent for five phases rather than being noticed and deferred.

**Why not simply adopt the reference.** Three reasons, in order of weight.

1. **It needs `pip install pymupdf`.** `cadparse.py` exists precisely so that
   `npm run build:floorplan` works on a clean checkout with no pip step. That
   property is worth more than the work the reference saves.
2. **Two parsers reading one PDF is how the texture and the geometry drift
   apart.** The JSON and the texture would then be two independent readings of
   the same drawing with no gate comparing them — which is the Phase 6 class of
   defect, not a new one.
3. PyMuPDF is AGPL-3.0, inside a client deliverable's build.

**Why the port was affordable, which is the part that decided it.** ADR-042 had
already put stroke and fill on the `q`/`Q` stack with the CTM, so colour was
free. That left four small additions — `w`, `j`, even-odd, and image XObjects —
and only the last looked hard. It is not:

- The bitmaps are `/Filter [/FlateDecode /DCTDecode]`, so **one `zlib` pass
  leaves untouched JPEG bytes** that go straight into a `data:` URI.
- Their soft masks are `/Filter [/FlateDecode /ASCII85Decode]` DeviceGray, so
  `zlib` + `base64.a85decode` gives raw luminance, wrapped into a greyscale PNG
  by hand in a dozen lines of `zlib` and `binascii.crc32`.
- That PNG rides alongside the JPEG as an SVG **luminance `<mask>`**, so the
  compositing a pixel renderer would do happens at render time instead. **No
  JPEG decoder is needed anywhere.** Verified that sharp's librsvg (2.62.91)
  composites a `<mask>` over a `data:` URI image correctly before any of this
  was written.

`cairosvg` is not needed either — `sharp` already rasterises the intermediate.

**The claims were checked, not trusted.** Every headline number above was
re-derived from the PDF with the stdlib parser before the port began, and the
audit's two exact constants — 2,492 paths removed by the legend-swatch EXCLUDE
boxes, 11 in-plan bitmaps — **reproduce exactly** in both implementations. That
agreement is the evidence the port is faithful.

**Two corrections fell out of doing that.** ADR-042 and `cadparse.py` both said
there is "not one `sc`, `scn`, `SCN`, `g`, `G`, `k` or `K`" in the content
stream. There are also **192 `CS` operators**, which that list does not mention.
With no `SC`/`SCN` anywhere to set a value, colour still comes entirely from
`RG`/`rg` and the conclusion stands — but the claim as written was not literally
true, and is corrected in both places. The reference's own `SRC` default also
names a filename with underscores that does not match the committed PDF.

**One SVG per raster width, and the pairing is checked.** A PDF stroke width of
0 means one DEVICE pixel, and 49,196 of the 79,827 in-plan paths are zero-width
— 62% of the linework. The correct SVG stroke is therefore
`PLAN_WIDTH / target_pixels`: 0.627 at 2048 and 0.314 at 4096. **There is no
single value that is right at both**, and until now one SVG was rasterised at
both sizes, so one of the two shipped textures was always wrong — silently too
faint or too bold, which reads as a rendering preference rather than a defect.
Each SVG now carries `data-raster-width` and `rasterise()` refuses a mismatch.

**The planmask is kept, and it is the one deliberate difference from the
reference.** The reference filters by EXCLUDE boxes alone; this also keeps the
existing `mask.keeps()` interior test, which drops a further **175 paths (0.22%)
of sheet marks lying outside the building shell**. Measured, and reported rather
than assumed.

**The audit is the build's first step and its exit status is the build's.** Five
checks, each guarding something that has gone wrong or could go wrong silently:
the exact count of paths the EXCLUDE boxes remove, that no wall-class geometry
is among them, that all eleven bitmaps are present, that no CAD layer is hidden
in the PDF's own default view, and that the planmask still floods to the same
interior coverage. It was **demonstrated failing both ways** before being
trusted — see PHASE-7-HANDOFF.

**Cost.** The audit constants are exact and must be re-verified against the PDF
if an EXCLUDE box ever changes — which is the point of them being exact, and is
written on the constants themselves.

---

## ADR-047 — `furniture_type` is not derivable per seat, and the retreat is closed too

**Decision.** Seats carry no `furniture_type`. There is one desk mesh. Neither
per-anchor nor per-run classification will be attempted again without new input
from CBVA, and this ADR exists so that decision is findable in six months rather
than re-litigated from scratch.

**What the drawing's legend states.** 93 rapid-rail workstations and 4
screen-only workstations, plus 8 foldable tables — 105 furniture units against
**141 seat positions**. Those two numbers cannot both be per-seat attributes,
and the reason is visible once stated: **a bench run drawn as one hatched
desktop is one furniture unit serving nine people.** The hatch describes a
PROCUREMENT count, not a per-seat attribute.

**Three independent methods, all converging on the wrong number** (Phase 6 §4):

| method | rapid | screen | target |
|---|---|---|---|
| bbox clustering + distance threshold, swept 6–20 units | 72–73 | 4–8 | 93 / 4 |
| bbox clustering, parameter-free nearest region | 78 | 22 | 93 / 4 |
| **true segment distance ≤ 12 units** (the correct geometry) | **68** | **7** | 93 / 4 |

The second exposed a methodological error worth keeping: clustering **bounding
boxes** means a hatch line drawn diagonally across a room has a bounding box
covering the whole room, and `#4A9500` "8 foldable tables" appeared to cover
half the D wing. The third row is the corrected measurement.

**Why it is structural rather than a tolerance to tune.** **34 of 141 anchors
have no hatch of any colour within 12 units** — C1 (6), C6 (9), D1 (9), D2 (9),
D5 (1). These are ordinary workstation bays confirmed by the drawing's own PAX
annotations, so they must be among the 93, and there is no hatch under them to
say so. No threshold reaches 93 from 68 without inventing the difference, which
is fitting a hypothesis to a target — the exact thing the Phase 6 gate existed
to prevent, and did.

**The obvious retreat is closed too, and that is what is new here.** Phase 6's
handoff suggested typing at the BAY or RUN level instead, on the grounds that a
run is what the hatch actually describes. That is true, and it is still not
cheap: it needs bench runs segmented from the drawing, and **ADR-016 already
established that desks cannot be segmented from this drawing — only chairs
can.** So the retreat needs the same missing capability the original attempt
did. Leaving it recorded as "the obvious next step" without that caveat is an
invitation to spend a week rediscovering ADR-016.

**What would actually close it.** Not a better probe. Either the furniture
schedule from the fit-out contractor, which lists units against locations, or
five minutes from somebody at CBVA marking which bays are rapid-rail. Both are
input, not inference.

**What was established and is worth keeping.** The colour extraction itself is
right — it reconciles with the brief's own per-wing path counts exactly, and
there are exactly four `#0037DD` regions inside the building, each a single
~25×25-unit workstation footprint. The drawing's "4" is confirmed **as
regions**. What fails is attributing them to specific seat anchors.

**Cost.** The 3D view draws one desk mesh for all 141 desks, so the three desk
variants the legend implies are not modelled. Nothing numerical depends on it:
`furniture_type` would have been descriptive, and no occupancy figure reads it.

---

## ADR-048 — Past a threshold the plan answers a different question, in both views

**Decision.** Below 2D zoom 0.85 (or beyond 70 m in 3D) the floor plan renders
occupancy **per bay** and paints each seat as a plain dot. Inside the threshold
it renders the seven per-seat statuses as before. One pure module,
`src/lib/floor-plan-lod.ts`, holds the thresholds, the hysteresis and the
aggregation for both renderings.

**Why, and why not "make the chips bigger".** At whole-floor framing a desk is
about 11px across in 2D and a few pixels in 3D, so the seven-status vocabulary
is not merely hard to read there — it is unreadable in principle. Nobody picks a
desk from sixty metres up. The question at that framing is "how full is the
floor and which wing is busy", which is a **density** question.

Phase 4 recorded exactly this and also recorded the failed attempt to fix it the
other way: enlarging the glyph plate so the mark reads from further away. The
atlas cell holds one **centred** glyph, so a bigger plate stretches the glyph
with it and all 141 desks become smears (Phase 4 defect 7). Two rounds of
diagnosis went at the colour before the geometry. The plate stays 0.34 m and the
glyphs are simply **not drawn** at bay detail. A mark that cannot resolve should
not be drawn larger; it should be replaced by one that answers a question the
viewer can actually use at that distance.

**The 2D threshold is not a guess.** `plan-canvas` sizes a marker
`min(34, max(13, scale * 16))`, so below scale **0.8125** the chip is PINNED at
its 13px floor while the drawing's 23-unit desk pitch keeps shrinking underneath
it. That is precisely the regime where chips start colliding, and it is where
the switch belongs. Fit-to-floor measures 0.611 at 1440×900, already inside it.

**Two thresholds, not one.** Enter bay detail below 0.85, leave above 1.00; in
3D, enter beyond 70 m and leave inside 55 m. A single threshold flickers when a
settling spring or a damped orbit drifts across it, and a plan flickering
between two renderings is worse than committing to either. `resolveLod` is pure,
so the transition is a unit test rather than something to eyeball.

**The 141 seat buttons never leave the DOM.** This is the constraint that shaped
everything else. All 141 keep their accessible names, their tab order, their
`data-status` and their hit box at every zoom; only their paint changes, to a
dot inside the same button. So ADR-032's rule holds — a rendering choice never
degrades the accessible path — and the three e2e counts that depend on 141 hold
by construction rather than by luck. The bay layer is `aria-hidden` and
`pointer-events: none`; it is decoration over a working control surface.

**One colour map, still.** A chip is `--seat-booked-fill` over
`--seat-available-fill`, the two values a desk already uses, with the count
printed on it as the non-colour differentiator. **No density ramp entered the
product.** The `HEAT_STEPS` ramp the analytics uses was deliberately not reached
for: it belongs to a different surface with a legend beside it, and importing it
here would give the floor plan a second vocabulary — the exact thing the
greyscale and colour-vision guarantee on `/styleguide` depends on not happening.

**Normalised by each bay's own capacity.** Phase 5 shipped a bay heat map that
counted occupied desks without dividing, so every cell saturated to the bay's
size and the map drew a picture of which bays were biggest. PD has 18 desks and
D5 has one. The same mistake was available here and the same functions prevent
it — `countsAsOccupied` and `countsAsCapacity` from `seat-visual-status.ts`.
Bays with **no** bookable supply are dropped rather than drawn "0/0": that is
not a low occupancy reading, it is not a question, and eight such plates over
the drawing made the eleven real ones harder to find.

**Chips are separated, because centroids are where the desks are and not where
there is room to write.** Four pairs in the C and D wings sat within a chip's
width of each other, so C5 covered C6 and D2 covered D3 — the layer that exists
to answer "which wing is busy" hiding the two bays it was answering about. A
deterministic pairwise separation pass fixes it: sorted input, fixed iteration
count, no randomness, so the same floor always lays out the same way and a
screenshot is stable. Displacement is **capped** and a leader line is drawn when
a chip has moved, because a chip relocated far from its bay is mislabelling the
floor rather than decluttering it. Measured after: 13 chips, **zero overlapping
pairs**, none clipped — and that is asserted in `e2e/floor-plan.spec.ts` rather
than left to the eye.

**In 3D the switch SUBTRACTS from the budget.** The bay plates are one merged
`BufferGeometry` over one strip atlas — the construction ADR-045 uses for the
room labels — so thirteen bays cost one draw call, replacing up to six
per-status glyph instance meshes. Measured: **13 draw calls at whole-floor
framing against Phase 6's 16**, and 15 on a zone where the glyphs come back.
Both well inside the budget of 60.

**`window.__cbva3d` carries `lod` and `distance`.** An LOD switch checked only
by looking at a screenshot is a feature nobody can prove still works. The 3D
suite already reads that object for draw calls and triangles, so publishing the
level there makes the transition assertable with the handle that exists.

**Cost.** Two renderings of the same data now exist, and a change to the status
vocabulary has to be considered against both. That is mitigated by the colour
rule above — the bay layer reads the same tokens — but it is real. The bay layer
is also visible-only: what it conveys is available to a screen reader through the
seats themselves and the list view, which is the same position ADR-032 takes for
the 3D view, but it does mean the density READING is a sighted convenience
rather than a second accessible path.

## ADR-049 — Room booking gets the desk-side date rules it never had, and attendees beyond the organiser

**Decision.** Two changes to meeting-room booking, shipped together because
testing one properly meant exercising the other.

**The date gap.** `createRoomBooking` checked office hours, a zero-length
range, and an inverted range, and nothing else about the date. A room could be
booked for a Saturday, a public holiday, or an hour that had already started —
none of that was a race or an edge case, it was a rule the desk side already
had (`assertDateBookable`, `bookableDates`) that nobody had ported over.
`roomDateIssue()` in `src/lib/rooms/validation.ts` closes it: weekend, then
holiday, then already-past, checked in that order so the message names the
real reason rather than a generic refusal.

**Deliberately NOT the desk's booking window.** Desks cap how far ahead you
can book at five working days (`bookingWindowWorkingDays`). Nothing has asked
for that limit on rooms, and adding it here would be a behaviour change dressed
up as a bug fix. A room can still be booked for any date in the future; it just
has to be a real, open, future one.

**One holiday reader, not three.** `loadHolidays()` existed identically in
`booking/service.ts` and `booking/seat-release.ts` — the same query, typed by
hand twice. Extracted to `src/lib/holidays.ts` and both call sites updated, so
adding the room booking's own copy would have made a fourth. Behaviour is
unchanged; this is the DRY pass that was already overdue before this PR added
a reason to need it a third time.

**Attendees, beyond the organiser.** `room_booking_attendees` (0006) is new:
`room_booking_id`, a nullable `user_id`, and a `name`/`email` that are always
populated. Nullable is not an oversight — a client or a vendor invited to a
meeting has no row in `users` to point at, and the room still has to show who
is coming. Resolution is by email, case-insensitive, against active accounts
only; a match copies the account's own display name across, a miss falls back
to a name derived from the email's local part ("aparna.modi" becomes "Aparna
Modi") so an external attendee never shows as a bare address on the grid.

**Emails only, not a picker.** The invite field on the booking dialog is a
single comma-separated input, matching Outlook's own "To:" field rather than
introducing a searchable multi-select. It has to accept an address that is not
a CBVA account at all — a picker built against `users` could not — and it is
one field, not new UI chrome, which is the right size for a feature the brief
never asked for by name.

**Deduplicated and self-exclusive.** Emails are lower-cased and de-duplicated
before anything is inserted, and the organiser's own address is dropped from
the list rather than stored as a redundant attendee — they are already on the
booking as its organiser. `room_booking_attendees_unique` on
`(room_booking_id, email)` backs this at the database level too.

**`bookedByCount` is not `bookingCount`.** The room header on `/rooms` now
answers "how many people booked this room today" — computed as distinct
organisers, not a count of bookings, from the same rows the grid already
fetches for the day, no second query. One person holding three separate hours
in the same room reads as 1 person, not 3, because that is the question that
was asked. The raw booking count is kept alongside it for a screen that wants
both.

**A migration collision, caught by testing against a real database rather
than trusting a clean `npm run db:migrate` exit.** The first draft of 0006
reused an arbitrary journal timestamp that another in-flight branch had
already used for its own, differently-named 0006 migration. Applied to the
same shared development database, Drizzle silently treated this one as
already-run and skipped it — no error, `migrations applied` printed, and the
new table simply did not exist. Caught only by querying `to_regclass` after
the fact, not by the migration command's own exit code. Fixed by picking a
distinct timestamp; the lesson is general enough to be worth writing down —
**a successful migration run has to be verified against the schema it claims
to have produced, not trusted from its exit code.**

**Cost.** A fourth table joined onto `room_bookings`, one extra query per grid
load (batched across every booking in the day, not per-booking), and a new
optional field on an input schema that used to have none. The date checks add
one settings read (holidays) to a write path that was previously office-hours
and nothing else.
