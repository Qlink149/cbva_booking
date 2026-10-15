"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";

import { BarChart } from "@/components/analytics/charts/bar-chart";
import { Heatmap } from "@/components/analytics/charts/heatmap";
import { LineChart } from "@/components/analytics/charts/line-chart";
import { CHART_SERIES_COLORS, seriesColors } from "@/components/analytics/charts/chart-frame";
import { FilterBar, MeasureExplainer } from "@/components/analytics/filter-bar";
import {
  measureUnit,
  measureValue,
  useTrends,
} from "@/components/analytics/use-analytics";
import { Card, CardBody, CardHeader, CardTitle, EmptyState, StatusMessage, Table, Td, Th } from "@/components/ui/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat, StatRow } from "@/components/ui/stat";
import { WidgetBoundary } from "@/components/ui/widget-boundary";
import { MEASURES } from "@/lib/analytics/measures";
import { TERMINAL_STATUS_LABELS } from "@/lib/analytics/measures";
import { WEEKDAY_LABELS } from "@/lib/analytics/types";

export function TrendsClient() {
  const params = useSearchParams();
  const { data, isPending, error } = useTrends(new URLSearchParams(params.toString()));

  const measure = data?.filters.measure ?? "booked";
  const unit = measureUnit(measure);

  if (error) {
    return (
      <StatusMessage tone="danger">
        The analytics could not be loaded. {(error as Error).message}
      </StatusMessage>
    );
  }

  if (isPending || !data) {
    return (
      <div className="space-y-6" role="status" aria-label="Loading analytics">
        <Skeleton className="h-16" />
        <Skeleton className="h-28" />
        <Skeleton className="h-72" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const h = data.headline;
  const pool = h.pool || 1;
  const peakPct = Math.round((h.peak / pool) * 100);
  const headroom = pool - h.peak;

  /* --------------------------------------------------------- the day series */

  const dayKeys = [...new Set(data.days.map((d) => d.date))].sort();
  const bySlot = new Map<string, Map<string, (typeof data.days)[number]>>();
  for (const row of data.days) {
    if (!bySlot.has(row.slot)) bySlot.set(row.slot, new Map());
    bySlot.get(row.slot)!.set(row.date, row);
  }
  const slotKeys = data.slots.map((s) => s.key).filter((k) => bySlot.has(k));

  const palette = seriesColors(slotKeys.length);
  const lineSeries = slotKeys.map((k, i) => ({
    key: k,
    label: data.slots.find((s) => s.key === k)?.label ?? k,
    color: palette[i % palette.length]!,
  }));

  const linePoints = dayKeys.map((date) => ({
    key: date,
    label: date.slice(5),
    values: slotKeys.map((k) => {
      const row = bySlot.get(k)?.get(date);
      return row ? measureValue(row, measure) : null;
    }),
  }));

  /* ------------------------------------------------------ weekday, the point */

  const weekdayKeys = [...new Set(data.weekday.map((w) => w.weekday))].sort();
  const weekdayData = weekdayKeys.map((wd) => {
    const rows = data.weekday.filter((w) => w.weekday === wd);
    return {
      key: String(wd),
      label: WEEKDAY_LABELS[wd] ?? String(wd),
      values: slotKeys.map((k) => {
        const r = rows.find((x) => x.slot === k);
        if (!r) return 0;
        return measure === "attended"
          ? r.meanAttended
          : measure === "seat_hours"
            ? r.meanSeatHours
            : r.meanDesks;
      }),
    };
  });

  const busiest = [...weekdayData].sort(
    (a, b) => Math.max(...b.values) - Math.max(...a.values),
  )[0];
  const quietest = [...weekdayData].sort(
    (a, b) => Math.max(...a.values) - Math.max(...b.values),
  )[0];

  /* ------------------------------------------------------------- the heatmap */

  /**
   * THE HEAT MAP IS UTILISATION, NOT HEADCOUNT — and the difference is the
   * whole value of the chart.
   *
   * Drawn as absolute desks it renders a picture of how BIG each bay is: the
   * 16-desk passage run is dark every weekday and a one-desk bay is pale, no
   * matter how hard either is worked. That is a floor plan, not a finding.
   *
   * As a percentage of each bay's OWN bookable capacity, a small bay that is
   * always full is as dark as a large one that is always full — which is the
   * comparison somebody deciding what to give up actually needs.
   */
  const bayCapacity = new Map<string, number>();
  for (const u of data.utilisation) {
    if (u.seatStatus !== "bookable") continue;
    bayCapacity.set(u.bay, (bayCapacity.get(u.bay) ?? 0) + 1);
  }

  const bays = [...new Set(data.heat.map((c) => c.bay))]
    .filter((b) => (bayCapacity.get(b) ?? 0) > 0)
    .sort();
  const heatCols = weekdayKeys.map((wd) => WEEKDAY_LABELS[wd] ?? String(wd));
  const heatRows = bays.map((bay) => ({
    key: bay,
    label: bay,
    values: weekdayKeys.map((wd) => {
      const cells = data.heat.filter((c) => c.bay === bay && c.weekday === wd);
      if (cells.length === 0) return null;
      // The API already returns a MEAN PER SLOT (it aggregates per date and
      // slot before averaging), so these are averaged across zones, never
      // summed across days.
      const mean =
        cells.reduce(
          (n, c) => n + (measure === "attended" ? c.desksAttended : c.desksClaimed),
          0,
        ) / cells.length;
      const capacity = bayCapacity.get(bay) ?? 1;
      return Math.min(100, Number(((mean / capacity) * 100).toFixed(0)));
    }),
  }));

  const idle = data.utilisation
    .filter((u) => u.seatStatus === "bookable")
    .sort((a, b) => a.utilisationPct - b.utilisationPct)
    .slice(0, 10);

  /** Mean desks held in a single slot — comparable across zones of any size. */
  const slotCount = Math.max(1, dayKeys.length * Math.max(1, slotKeys.length));
  const perSlot = (r: { claims: number; desksAttended: number; seatHours: number }) => {
    const total =
      measure === "attended" ? r.desksAttended : measure === "seat_hours" ? r.seatHours : r.claims;
    return Number((total / slotCount).toFixed(1));
  };

  /** "Audit & Assurance" is unreadable rotated at 10px; the first word is not. */
  const shortTeam = (t: string) => (t.length > 14 ? `${t.split(/[ &]/)[0]}…` : t);

  return (
    <div className="space-y-6">
      <FilterBar options={data.options} slots={data.slots} />

      {/* ------------------------------------------------------- headline */}
      <WidgetBoundary title="The headline">
        <Card>
          <CardHeader>
            <CardTitle>Desks needed against desks held</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <p className="max-w-3xl text-sm leading-relaxed text-ink">
              Over{" "}
              <strong className="font-medium">
                {data.workingDays} working days
              </strong>{" "}
              the busiest single slot saw{" "}
              <strong className="font-medium tabular">{h.peak}</strong> desks in
              use against a bookable pool of{" "}
              <strong className="font-medium tabular">{h.pool}</strong>
              {h.peakDate ? (
                <>
                  {" "}
                  — that peak was {h.peakSlot} on {h.peakDate}
                </>
              ) : null}
              .{" "}
              {headroom > 0 ? (
                <>
                  Even at its fullest the floor had{" "}
                  <strong className="font-medium tabular">{headroom}</strong>{" "}
                  desks spare.
                </>
              ) : (
                <>The floor reached capacity in that slot.</>
              )}
            </p>

            <StatRow>
              <Stat
                label="Peak demand"
                value={h.peak}
                of={`of ${h.pool}`}
                accent
                hint={`${peakPct}% of the bookable pool, at the busiest moment in the period.`}
              />
              <Stat
                label="95th percentile"
                value={h.p95}
                hint="What you would actually size the floor against. A single peak is one day; this is the level it rarely goes above."
              />
              <Stat
                label="Median slot"
                value={h.median}
                hint="The typical half-day. The gap to the peak is the cost of peak-day capacity."
              />
              <Stat
                label="People booking"
                value={h.distinctPeople}
                hint="Distinct staff who claimed a desk at any point in the period."
              />
            </StatRow>

            <p className="border-t border-hairline pt-3 text-xs leading-relaxed text-ink-subtle">
              <strong className="font-medium text-ink-muted">
                Read this with two caveats.
              </strong>{" "}
              The denominator assumes the Manager / Assistant Manager split we
              were given is right (open question A1), and that the 17 new
              workstations in Zone B are hot desks rather than allocated seats
              (A34). If either is wrong the pool of {h.pool} moves, and every
              utilisation figure here moves with it. Both are one sentence from
              CBVA away from being settled.
            </p>
          </CardBody>
        </Card>
      </WidgetBoundary>

      <MeasureExplainer measure={measure} />

      {/* -------------------------------------------------------- over time */}
      <WidgetBoundary title="Occupancy over time">
        <Card>
          <CardBody>
            <LineChart
              title={`${MEASURES[measure].label} by day`}
              caption={MEASURES[measure].blurb}
              series={lineSeries}
              data={linePoints}
              unit={unit}
              reference={
                measure === "booked" ? { value: h.pool, label: `Pool (${h.pool})` } : null
              }
              aside={`${data.filters.from} to ${data.filters.to}`}
            />
          </CardBody>
        </Card>
      </WidgetBoundary>

      {/* ---------------------------------------------------- day of week */}
      <WidgetBoundary title="Day-of-week pattern">
        <Card>
          <CardBody>
            <BarChart
              title="Average by day of the week"
              caption={
                busiest && quietest && busiest.key !== quietest.key ? (
                  <>
                    <strong className="font-medium text-ink">
                      {busiest.label} is the busiest day and {quietest.label} the
                      quietest
                    </strong>{" "}
                    — this is the shape a one-day-a-week WFH policy makes, and it
                    is the argument for sizing the floor to a typical day rather
                    than to the peak.
                  </>
                ) : (
                  "Mean per day of that weekday, not a total — an eight-week range does not contain the same number of Mondays as Fridays."
                )
              }
              series={lineSeries}
              data={weekdayData}
              unit={unit}
            />
          </CardBody>
        </Card>
      </WidgetBoundary>

      {/* -------------------------------------------------------- heat map */}
      <WidgetBoundary title="Bay heat map">
        <Card>
          <CardBody>
            <Heatmap
              title="Bay utilisation by day of the week"
              caption="Each bay against its OWN desk count, so a small bay that is always full reads as dark as a large one. Drawn as raw desks this chart would just be a picture of which bays are biggest. A hatched cell means nothing was observed there, which is a different fact from zero."
              columns={heatCols}
              rows={heatRows}
              unit="%"
              domainMax={100}
              formatValue={(v) => `${Math.round(v)}`}
            />
          </CardBody>
        </Card>
      </WidgetBoundary>

      {/* ------------------------------------------------- zone / team split */}
      <div className="grid gap-6 lg:grid-cols-2">
        <WidgetBoundary title="By zone">
          <Card>
            <CardBody>
              <BarChart
                title="Average desks in use, by zone"
                caption="A MEAN PER SLOT, not a total. Counting distinct desks over eight weeks saturates — nearly every desk gets used at some point, so every zone would report its full size and the chart would say nothing."
                series={[{ key: "v", label: "Desks per slot", color: CHART_SERIES_COLORS[0]! }]}
                data={data.byZone.map((r) => ({
                  key: r.key,
                  label: `Zone ${r.key}`,
                  values: [perSlot(r)],
                }))}
                unit={unit}
                height={180}
              />
            </CardBody>
          </Card>
        </WidgetBoundary>

        <WidgetBoundary title="By team">
          <Card>
            <CardBody>
              <BarChart
                title="Average desks in use, by team"
                caption="Who is actually coming in, per slot. Counts the occupant, never whoever made the booking."
                series={[{ key: "v", label: "Desks per slot", color: CHART_SERIES_COLORS[2]! }]}
                data={data.byTeam.map((r) => ({
                  key: r.key,
                  label: shortTeam(r.key),
                  values: [perSlot(r)],
                }))}
                unit={unit}
                height={180}
                dense
              />
            </CardBody>
          </Card>
        </WidgetBoundary>
      </div>

      {/* -------------------------------------------------- what happened */}
      <WidgetBoundary title="Booking outcomes">
        <Card>
          <CardHeader>
            <CardTitle>What happened to each booking</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="mb-3 max-w-3xl text-sm text-ink-muted">
              These five outcomes are kept apart deliberately. Collapsing them
              into one &ldquo;no show&rdquo; figure is not a display
              simplification — it changes the utilisation number in the
              direction that looks plausible rather than obviously wrong.
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>Outcome</Th>
                  <Th>What it means</Th>
                  <Th numeric>Bookings</Th>
                  <Th numeric>Seat-hours</Th>
                </tr>
              </thead>
              <tbody>
                {data.byStatus.map((r) => {
                  const label = TERMINAL_STATUS_LABELS[r.key];
                  // `claims` counts only statuses that HELD a desk, so it is
                  // zero for the two cancelled ones by definition. Their count
                  // is `cancellations`, and printing a bare zero here was the
                  // table quietly contradicting the paragraph above it.
                  const count = r.claims > 0 ? r.claims : r.cancellations;
                  return (
                    <tr key={r.key}>
                      <Td className="font-medium">{label?.label ?? r.key}</Td>
                      <Td className="text-ink-muted">{label?.meaning ?? ""}</Td>
                      <Td numeric>{count}</Td>
                      <Td numeric>{r.seatHours.toFixed(0)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      </WidgetBoundary>

      {/* -------------------------------------------------- least used desks */}
      <WidgetBoundary title="Least used desks">
        <Card>
          <CardHeader>
            <CardTitle>The ten least used desks</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="mb-3 max-w-3xl text-sm text-ink-muted">
              Per desk rather than per bay, because the decision in front of the
              firm is about physical desks. A desk at 0% over{" "}
              {data.workingDays} working days is the first place to look.
            </p>
            {idle.length === 0 ? (
              <EmptyState title="No bookable desks in this range">
                Widen the filters, or check that the range covers working days.
              </EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Desk</Th>
                    <Th>Bay</Th>
                    <Th>Zone</Th>
                    <Th numeric>Slots used</Th>
                    <Th numeric>Of</Th>
                    <Th numeric>Utilisation</Th>
                  </tr>
                </thead>
                <tbody>
                  {idle.map((u) => (
                    <tr key={u.seatCode}>
                      <Td className="seat-code font-medium">{u.seatCode}</Td>
                      <Td>{u.bay}</Td>
                      <Td>{u.zone}</Td>
                      <Td numeric>{u.slotsClaimed}</Td>
                      <Td numeric>{u.slotsAvailable}</Td>
                      <Td numeric>{u.utilisationPct}%</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
      </WidgetBoundary>
    </div>
  );
}
