import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FloorPlanEditor } from "@/app/admin/floor-plan/editor";
import { auth } from "@/lib/adapters";
import { bookableDates } from "@/lib/booking-days";
import { getSettings } from "@/lib/settings";
import { getClock } from "@/lib/clock";
import { db } from "@/lib/db";
import { loadHolidays } from "@/lib/holidays";
import { floorplanDetectionReport } from "@/lib/floorplan";
import { Card, CardBody, CardHeader, CardTitle, Table, Td, Th } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Floor Plan Editor" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const viewer = await auth().currentUser();
  // The Admin nav item is hidden from non-admins, which is a courtesy. This is
  // the check.
  if (!viewer?.isAdmin) notFound();

  const clock = await getClock();
  const database = db();
  const settings = await getSettings(database);
  const holidays = await loadHolidays(database);

  const dates = bookableDates({
    now: clock.now(),
    workingDays: 1,
    calendarBound: settings.bookingWindowDays,
    holidays,
    timezone: settings.timezone,
  });
  const date = dates[0] ?? "2026-01-01";
  const slot = settings.slotDefinitions[0]?.key ?? "AM";

  const report = floorplanDetectionReport;
  const detected = report.bays.reduce((n, b) => n + b.detected, 0);
  const interpolated = report.bays.reduce((n, b) => n + b.interpolated, 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl">Floor Plan Editor</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Drag a desk to where it actually is. Changes save to the database and are
          exported back to the committed geometry, so they survive a re-seed.
        </p>
      </header>

      <FloorPlanEditor date={date} slot={slot} />

      <Card>
        <CardHeader>
          <CardTitle>Detection, per bay</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="mb-3 text-xs text-ink-muted">
            {detected} of 141 desks were located from the drawing&rsquo;s own geometry;{" "}
            {interpolated} were extended along their bay&rsquo;s axis to make the
            scheduled count. <strong>Pax</strong> is the annotation the architect wrote
            on the drawing; where it is blank, the bay size rests on our assumption
            rather than on the drawing.
          </p>
          <Table>
            <caption className="sr-only">
              Detected versus expected seat count for each bay
            </caption>
            <thead>
              <tr>
                <Th scope="col">Bay</Th>
                <Th scope="col">Zone</Th>
                <Th scope="col" numeric>
                  Pax on drawing
                </Th>
                <Th scope="col" numeric>
                  Scheduled
                </Th>
                <Th scope="col" numeric>
                  Detected
                </Th>
                <Th scope="col" numeric>
                  Interpolated
                </Th>
              </tr>
            </thead>
            <tbody>
              {report.bays.map((bay) => (
                <tr key={bay.bay}>
                  <Td>
                    <span className="seat-code text-xs">{bay.bay}</span>
                  </Td>
                  <Td>{bay.zone}</Td>
                  <Td numeric>{bay.drawingPax ?? "—"}</Td>
                  <Td numeric>{bay.expected}</Td>
                  <Td numeric>{bay.detected}</Td>
                  <Td numeric>{bay.interpolated || ""}</Td>
                </tr>
              ))}
              <tr>
                <Td>
                  <strong>Zone B</strong>
                </Td>
                <Td>B</Td>
                <Td numeric>—</Td>
                <Td numeric>0</Td>
                <Td numeric>{report.zoneBChairsDetected}</Td>
                <Td numeric></Td>
              </tr>
            </tbody>
          </Table>
          <p className="mt-3 text-xs text-ink-muted">
            The extraction found {report.unassignedChairs} chairs it could not
            assign to a scheduled seat, by zone:{" "}
            {Object.entries(report.unassignedChairsByZone)
              .map(([z, n]) => `${z} ${n}`)
              .join(" · ")}
            . Zone A&rsquo;s are the boardroom, conference rooms and reception
            lounge, so they are accounted for. Zone B&rsquo;s{" "}
            {report.zoneBChairsDetected} are not: that wing is marked &ldquo;NO
            CHANGE AREA — ONLY REPAIR WORK&rdquo;, labelled &ldquo;MODULAR
            FURNITURE&rdquo; and given no pax annotation. Whether staff sit there
            is an open question with CBVA (ASSUMPTIONS A16) and it sets the
            denominator for the Phase 5 occupancy figures.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
