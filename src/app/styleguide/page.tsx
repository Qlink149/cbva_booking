import type { Metadata } from "next";
import { SEAT_STATUS_TOKENS, SEAT_STATUSES } from "@/components/seat/seat-status";
import { SeatSwatch, SeatSwatchWithGlyph } from "@/components/seat/seat-swatch";
import { Button } from "@/components/ui/button";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { StyleguideInteractive } from "./interactive";

export const metadata: Metadata = { title: "Style Guide" };

const COLOURS = [
  {
    name: "Navy",
    token: "--navy",
    hex: "#1E2A5A",
    swatch: "bg-navy",
    usage: "Primary. Buttons, headings, seat outlines, the wordmark.",
  },
  {
    name: "Gold",
    token: "--gold",
    hex: "#D9A34A",
    swatch: "bg-gold",
    usage:
      "Accent only. A focused seat, the active tab underline, one key metric. Never a fill or a primary button. Under 5% of pixels.",
  },
  {
    name: "Paper",
    token: "--paper",
    hex: "#FBFAF7",
    swatch: "bg-paper",
    usage: "Page background.",
  },
  {
    name: "Ink",
    token: "--ink",
    hex: "#14181F",
    swatch: "bg-ink",
    usage: "Body text.",
  },
  {
    name: "Hairline",
    token: "--hairline",
    hex: "#E4E0D9",
    swatch: "bg-hairline",
    usage: "Every 1px border in the product.",
  },
];

const DERIVED = [
  { name: "Navy Tint", swatch: "bg-navy-tint", usage: "Booked seat fill, subtle emphasis." },
  { name: "Navy Tint Strong", swatch: "bg-navy-tint-strong", usage: "Text selection." },
  {
    name: "Navy Yours",
    swatch: "bg-navy-yours",
    usage:
      "Your booking fill. Darker than a tint on purpose — measured against the baked plan at 3.29:1 as a graphical object, clearing WCAG 1.4.11's 3:1 (was 1.29:1 at the lighter tint).",
  },
  { name: "Ink Muted", swatch: "bg-ink-muted", usage: "Secondary text." },
  { name: "Ink Subtle", swatch: "bg-ink-subtle", usage: "Tertiary text, placeholders." },
  { name: "Surface", swatch: "bg-surface", usage: "Cards and panels." },
  { name: "Surface Sunken", swatch: "bg-surface-sunken", usage: "Inset areas, disabled fields." },
  { name: "Positive", swatch: "bg-positive", usage: "Confirmed, checked in." },
  { name: "Caution", swatch: "bg-caution", usage: "Auto-released, approaching cut-off." },
  { name: "Danger", swatch: "bg-danger", usage: "Cancellation, destructive actions." },
];

export default function StyleguidePage() {
  return (
    <div className="space-y-14 pb-10">
      <header>
        <p className="text-xs tracking-wide text-ink-subtle uppercase">
          CBVA Workspace
        </p>
        <h1 className="mt-1 text-4xl text-ink">Style Guide</h1>
        <p className="mt-3 max-w-prose text-sm text-ink-muted">
          Every token, every seat status and every base component in the product.
          The palette is defined once as CSS custom properties in{" "}
          <code className="seat-code rounded-sm bg-surface-sunken px-1 py-0.5 text-[12px]">
            src/app/globals.css
          </code>{" "}
          and consumed through Tailwind v4&nbsp;
          <code className="seat-code rounded-sm bg-surface-sunken px-1 py-0.5 text-[12px]">
            @theme
          </code>
          , so the whole product re-skins from that one block.
        </p>
      </header>

      {/* ------------------------------------------------------------ colour */}
      <Section
        id="colour"
        title="Colour"
        note="Five brand values. Everything else is mixed from them, so contrast relationships hold when the palette is swapped."
      >
        <div className="space-y-px overflow-hidden rounded-md border border-hairline bg-hairline">
          {COLOURS.map((c) => (
            <div
              key={c.token}
              className="flex flex-wrap items-center gap-x-5 gap-y-2 bg-surface px-4 py-3"
            >
              <div
                className={`size-11 shrink-0 rounded-sm border border-hairline ${c.swatch}`}
                aria-hidden="true"
              />
              <div className="min-w-32">
                <p className="text-sm font-medium text-ink">{c.name}</p>
                <p className="seat-code text-[11px] text-ink-subtle">
                  {c.token} · {c.hex}
                </p>
              </div>
              <p className="min-w-0 flex-1 text-sm text-ink-muted">{c.usage}</p>
            </div>
          ))}
        </div>

        <h3 className="mt-8 mb-3 text-sm font-semibold text-ink">Derived Values</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {DERIVED.map((d) => (
            <div key={d.name} className="min-w-0">
              <div
                className={`h-10 rounded-sm border border-hairline ${d.swatch}`}
                aria-hidden="true"
              />
              <p className="mt-1.5 text-xs font-medium text-ink">{d.name}</p>
              <p className="text-[11px] text-ink-subtle">{d.usage}</p>
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-md border border-hairline bg-surface p-4">
          <p className="text-sm text-ink-muted">
            <span className="border-b-2 border-gold pb-0.5 font-medium text-ink">
              The gold rule
            </span>{" "}
            — gold appears exactly three ways in this product: the active tab
            underline above, a 2px rule around the seat that is yours, and a
            single key metric per screen. Everything else that wants emphasis
            uses navy or weight.
          </p>
        </div>
      </Section>

      {/* --------------------------------------------------------- typography */}
      <Section
        id="type"
        title="Typography"
        note="Three faces, each with one job. The serif is the only thing that carries the firm's character, so it is rationed."
      >
        <div className="space-y-px overflow-hidden rounded-md border border-hairline bg-hairline">
          <TypeRow face="Source Serif 4" role="Page titles only" mono={false}>
            <p className="font-title text-4xl text-ink">Occupancy by Zone</p>
            <p className="font-title mt-2 text-2xl text-ink">Floor 4, Mumbai</p>
          </TypeRow>
          <TypeRow face="Inter" role="All UI text" mono={false}>
            <p className="text-base text-ink">
              Book a desk for Tuesday. Assistant Managers and below must book;
              Managers and above hold an allocated seat.
            </p>
            <p className="mt-2 text-sm text-ink-muted">
              Secondary text, used for supporting copy and table cells.
            </p>
            <p className="mt-2 text-xs text-ink-subtle">
              Tertiary text, used for hints and timestamps.
            </p>
          </TypeRow>
          <TypeRow face="JetBrains Mono" role="Seat codes, bays, plan annotations" mono>
            <p className="seat-code text-lg text-ink">C3-04 · D8-01 · PA-16</p>
            <p className="seat-code mt-2 text-sm text-ink-muted">
              BAY C3 · 09 SEATS · WORKSTATION
            </p>
          </TypeRow>
        </div>
      </Section>

      {/* --------------------------------------------------------- seat status */}
      <Section
        id="seats"
        title="Seat Status"
        note="Seven states. Each carries a border treatment and a glyph as well as a colour, so the plan still reads in greyscale and for colour-vision deficiency. Rendered from one component; the floor plan in Phase 2 uses the same tokens."
      >
        <div className="overflow-hidden rounded-md border border-hairline">
          <Table>
            <thead>
              <tr>
                <Th>Status</Th>
                <Th>Swatch</Th>
                <Th>With Seat Code</Th>
                <Th>Non-Colour Cue</Th>
                <Th>Meaning</Th>
              </tr>
            </thead>
            <tbody>
              {SEAT_STATUSES.map((status) => {
                const token = SEAT_STATUS_TOKENS[status];
                return (
                  <tr key={status}>
                    <Td className="font-medium whitespace-nowrap">{token.label}</Td>
                    <Td>
                      <SeatSwatch status={status} />
                    </Td>
                    <Td>
                      <SeatSwatchWithGlyph status={status} code="37" />
                    </Td>
                    <Td className="text-sm text-ink-muted">
                      {describeCue(status)}
                    </Td>
                    <Td className="text-sm text-ink-muted">{token.description}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>

        <h3 className="mt-8 mb-3 text-sm font-semibold text-ink">
          The Same Seven, Desaturated
        </h3>
        <p className="mb-3 max-w-prose text-sm text-ink-muted">
          This is the test that matters. If two statuses become
          indistinguishable here, the vocabulary has failed and the fix belongs
          in{" "}
          <code className="seat-code rounded-sm bg-surface-sunken px-1 py-0.5 text-[12px]">
            seat-status.ts
          </code>
          , not in the floor plan.
        </p>
        <div className="flex flex-wrap gap-3 rounded-md border border-hairline bg-surface p-4 [filter:grayscale(1)]">
          {SEAT_STATUSES.map((status) => (
            <div key={status} className="text-center">
              <SeatSwatchWithGlyph status={status} code="37" />
              <p className="mt-1.5 text-[11px] text-ink-muted">
                {SEAT_STATUS_TOKENS[status].label}
              </p>
            </div>
          ))}
        </div>

        <h3 className="mt-8 mb-3 text-sm font-semibold text-ink">
          A Bay, as the Plan Will Render It
        </h3>
        <div className="inline-flex flex-col gap-2 rounded-md border border-hairline bg-surface p-4">
          <p className="seat-code text-[11px] tracking-wide text-ink-subtle">BAY C3</p>
          <div className="grid grid-cols-3 gap-1.5">
            <SeatSwatch status="available" code="36" size="lg" />
            <SeatSwatch status="booked" code="38" size="lg" />
            <SeatSwatch status="checked_in" code="39" size="lg" />
            <SeatSwatch status="your_booking" code="37" size="lg" />
            <SeatSwatch status="reserved_fixed" code="40" size="lg" />
            <SeatSwatch status="available" code="41" size="lg" />
            <SeatSwatch status="auto_released" code="42" size="lg" />
            <SeatSwatch status="blocked" code="43" size="lg" />
            <SeatSwatch status="available" code="44" size="lg" />
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------- geometry */}
      <Section
        id="geometry"
        title="Geometry & Depth"
        note="Radius maxes out at 4px and there is no shadow heavier than a hairline. A professional services tool should look printed, not extruded."
      >
        <div className="flex flex-wrap gap-6">
          <GeometrySample label="Radius 0" className="border" />
          <GeometrySample label="Radius 2px" className="rounded-sm border" />
          <GeometrySample label="Radius 4px (maximum)" className="rounded-md border" />
          <GeometrySample
            label="Hairline shadow"
            className="rounded-md border shadow-[var(--shadow-hairline)]"
          />
        </div>
      </Section>

      {/* -------------------------------------------------------- components */}
      <Section id="components" title="Components" note="Every base primitive, in every state.">
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Buttons</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary">Book Seat</Button>
                <Button variant="secondary">Change Slot</Button>
                <Button variant="ghost">Dismiss</Button>
                <Button variant="danger">Cancel Booking</Button>
                <Button variant="link">View Floor Plan</Button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm">Small</Button>
                <Button size="md">Medium</Button>
                <Button size="lg">Large</Button>
                <Button disabled>Disabled</Button>
              </div>
              <p className="text-xs text-ink-subtle">
                There is deliberately no gold button variant.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Badges</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-wrap items-center gap-2">
              <Badge>Neutral</Badge>
              <Badge variant="navy">Confirmed</Badge>
              <Badge variant="positive">Checked In</Badge>
              <Badge variant="caution">Auto Released</Badge>
              <Badge variant="danger">Cancelled</Badge>
              <Badge variant="gold">Key Metric</Badge>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Form Controls</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="sg-email">Work Email</Label>
                <Input
                  id="sg-email"
                  type="email"
                  name="email"
                  autoComplete="email"
                  spellCheck={false}
                  placeholder="name@cbva.in…"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sg-seat">Seat Code</Label>
                <Input
                  id="sg-seat"
                  name="seat"
                  autoComplete="off"
                  spellCheck={false}
                  className="seat-code"
                  placeholder="37…"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sg-disabled">Allocated Seat</Label>
                <Input id="sg-disabled" name="allocated" defaultValue="D5-01" disabled readOnly />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Empty State</CardTitle>
            </CardHeader>
            <CardBody>
              <EmptyState title="No Bookings This Week">
                You have not booked a desk for any day this week. Open the floor
                map to pick one.
              </EmptyState>
            </CardBody>
          </Card>
        </div>

        <div className="mt-6">
          <StyleguideInteractive />
        </div>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Table</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Bay</Th>
                  <Th>Zone</Th>
                  <Th numeric>Seats</Th>
                  <Th numeric>Booked</Th>
                  <Th numeric>Utilisation</Th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["C3", "Zone C", 9, 8, "89%"],
                  ["C5", "Zone C", 9, 6, "67%"],
                  ["D4", "Zone D", 9, 9, "100%"],
                  ["PA", "Zone C", 16, 5, "31%"],
                ].map((row) => (
                  <tr key={row[0] as string}>
                    <Td className="seat-code">{row[0]}</Td>
                    <Td className="text-ink-muted">{row[1]}</Td>
                    <Td numeric>{row[2]}</Td>
                    <Td numeric>{row[3]}</Td>
                    <Td numeric className="font-medium">
                      {row[4]}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      </Section>
    </div>
  );
}

function describeCue(status: (typeof SEAT_STATUSES)[number]): string {
  switch (status) {
    case "available":
      return "Solid navy outline, empty fill";
    case "booked":
      return "Solid outline, tinted fill";
    case "your_booking":
      return "2px gold rule + filled dot";
    case "reserved_fixed":
      return "Dashed outline + square";
    case "checked_in":
      return "Solid navy fill + tick";
    case "auto_released":
      return "Dotted outline + return arrow";
    case "blocked":
      return "Diagonal hatch + cross";
  }
}

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`}>
      <div className="mb-5 border-b border-hairline pb-3">
        <h2 id={`${id}-heading`} className="text-2xl text-ink">
          {title}
        </h2>
        {note ? (
          <p className="mt-1.5 max-w-prose text-sm text-ink-muted">{note}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function TypeRow({
  face,
  role,
  mono,
  children,
}: {
  face: string;
  role: string;
  mono: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-4 bg-surface px-4 py-5 sm:grid-cols-[13rem_1fr]">
      <div>
        <p className={`text-sm font-medium text-ink ${mono ? "seat-code" : ""}`}>
          {face}
        </p>
        <p className="mt-0.5 text-xs text-ink-subtle">{role}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function GeometrySample({ label, className }: { label: string; className: string }) {
  return (
    <div className="text-center">
      <div
        className={`size-20 border-ink-subtle bg-surface ${className}`}
        aria-hidden="true"
      />
      <p className="mt-2 text-xs text-ink-muted">{label}</p>
    </div>
  );
}
