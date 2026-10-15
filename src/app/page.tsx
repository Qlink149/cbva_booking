import Link from "next/link";
import { count, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getClock } from "@/lib/clock";
import { auth } from "@/lib/adapters";
import { APP_TIMEZONE } from "@/lib/config";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/primitives";
import { GRADE_LABEL } from "@/lib/seed-data/inventory";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: APP_TIMEZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const NAV_CARDS = [
  {
    href: "/floor",
    label: "Floor Map",
    description: "The architect's own drawing, live booking status, 2D or 3D.",
  },
  {
    href: "/bookings",
    label: "My Bookings",
    description: "Upcoming and past, check in, edit, cancel, or release your desk.",
  },
  {
    href: "/who",
    label: "Who's In",
    description: "Who is booked into the office today, and where they sit.",
  },
  {
    href: "/rooms",
    label: "Meeting Rooms",
    description: "The five rooms in Zone A, by the hour.",
  },
] as const;

/**
 * Home. Signed out, it is the front door — the full CBVA lockup and a
 * one-line description (Phase 8 / A2; there is no separate sign-in page, the
 * demo's "sign in" is the role switcher, top right). Signed in, it is a
 * live-data landing: today's numbers, real reads against the seeded
 * database, and the four screens most people actually open.
 */
export default async function HomePage() {
  const clock = await getClock();
  const now = clock.now();
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE }).format(now);

  const user = await auth().currentUser();

  const [inventory] = await db()
    .select({
      total: count(),
      bookable: sql<number>`count(*) filter (where ${schema.seats.status} = 'bookable')`,
      fixed: sql<number>`count(*) filter (where ${schema.seats.status} = 'fixed')`,
      blocked: sql<number>`count(*) filter (where ${schema.seats.status} = 'blocked')`,
    })
    .from(schema.seats);

  const [todayStats] = await db()
    .select({
      booked: sql<number>`count(distinct ${schema.bookings.seatId}) filter (where ${schema.bookings.status} in ('confirmed','checked_in','completed'))`,
      people: sql<number>`count(distinct ${schema.bookings.occupantUserId}) filter (where ${schema.bookings.status} in ('confirmed','checked_in','completed'))`,
      checkedIn: sql<number>`count(distinct ${schema.bookings.seatId}) filter (where ${schema.bookings.status} = 'checked_in')`,
    })
    .from(schema.bookings)
    .where(eq(schema.bookings.bookingDate, todayIso));

  const [headcount] = await db()
    .select({
      total: count(),
      bookableStaff: sql<number>`count(*) filter (where ${schema.users.seatMode} = 'bookable')`,
    })
    .from(schema.users);

  const bookable = Number(inventory?.bookable ?? 0);
  const bookedToday = Number(todayStats?.booked ?? 0);
  const utilisation = bookable > 0 ? Math.round((bookedToday / bookable) * 100) : 0;

  if (!user) {
    return (
      <div className="space-y-10">
        <section className="space-y-4 border-b border-hairline pb-8">
          {/* eslint-disable-next-line @next/next/no-img-element -- see wordmark.tsx */}
          <img
            src="/brand/cbva-logo@2x.png"
            alt="CBV & Associates LLP"
            width={450}
            height={202}
            className="h-20 w-auto sm:h-24"
          />
          <p className="max-w-prose text-sm text-ink-muted">
            Seat and meeting room booking for Floor 4, Mumbai — and the
            occupancy analytics behind it. Pick a person from the role
            switcher, top right, to sign in.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section>
        <p className="text-xs tracking-wide text-ink-subtle uppercase">
          {dateFormatter.format(now)}
        </p>
        <h1 className="mt-1 text-3xl text-ink">Good day, {user.displayName.split(" ")[0]}.</h1>
        <p className="mt-2 max-w-prose text-sm text-ink-muted">
          You are signed in as{" "}
          <strong className="font-medium text-ink">{GRADE_LABEL[user.grade]}</strong>
          {user.team ? `, ${user.team}` : null}.{" "}
          {user.seatMode === "fixed"
            ? "You have an allocated seat, so you do not need to book."
            : "You book a seat for each day you come in."}
        </p>
      </section>

      <section aria-labelledby="today-heading">
        <h2 id="today-heading" className="sr-only">
          Today at a Glance
        </h2>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-hairline bg-hairline lg:grid-cols-4">
          <Stat
            label="Seats Occupied Today"
            value={String(bookedToday)}
            hint={`of ${bookable} bookable`}
          />
          {/* The one gold-accented number on the page: the metric partners
              actually care about. */}
          <Stat label="Utilisation" value={`${utilisation}%`} accent />
          <Stat
            label="Checked In Now"
            value={String(Number(todayStats?.checkedIn ?? 0))}
            hint="via badge"
          />
          <Stat
            label="Headcount"
            value={String(Number(headcount?.total ?? 0))}
            hint={`${Number(headcount?.bookableStaff ?? 0)} must book`}
          />
        </dl>
      </section>

      <section className="grid gap-6 lg:grid-cols-3" aria-labelledby="go-heading">
        <h2 id="go-heading" className="sr-only">
          Where to go
        </h2>

        <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2">
          {NAV_CARDS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-md border border-hairline bg-surface p-4 transition-colors hover:border-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
            >
              <p className="text-sm font-medium text-ink">{item.label}</p>
              <p className="mt-1 text-xs text-ink-muted">{item.description}</p>
            </Link>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Floor 4 Inventory</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className="space-y-2 text-sm">
              <InventoryRow label="Total Desks" value={Number(inventory?.total ?? 0)} />
              <InventoryRow label="Bookable" value={bookable} />
              <InventoryRow label="Fixed Allocation" value={Number(inventory?.fixed ?? 0)} />
              <InventoryRow label="Blocked" value={Number(inventory?.blocked ?? 0)} />
            </dl>
            <p className="mt-4 border-t border-hairline pt-3 text-xs text-ink-subtle">
              Every desk is positioned from the architect&rsquo;s own desk number on
              drawing R009; corrections are made in{" "}
              <Link href="/admin/floor-plan" className="underline">
                the floor plan editor
              </Link>
              .
            </p>
          </CardBody>
        </Card>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-surface px-5 py-4">
      <dt className="text-xs tracking-wide text-ink-muted uppercase">{label}</dt>
      <dd className="mt-1.5 flex items-baseline gap-2">
        <span
          className={
            accent
              ? "border-b-2 border-gold pb-0.5 text-2xl leading-none font-semibold tabular text-ink"
              : "text-2xl leading-none font-semibold tabular text-ink"
          }
        >
          {value}
        </span>
        {hint ? <span className="text-xs text-ink-subtle">{hint}</span> : null}
      </dd>
    </div>
  );
}

function InventoryRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular font-medium text-ink">{value}</dd>
    </div>
  );
}
