# What the Workspace system does

A plain-language guide for CBV & Associates LLP. No jargon, no file names —
just what the system does, for whom, and why it works the way it does.

---

## 1 · What problem this solves

Since the firm moved to a one-day-a-week work-from-home policy, desks sit
empty on a pattern nobody can see. Two consequences follow: staff cannot
always find a colleague or a free desk, and the firm has no way to tell
whether it is holding onto more office space than it actually needs.

**Booking a desk is the visible half of this system. The other half — the
one the firm is actually buying — is the record that booking leaves behind.**
Every time somebody books, checks in, or has a desk released because they
never showed up, that becomes a data point about how the floor is really
used. Over weeks, that turns into an answer to the question that actually
matters: *is Floor 4 the right size for the people on it?*

Everything below is either the mechanism that collects that data honestly, or
a rule that keeps the data trustworthy once collected.

---

## 2 · Who uses it, and for what

**Staff at Assistant Manager grade and below** — the majority of the firm —
must book a desk for each day they come into the office:

- See the floor plan for any day in the booking window and pick a free desk.
- Check in on arrival, by scanning the QR code printed on the desk, so the
  system knows the booking turned into an actual day in the office.
- See who else on their team is in on a given day, before they decide whether
  to come in themselves.
- Edit or cancel a booking, up until a cut-off close to the start of the day.
- Set up a booking that repeats every week on the same day, instead of
  booking from scratch each time.

**Managers, Directors and Partners** hold a permanently allocated desk and
never need to book one. In addition, they can:

- Give their own desk back to the pool for a day they are working from home —
  the only way an allocated desk is ever counted as used or free, since an
  empty allocated desk otherwise tells the system nothing.
- Book any of the five meeting rooms, by the hour.

**Administrators** (a small group in HR/IT, plus at least one partner) run the
firm's side of the system:

- Decide which physical desks are allocated to fixed-grade staff, and to
  whom.
- Manage the staff list — who exists, their grade, their team.
- Set the booking rules — see §5.
- Read the occupancy analytics — see §6.
- Look up who did what and when, if a booking needs investigating.
- Print a fresh sheet of desk QR codes if stickers need replacing.

---

## 3 · What the system guarantees, and why that is unusual

Two things are **guaranteed by the database itself**, not by the application
checking carefully. That distinction matters: an application-level check can
be beaten by two people acting in the same instant — one request checks "is
this free?", gets "yes", and a second request asks the identical question a
thousandth of a second later and also gets "yes", before either has actually
claimed the desk. A database constraint closes that gap entirely, because the
database itself refuses the second write outright, at the moment it happens,
no matter how close together the two attempts are.

- **A desk cannot be double-booked.** If two people tap the same desk for the
  same day and time slot at the same moment, one booking succeeds and the
  other is refused — immediately, and the person who lost sees the plan
  refresh to show the desk is now taken. This cannot be bypassed by a bug, a
  slow connection, or two people being unlucky enough to click at once.
- **A meeting room cannot be double-booked**, on the same basis, for any
  overlapping stretch of time.

This is a genuine differentiator, not a caveat. Most booking tools rely on
checking availability and then writing the booking as two separate steps, and
that gap is exactly where a double-booking sneaks in under load. This system
does not have that gap.

---

## 4 · The rules, and why each one exists

**The booking window.** Desks can be booked up to a set number of working
days ahead (five, today). This is configurable — see §7.

**The cut-off.** Editing or cancelling a booking closes a set number of
minutes before the slot starts (sixty, today). Two things are worth knowing
about it: it does **not** stop somebody booking a desk that has already gone
unused partway through a slot — that is exactly how an auto-released desk (see
below) gets a second life — and it does **not** apply once somebody has
actually checked in, because leaving early and releasing the desk should
always be possible.

**The two-hour auto-release rule.** If nobody checks in to a booked desk
within two hours of the slot starting, the booking is automatically released
and the desk goes back into the pool for anyone else to take. This is the
mechanism that turns a "claimed" desk that never gets used into a "free" desk
somebody else can actually sit at, and it is also what keeps the occupancy
numbers honest — a desk nobody used does not get counted as occupied. Before
release happens, the person gets one reminder, halfway through that window, in
case they simply forgot to scan the QR code.

**Everyone books their own desk.** A desk can only be booked by the person who
will sit at it — nobody, including administrators, can book one on somebody
else's behalf. (Administrators can still cancel a booking if they need to.)

**One desk per person, per day, per slot.** A person cannot hold two desks at
once for the same time.

---

## 5 · The edge cases — handled, in plain terms

Eighteen specific situations were identified as things a booking system has
to get right, not just the common path. All eighteen are handled, and they
are tested every time a change is made to the system, so they cannot silently
break later. In the words a non-technical reader would use:

- **If two people tap the same desk at the same moment**, one gets it and the
  other is told immediately and shown a refreshed map — never a silent
  failure, never two people turning up to the same chair.
- **If somebody edits the same booking twice at once** (from two browser tabs,
  say), one edit wins and the other is told clearly that something changed
  under them, rather than silently overwriting or corrupting the booking.
- **If a desk is taken out of service** while it has live bookings, the system
  refuses by default and lists exactly who is affected, so nobody is silently
  displaced — an administrator has to explicitly confirm before anyone is
  moved, and everyone affected is notified.
- **If someone leaves the firm**, their upcoming bookings are automatically
  cancelled and both they and whoever booked on their behalf (if anyone) are
  told.
- **If the automatic release job runs twice in a row** (which happens
  routinely — it checks every few minutes), the second run simply finds
  nothing left to do. It never releases the same desk twice or sends a
  duplicate email.
- **If a meeting is booked to start the exact instant another one in the same
  room ends**, that is allowed — back-to-back is not a conflict. An actual
  overlap, even by a minute, is refused.
- **If the calendar sync to Outlook is down** when a room is booked, the
  booking still goes through — it is never held hostage by an external
  service being unavailable — and the calendar entry is created automatically
  once the service comes back.
- **If sending a confirmation email fails**, the booking is unaffected; the
  email is retried automatically until it sends.
- **If the shared demo clock is wound backwards** (a demo-only feature, see
  §8), nothing that already happened is undone — a released desk stays
  released, a completed booking stays completed.

The common thread: a booking, once made, is treated as something that
actually happened and has to be reasoned about carefully, not something that
can be silently lost, duplicated, or quietly overwritten.

---

## 6 · The analytics — the actual product

Three separate figures are reported side by side, deliberately, rather than
one combined number:

- **Seats booked** — how many desks were claimed. This is demand: how many
  people wanted a desk that day.
- **Seats attended** — how many of those bookings turned into an actual
  check-in. This is what really happened.
- **Seat-hours consumed** — how long desks were actually held, in aggregate,
  accounting for early releases and no-shows.

**Why three numbers and not one.** A desk that gets booked and never used is
a real cost — it was unavailable to anyone else for at least part of the day —
but it is a different kind of cost from a desk that was genuinely sat in all
day. Collapsing the two into a single occupancy percentage would hide exactly
the finding the firm is buying this tool to surface: how much of the
"booked" figure is real use, and how much is no-shows. The gap between
"booked" and "attended" is, itself, a number worth knowing — it is what
no-shows cost the firm in desk-hours.

**Three views of that data:**

- **Today** — what is happening on the floor right now, refreshing on its
  own.
- **Forecast** — the next five working days, so the firm can see tomorrow
  filling up before it arrives, which is the thing partners specifically said
  they had no way to do before.
- **Trends** — eight weeks of history: the busiest and quietest days of the
  week, which bays run hottest, and the peak versus typical occupancy — the
  gap between those two is what the firm is paying for at peak capacity, over
  and above a typical day.

Everything on any of these screens can be exported to a spreadsheet, over the
exact filters currently on screen.

---

## 7 · What CBVA can change without asking us

An afternoon's work in the admin screens, no waiting on a developer, no risk
to anything already booked:

- Which desks are allocated to which fixed-grade staff.
- Slot times — including moving from half-day slots to hourly booking, which
  is a configuration change here, not a rebuild.
- How far ahead people can book, the cut-off, and the auto-release grace
  period.
- The public holiday calendar.
- Seat inventory — taking a desk out of service, bringing one back.
- Meeting room names and capacities.
- Staff records — grade, team, who has an allocated desk.
- Zone names on the floor plan.

---

## 8 · What is simulated in this demo, and what would be real

Told plainly, because a client discovering this on their own later is worse
than being told now.

Four things are stand-ins for systems the firm has not yet connected this
tool to:

- **Signing in.** The demo lets you switch between seeded people from a
  dropdown. In production this becomes the firm's actual Microsoft sign-in —
  the same login staff already use for email — so nobody has a separate
  password to remember, and nobody can pretend to be somebody else.
- **Outlook sync.** Meeting room bookings made here are designed to appear on
  the room's calendar automatically. That connection needs to be switched on
  with the firm's IT, and — importantly — the firm needs to decide whether
  rooms can still be booked directly from Outlook once this system is live,
  or only from here. Booking a room in two places that do not talk to each
  other is exactly the double-booking problem this tool exists to prevent,
  reintroduced through the back door — see the open question on this in
  `OPEN-QUESTIONS.md`.
- **Email.** Every confirmation, reminder and release notice is generated and
  ready to view in an inbox screen within the demo. Actually sending it
  requires the firm's mail system, which is a short piece of setup with IT.
- **The door badge reader.** A badge swipe at reception is meant to be a
  second, independent signal that somebody is in the building. The system is
  ready for it; it needs to know which vendor and system the firm's badge
  readers use before it can be connected.

None of these four affect how booking, cut-offs, auto-release or the
analytics behave — they are purely about how identity, email, the room
calendar and door badges reach the system, not what the system does with
them once they arrive. Desk booking itself does not depend on any of the
four and works exactly the same before and after they are connected.

---

## 9 · Known limitations

- **A QR scan at a desk proves the booking, not certainty about who is
  physically in the chair.** The code printed on a desk is not a secret — it
  sits in an open-plan office in plain view — so, in principle, somebody who
  knows a colleague's booking and their desk's code could check in without
  physically being there. In exchange, it gives something a door badge alone
  cannot: which specific desk was used, not just that somebody entered the
  building. That is why both exist as separate, distinguishable signals in
  the system rather than one being treated as proof of the other.
- **A door badge only proves someone reached the floor, not which desk they
  used.** This is exactly why desk-level QR check-in exists alongside it —
  together they answer both "did anyone come in" and "which desk did they
  actually sit at", which neither answers alone.
- **Two open questions currently limit how much weight the headline occupancy
  number can carry**, both listed in `OPEN-QUESTIONS.md`: the true split of
  staff between Manager and Assistant Manager grade (which sets how many
  people must book at all), and whether the north-west wing is used as a
  workspace on a normal day. Until those are answered, the analytics screens
  say so on screen rather than presenting a number with unstated caveats.
