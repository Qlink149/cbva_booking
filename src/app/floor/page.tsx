import { Suspense } from "react";

import type { Metadata } from "next";

import { FloorClient } from "@/app/floor/floor-client";
import { floorplanDetectionReport, floorplanMeta } from "@/lib/floorplan";
import { TOTAL_SEATS } from "@/lib/seed-data/inventory";

export const metadata: Metadata = { title: "Floor Map" };

export default function Page() {
  const interpolated = floorplanDetectionReport.bays.reduce(
    (n, b) => n + b.interpolated,
    0,
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl">Floor Map</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Floor 4, drawn from the architect&rsquo;s furniture layout. Pick a day
          and a slot, then choose a desk.
        </p>
      </header>

      {/* useSearchParams reads the URL on the client, so the plan needs a
          boundary or the whole route opts out of static rendering. */}
      <Suspense
        fallback={
          <div
            className="h-[clamp(26rem,70vh,50rem)] rounded-md border border-hairline bg-surface-sunken"
            role="status"
            aria-label="Loading the floor plan"
          />
        }
      >
        <FloorClient />
      </Suspense>

      <p className="text-xs text-ink-subtle">
        Geometry extracted from {floorplanMeta.source} ·{" "}
        {floorplanDetectionReport.bays.reduce((n, b) => n + b.detected, 0)} of {TOTAL_SEATS}
        desks located from the architect&rsquo;s own desk numbers
        {interpolated > 0 ? `, ${interpolated} positioned by interpolation` : null} ·
        plan scale {floorplanMeta.mmPerUnit ? `${floorplanMeta.mmPerUnit} mm per unit` : "unresolved"}
      </p>
    </div>
  );
}
