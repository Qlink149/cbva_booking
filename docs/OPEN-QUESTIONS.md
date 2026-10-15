# Three questions for CBVA

This is everything we still need from you. There were nine when we started.

**Five of them became admin screens** — you can answer those yourselves, in an
afternoon, without us deploying anything. **One was answered by your own
drawing** once we read it properly. What is left is three questions that nobody
outside CBV & Associates can answer, and they are below in the order they
matter.

Each one says what we assumed, why we had to assume something, and — the part
that matters — **what changes if the answer is different**.

---

## 1. How do the 54 CAs split between Manager and Assistant Manager?

**We need an HR list:** name, email, grade, team, and whether the person holds
an allocated desk.

**We assumed** 22 Managers (allocated desk) and 32 Assistant Managers (must
book).

### Why this is first, and why it is the only thing still holding a number back

This single split sets the **denominator for every occupancy figure in the
product**. It decides how many people must book a desk, which is the demand
side of the only question you commissioned this tool to answer: are you paying
for more desks than you need?

Here is the structure of it, which is worth understanding before you answer,
because it is not obvious:

> **The 110 bookable desks are a fixed, physical fact — which specific 47
> desks are allocated to fixed grades, plus one (desk 142) out of service,
> leaving 110 in the pool.** That does not move when the headcount split
> changes. What moves is DEMAND: how many people the true split puts into a
> bookable grade.

So the desk supply is not the unknown here — 93 is measured against the
running system, not assumed. What the split actually decides is whether that
fixed supply is comfortable or precarious:

| If the real split is | People who must book | Against 93 bookable desks | The floor is |
|---|---|---|---|
| 22 / 32 (our guess, current) | 94 | 93 | **short by 1** |
| 15 / 39 | 101 | 93 | **structurally short by 8** |
| 30 / 24 | 86 | 93 | 7 desks of slack |

**Even on our own guessed split, the floor is one desk short, not exactly
balanced** — 94 people (32 Assistant Managers + 62 Articles) must book
against 93 bookable desks. That one-desk gap is too small to be the finding
by itself, and it is here so the table is honest about what is actually
seeded today rather than the rounder "exactly balanced" a whole-number split
suggests. The real range — from a 1-desk shortfall to an 8-desk shortfall to
a 7-desk surplus, depending on where the true split falls — is the finding.
We are not willing to hand a partner a capacity number built on a split we
invented, so until this arrives the headline figure carries a caveat on
screen.

**Where the answer goes:** Admin → People. Grade and seat mode are editable per
person. Nothing is deployed.

---

## 2. Who are the 17 people at the new Zone B desks?

> **Your revised layout (R009, 17 June 2025) adds 17 numbered workstations in
> the north-west wing — desks 9 to 25, bay C — and its headcount adds a line
> "B. = 17 PAX" with no grade against it. We have treated them as bookable
> hot desks and the 17 as staff who book (7 Assistant Managers, 10 Articles).
> Is that right, and who are they?**

One sentence closes it; the HR list in question 1 closes it on its own.

Everything below this line was the question as it stood before R009, when
the wing was drawn with no desks at all. It is kept because the derivation
explains what the rest of the wing's furniture is.

### (Superseded) Is Zone B used as a workspace on a normal day?

> **Zone B is drawn as a flexible room with eight foldable tables on castors.
> Do staff work there on a normal day, or is it used only for training and
> all-hands?**

That is the whole question. One sentence closes it.

### We already know what the room *is* — your drawing is unusually clear

We went back to your furniture layout and read it at the vector level rather
than by eye. Zone B is the north-west wing:

| | |
|---|---|
| Seat-count (`N PAX.`) annotations anywhere in the wing | **none** |
| Rapid-rail workstation hatch | **none** |
| Screen-only workstation hatch | **none** |
| Foldable-table hatch | **714 marks — more than the rest of the floor combined** |
| Your own note, inside this wing | *"Foldable table on castors: 2'-9" × 4'-0" = 5 nos, 2'-6" × 5'-0" = 3 nos"* |

A wing with no seat count, no workstation hatch of either type, and eight
foldable tables on castors is a **flexible room**, not a bank of desks. That
also explains the 33 chairs we could not previously account for: eight foldable
tables, a sofa lounge, and the storage credenzas along the outer wall. The floor
plan now draws all of it and labels it, so you can see exactly what we are
describing.

**What a drawing cannot tell us is how you use it.** Hence the question.

### What changes if the answer is "yes, people work there"

Those desks become bookable, the pool grows from 93 to somewhere nearer 115, and
every occupancy percentage comes **down**. That is an upside correction we can
apply in an afternoon, not a reason to distrust today's numbers — which is why
this is no longer holding the headline figure back. Question 1 is.

---

## 3. Are the five meeting rooms already Outlook resource mailboxes?

**We assumed** that this application owns room booking, and built accordingly.

**This is the question most likely to embarrass the product in front of your
staff**, and it is the one we would most like a decision on before go-live.

### The problem, plainly

This product enforces one booking per room per time range **in the database**,
with a constraint that cannot be raced. Two people pressing Book at the same
instant cannot both succeed. That guarantee is real, and it holds for bookings
made **here**.

It says nothing whatsoever about a meeting booked in Outlook.

If Boardroom, A9, A8, A7 and A6 already exist as **room resource mailboxes** —
and in a Microsoft 365 tenant they almost certainly do, because that is how
anybody books a room from the Outlook picker today — then staff will go on
booking them the way they always have. Our grid will show the hour as free.
Somebody will book it. Two groups will arrive.

That is not a smaller version of the problem you asked us to solve. It is the
same problem, made harder to diagnose, because now there are two systems each
confident it is correct.

The calendar sync we built is **one-way**: Outlook is told about our bookings,
nothing tells us about theirs. **A one-way sync can announce a conflict. It can
never prevent one.**

### We need one of two decisions, and it is yours

1. **Exclusive booking rights.** The room mailboxes are configured so only this
   application's service account may book them, and everyone is directed here.
   Simplest to build, and the only option that makes our guarantee true. It
   costs your staff the Outlook room picker they are used to.
2. **Two-way sync.** We subscribe to Graph change notifications per room mailbox
   and mirror external bookings in before showing the grid. Keeps Outlook
   working, but the guarantee weakens from "impossible" to "usually caught
   quickly" — a race is then resolved by whoever Graph tells us about first,
   which is a reconciliation, not a constraint.

**Desk booking is unaffected either way.** Desks have no second system.

**We also need the resource mailbox address for each of the five rooms**, which
is what physically blocks the calendar sync regardless of which option you pick.

---

# Five questions became two admin screens

This is the part worth reading if you were expecting a longer list. These were
all open questions at the start, and none of them needs us any more.

| Was a question | Now | Where you answer it |
|---|---|---|
| Which physical desks are allocated, and to whom? | A dropdown per desk, about five minutes for all 47 | **Admin → Seats** |
| What are the slot boundaries? | Editable. Editing one recomputes every affected booking's stored times in the same transaction — and moving to hourly booking is a settings change, not a rebuild | **Admin → Settings** |
| How far ahead can people book? The cut-off? The check-in window? | All three editable | **Admin → Settings** |
| Which days are public holidays? | Replace our 39-date list with your official circular | **Admin → Settings** |
| What are the five meeting rooms called? | Editable per room. We used your own bay tags rather than inventing names, so "Meeting Room A9" is a placeholder | **Admin → Seats / rooms** |

**And one was answered by your drawing rather than by you.** We had six meeting
rooms from a first reading. There are **five**, all in Zone A, and the
capacities come from the `PAX` annotations beside your own bay tags:

| Bay | Seats | Our placeholder name |
|---|---|---|
| A3 | 25 | Boardroom |
| A9 | 10 | Meeting Room A9 |
| A8 | 7 | Meeting Room A8 |
| A7 | 5 | Meeting Room A7 |
| A6 | 5 | Meeting Room A6 |

Two of our capacities were wrong and one room did not exist. **The counts are
now yours, not ours**, and they reconcile independently: 25 + 10 + 7 + 5 + 5 =
52, plus the 8-seat workstation run in A1/A2 is 60, which is exactly the zone-A
total on your sheet.

---

## Two smaller things, for completeness

**We removed two labels rather than keep guessing.** Zones C and D were shown as
"Audit Floor" and "Tax & Advisory Floor". Your drawing labels the wings A–D and
never says what the people in them do, so both names were ours. They now read
simply "Zone C" and "Zone D", because a label you cannot check from the screen
it appears on is a guess wearing a fact's clothes. So, if you would like them
back:

> **Do wings C and D correspond to specific teams or functions? If so we will
> label them.** (Admin → Settings, one line each.)

**Desk names: we use the numbers and letters on your revised plan.** R009
numbers every desk 1–158 and marks every bay with a circled letter A–T, so that
is what the product shows and what will go on the QR stickers. The schedule in
the sheet's title block still uses the earlier names (A1, D1–D8, C1–C7, B1, B2,
PASSAGE). If staff on the floor know the bays by those older names, tell us and
we will show them as the bay's display name — one line each.

**Meeting rooms are carried over from the previous drawing.** R009 does not tag
the rooms or state their capacities; the rooms themselves have not moved. We
have kept the five rooms and capacities from R007 (Boardroom 25, A9 10, A8 7,
A7 5, A6 5). If any of that changed, say so.

---

## If you can only answer one thing

**Send the HR list.** It is the denominator for every number in the product, and
it is now the only thing holding the headline figure back.

Then question 3, because it is the one that can go wrong in front of your staff
rather than in a report.
