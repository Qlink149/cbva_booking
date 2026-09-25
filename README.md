# CBVA Workspace

Office desk and meeting-room booking for CBV & Associates LLP, Mumbai — and the
occupancy analytics behind it, which is the actual point.

**Live demo: https://cbva-workspace.vercel.app**

CBVA run a one-day-a-week work-from-home policy, so desks sit empty on an
unpredictable pattern and the firm cannot forecast next-day capacity. Staff at
Assistant Manager grade and below book a desk to come in; Manager and above hold
allocated ones. **The booking flow is how the data gets collected. The analytics
is what was commissioned** — occupancy by day, zone, bay and team, so partners
can right-size the desk count against headcount with evidence rather than
opinion.

---

## From a clean clone

```bash
git clone <repo> && cd cbva_booking
npm install

cp .env.example .env.local        # then fill in BOTH connection strings
npm run db:migrate                # creates the schema
npm run seed                      # 141 desks, 141 people, 8 weeks of history
npm run dev                       # http://127.0.0.1:8081
```

### Password sign-in

The demo role switcher remains available in `APP_MODE=demo`. For password
sign-in, set a random `JWT_SECRET` of at least 32 characters in the deployment
environment, run the migrations, and provision each user deliberately with
`npm run auth:set-password` using `AUTH_USER_EMAIL` and `AUTH_USER_PASSWORD`
environment variables. Seed data never assigns a shared password. Self-service
password reset is intentionally not enabled until a real email-delivery adapter
is configured.

You need a **Postgres 15+** database. We use Neon; anything with the `btree_gist`
extension available will do — the meeting-room overlap rule needs it.

**Two connection strings, both required.** `DATABASE_URL` is the pooled endpoint
and serves the Next.js runtime. `DATABASE_URL_UNPOOLED` is the direct one and
serves migrations, the seed and the tests: PgBouncer's transaction pooling
breaks DDL sequencing and makes the two-parallel-transaction constraint proofs
non-deterministic. See ADR-001.

Everything else in `.env.example` is optional on a laptop.

### Have a look around

| | |
|---|---|
| `/floor` | The architect's drawing with 141 live desks on it. Toggle 3D. |
| `/bookings` | Your desks, plus the "My desk" tab — release an allocated desk, manage repeats. |
| `/who` | Who is in on a given day, and where. |
| `/admin/analytics` | **The deliverable.** Today, Forecast and Trends. |
| `/styleguide` | The design system, including every seat status shown desaturated. |

The role switcher (top right) becomes anybody on the staff list — it is a demo
control and is labelled as one. Start as **Aarav Agarwal**, who is a partner and
an admin.

---

## Commands

```bash
npm run dev              # http://127.0.0.1:8081  (3000 is a busy default)
npm run build            # production build
npm run typecheck        # tsc --noEmit — covers src, tests, e2e and scripts
npm run lint             # eslint, including the new Date() ban

npm test                 # vitest: unit + the constraint and concurrency proofs
npm run e2e              # playwright

npm run db:migrate       # apply drizzle/*.sql
npm run seed             # idempotent; refuses to run with APP_MODE=production
npm run db:reset         # drop and recreate the public schema (destructive)
npm run db:backfill-slots
npm run jobs:run         # auto-release, series, notifications, calendar retry — once
npm run db:purge-test-data  # remove fixtures an interrupted test run left behind

npm run build:floorplan  # re-read the architect's PDF; outputs are committed

# The DEPLOYED demo. These target a different database — see docs/RUNBOOK.md.
npm run prod:check                        # read-only health check. Safe.
npm run prod:migrate -- --yes-production
npm run prod:seed    -- --yes-production
npm run deploy                            # vercel deploy --prod
```

> **The e2e suite mutates demo data on purpose** — the walkthrough books,
> cancels and auto-releases real rows. Run `npm run seed` afterwards to restore
> a presentable floor.
>
> **If you interrupt a test run**, follow it with `npm run db:purge-test-data`.
> The integration fixtures clean up in `afterAll`, which a killed run never
> reaches, and the debris is not inert — orphan seats break the "141 desks"
> assertion, orphan users make the seed report 145 people, and an orphan
> recurring series keeps queueing failure mail that breaks an unrelated test.

---

## Documentation

Read in this order.

| | |
|---|---|
| **[CLAUDE.md](CLAUDE.md)** | **Read first.** The stack, and the six rules that hold the design together — the clock rule, the slot rule, the write rules, the notification rule, the adapter rules, the floor-plan rules. |
| **[docs/PROJECT.md](docs/PROJECT.md)** | The living spec: what the product *is*. |
| **[docs/RUNBOOK.md](docs/RUNBOOK.md)** | **Operating the live demo.** Which database is which, where the credentials are, how to seed production safely, and what breaks it. Read before touching production. |
| **[docs/PHASE-5-HANDOFF.md](docs/PHASE-5-HANDOFF.md)** | What exists today, what it cost, and every defect found on the way. |
| **[docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)** | **The client-facing list.** Everything we assumed, and what changes if the answer differs. Send this one. |
| **[docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md)** | A ten-minute walkthrough for whoever presents it, including what to say about each open question. |
| **[docs/DEMO-TO-PRODUCTION.md](docs/DEMO-TO-PRODUCTION.md)** | Exactly what changes to go live, what CBVA must supply, and effort per item. |
| **[docs/DECISIONS.md](docs/DECISIONS.md)** | 41 ADRs. Every architectural choice worth defending, with its cost. |
| **[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md)** | The engineering record behind OPEN-QUESTIONS, with file references and derivations. |

Earlier handoffs: [Phase 4](docs/PHASE-4-HANDOFF.md) (the 3D view),
[Phase 3](docs/PHASE-3-HANDOFF.md) (the booking engine),
[Phase 2](docs/PHASE-2-HANDOFF.md) (the CAD pipeline),
[Phase 1](docs/PHASE-1-HANDOFF.md) (the foundation).

---

## How it is put together

```
src/
  app/                     routes; api/ is the HTTP boundary
  lib/analytics/           THE MEASURE VOCABULARY — measures · queries · csv · filters
  lib/booking/             service · auto-release · seat-release · series · rules · authorise
  lib/adapters/            the four integrations; the ONLY place APP_MODE is branched on
  lib/clock.ts             THE CLOCK RULE
  lib/slots.ts             the one place starts_at/ends_at is derived
  components/analytics/    the charts, hand-rolled SVG
  components/floor-plan/   2D and 3D over one seat array; three/ is the only three import
  data/floorplan/          generated by build:floorplan, committed, source of truth
drizzle/                   hand-written SQL; four migrations
tests/                     unit + the integration proofs
e2e/                       playwright
```

Six rules do most of the load-bearing work, and every one of them exists because
breaking it produced a real bug at some point:

- **Never read the system clock in business logic.** Lint fails the build.
  It is what makes "advance the demo clock and watch the real job release a real
  desk" a demonstration rather than a simulation.
- **Slots are data, not a type.** Moving CBVA to hourly booking is a settings
  edit.
- **Integrity lives in the database.** No app-level "is this seat free?" check
  exists, and none may be added.
- **The notification log is an outbox**, written inside the booking transaction.
- **`APP_MODE` is branched on in exactly one file.**
- **One colour vocabulary**, seven seat statuses, each with a non-colour cue.

---

## Deployment

Vercel, with Neon Postgres. **Two databases**: the deployment has its own
project (`ep-bold-dream-b36xsna6`), and local development and the test suites
use another (`ep-empty-hall-az0hv77p`) — the suites mutate demo data
deliberately, so sharing one would mean a test run changing what somebody is
looking at on the live URL.

The deployed database's credentials are in `.env.production.local`, which is
**not committed**. Recover it with `npx vercel env pull` if it is missing.

```bash
npm run prod:check                        # which database, and is it presentable
npm run prod:seed -- --yes-production     # rebuild the demo history
npm run deploy
```

**[docs/RUNBOOK.md](docs/RUNBOOK.md)** is the operating guide — read it before
touching production. Going live for real is
**[docs/DEMO-TO-PRODUCTION.md](docs/DEMO-TO-PRODUCTION.md)**.

---

## Status

Phases 1–5 complete. The product is feature-complete and deployed as a demo.

Four integrations — Entra sign-in, Graph mail, the room calendar and the badge
reader — are stubbed behind interfaces because they need tenant access we do not
have. Each production stub **throws with a TODO naming the exact API call**, so
`APP_MODE=production` fails loudly on the first request rather than quietly
losing bookings. Wiring them is roughly 8–13 days, about half of it blocked on
CBVA rather than on us.

Five questions are open with the client. Two of them — the Manager/Assistant
Manager split, and whether anybody sits in Zone B — set the denominator for
every occupancy figure the product reports, and until they are answered the
headline number is provisional. It says so on screen.
