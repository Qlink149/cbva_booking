import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/primitives";
import { floorplanDetectionReport } from "@/lib/floorplan";
import { TOTAL_SEATS } from "@/lib/seed-data/inventory";

export const metadata: Metadata = { title: "Admin" };

/**
 * The admin index.
 *
 * The isAdmin gate lives in the layout now, not here — this page had none at
 * all until Phase 5, which was harmless while it was a list of links and is not
 * harmless now that it leads to the staff roster and every occupancy figure the
 * firm has.
 */
const TOOLS = [
  {
    href: "/admin/analytics",
    title: "Occupancy analytics",
    body: () =>
      "The deliverable. Live occupancy, a five-day forecast, and eight weeks of trend — including the day-of-week pattern and the bay heat map that make the case for the desk count.",
  },
  {
    href: "/admin/seats",
    title: "Seat inventory",
    body: (interpolated: number) =>
      interpolated === 0
        ? `All ${TOTAL_SEATS} desks: allocate one to somebody, take one out of service, or hand one back to the pool. Every desk sits where the architect numbered it.`
        : `All ${TOTAL_SEATS} desks: allocate one to somebody, take one out of service, or hand one back to the pool. ${interpolated} desk${
            interpolated === 1 ? "" : "s"
          } still sit on interpolated positions and are flagged in the floor plan editor for checking.`,
  },
  {
    href: "/admin/users",
    title: "People",
    body: () =>
      "Grade, seat mode, allocated desk, administrator access. The Manager / Assistant Manager split set here is the denominator for every number in the analytics.",
  },
  {
    href: "/admin/settings",
    title: "Settings",
    body: () =>
      "Slots, the booking window, the cut-off, the auto-release grace, the timezone and the holiday list. Every open question with the client is configuration here rather than a deploy.",
  },
  {
    href: "/admin/floor-plan",
    title: "Floor plan editor",
    body: () =>
      "Move, rotate and retire desks against the architect's drawing. Corrections are exported back to the committed geometry, so they survive a database reset.",
  },
  {
    href: "/admin/jobs",
    title: "Scheduled jobs",
    body: () =>
      "What auto-release would do on its next run, before it does it — plus the recurring-booking materialiser, the outbox and the batch-cap bound.",
  },
  {
    href: "/admin/notifications",
    title: "Notification outbox",
    body: () =>
      "Every message the product has produced, rendered as it would have been sent. In demo mode this is the mailbox — nothing leaves the machine.",
  },
  {
    href: "/admin/audit",
    title: "Audit log",
    body: () =>
      "Every write, by whom and when, including the ones the scheduled jobs made on their own.",
  },
  {
    href: "/admin/qr",
    title: "Desk QR codes",
    body: () =>
      "The printable sheet: one sticker per bookable desk. Scanning one checks that person in to that desk, which is what makes occupancy seat-level rather than door-level.",
  },
] as const;

export default function Page() {
  const interpolated = floorplanDetectionReport.bays.reduce((n, b) => n + b.interpolated, 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl">Admin</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-muted">
          The occupancy analytics, and everything needed to keep it honest.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Tools</CardTitle>
        </CardHeader>
        <CardBody className="divide-y divide-hairline">
          {TOOLS.map((tool) => (
            <div key={tool.href} className="py-3 first:pt-0 last:pb-0">
              <Link
                href={tool.href}
                className="text-sm font-medium text-navy underline underline-offset-4"
              >
                {tool.title}
              </Link>
              <p className="mt-1 max-w-2xl text-sm text-ink-muted">
                {tool.body(interpolated)}
              </p>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
