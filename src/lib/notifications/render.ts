/**
 * Real emails, rendered and stored even in demo mode.
 *
 * They are rendered at ENQUEUE time, not at send time, and stored on the row.
 * Two reasons. First, the demo inbox at /admin/notifications shows exactly what
 * would have been sent, so the notification flow is demoable with no SMTP
 * anywhere. Second, in production the stored body is the record of what the
 * firm actually told somebody — re-rendering it later from a booking that has
 * since changed would quietly rewrite history.
 *
 * Email clients cannot read CSS custom properties or external stylesheets, so
 * the palette below is a hand-copy of the tokens in src/app/globals.css and a
 * table layout does the work a flexbox would. That duplication is unavoidable;
 * it is written down here rather than pretended away.
 */
import { formatInTimeZone } from "date-fns-tz";

import { APP_TIMEZONE } from "@/lib/config";
import type { NotificationKind } from "@/lib/notifications/kinds";
import type { SlotDefinition } from "@/lib/slots";

/** Mirrors the :root block in src/app/globals.css. Keep the two in step. */
const PALETTE = {
  navy: "#1E2A5A",
  gold: "#D9A34A",
  paper: "#FBFAF7",
  ink: "#14181F",
  inkMuted: "#4B5058",
  hairline: "#E4E0D9",
  surface: "#FFFFFF",
} as const;

const FONT =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SERIF = "'Source Serif 4', Georgia, 'Times New Roman', serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface SeatNotificationContext {
  occupantName: string;
  bookerName: string;
  /** True when booker and occupant are different people. */
  onBehalf: boolean;
  seatCode: string;
  zone: string;
  bay: string;
  bookingDate: string;
  slot: SlotDefinition;
  /** Only set for booking_edited: what it used to be. */
  previous?: { seatCode: string; bookingDate: string; slot: SlotDefinition };
  /** Only set for cancellations and releases. */
  reason?: string;
}

export interface RoomNotificationContext {
  organiserName: string;
  roomName: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  reason?: string;
}

export interface RenderedNotification {
  subject: string;
  html: string;
  text: string;
}

/** "Tuesday 8 September 2026". The office has one timezone (PROJECT.md §6). */
export function longDate(date: string): string {
  return formatInTimeZone(`${date}T00:00:00Z`, "UTC", "EEEE d MMMM yyyy");
}

function slotPhrase(slot: SlotDefinition): string {
  return slot.label + " (" + slot.start + "–" + slot.end + ")";
}

function layout(headline: string, bodyRows: string, footerNote?: string): string {
  const note = footerNote
    ? '<tr><td style="padding:0 24px 24px;"><p style="margin:0;padding:12px 14px;background:' +
      PALETTE.paper +
      ";border-left:2px solid " +
      PALETTE.gold +
      ";font-size:13px;color:" +
      PALETTE.inkMuted +
      ';">' +
      esc(footerNote) +
      "</p></td></tr>"
    : "";

  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>" + esc(headline) + "</title></head>",
    '<body style="margin:0;padding:0;background:' +
      PALETTE.paper +
      ";color:" +
      PALETTE.ink +
      ";font-family:" +
      FONT +
      ';font-size:14px;line-height:1.5;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' +
      PALETTE.paper +
      ';padding:24px 12px;"><tr><td align="center">',
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:' +
      PALETTE.surface +
      ";border:1px solid " +
      PALETTE.hairline +
      ';border-radius:4px;">',
    // Header: the engraved wordmark, in the serif that echoes it.
    '<tr><td style="padding:20px 24px;border-bottom:1px solid ' +
      PALETTE.hairline +
      ';">' +
      '<span style="font-family:' +
      SERIF +
      ";font-size:17px;letter-spacing:0.01em;color:" +
      PALETTE.navy +
      ';">CBV &amp; Associates LLP</span>' +
      '<span style="display:block;margin-top:2px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:' +
      PALETTE.inkMuted +
      ';">Workspace</span></td></tr>',
    '<tr><td style="padding:24px 24px 8px;"><h1 style="margin:0;font-family:' +
      SERIF +
      ";font-size:20px;font-weight:400;color:" +
      PALETTE.ink +
      ';">' +
      esc(headline) +
      "</h1></td></tr>",
    '<tr><td style="padding:8px 24px 20px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">' +
      bodyRows +
      "</table>",
    "</td></tr>",
    note,
    '<tr><td style="padding:16px 24px;border-top:1px solid ' +
      PALETTE.hairline +
      ";font-size:12px;color:" +
      PALETTE.inkMuted +
      ';">Sent by CBVA Workspace. Floor 4, Mumbai.</td></tr>',
    "</table></td></tr></table></body></html>",
  ].join("\n");
}

function row(label: string, value: string, mono = false): string {
  const valueStyle = mono ? "font-family:" + MONO + ";font-variant-numeric:tabular-nums;" : "";
  return (
    '<tr><td style="padding:6px 0;width:120px;color:' +
    PALETTE.inkMuted +
    ';vertical-align:top;">' +
    esc(label) +
    '</td><td style="padding:6px 0;color:' +
    PALETTE.ink +
    ";" +
    valueStyle +
    '">' +
    esc(value) +
    "</td></tr>"
  );
}

function paragraph(text: string): string {
  return (
    '<tr><td colspan="2" style="padding:0 0 12px;color:' + PALETTE.ink + ';">' + esc(text) + "</td></tr>"
  );
}

function plain(headline: string, lines: string[]): string {
  return ["CBV & Associates LLP — Workspace", "", headline, "", ...lines.filter(Boolean), "", "Floor 4, Mumbai."].join(
    "\n",
  );
}

function seatLines(c: SeatNotificationContext): string[] {
  return [
    "Desk: " + c.seatCode + " (Zone " + c.zone + ", bay " + c.bay + ")",
    "Date: " + longDate(c.bookingDate),
    "Slot: " + slotPhrase(c.slot),
  ];
}

/* -------------------------------------------------------------- seat kinds */

export type SeatNotificationKind = Exclude<
  NotificationKind,
  // booked_on_your_behalf is history-only: it labels old outbox rows, and
  // nothing can render or send a new one.
  "room_confirmed" | "room_cancelled" | "booked_on_your_behalf"
>;

export function renderSeatNotification(
  kind: SeatNotificationKind,
  c: SeatNotificationContext,
): RenderedNotification {
  const dateLong = longDate(c.bookingDate);
  const facts =
    row("Desk", c.seatCode, true) +
    row("Where", "Zone " + c.zone + ", bay " + c.bay) +
    row("Date", dateLong) +
    row("Slot", slotPhrase(c.slot));

  switch (kind) {
    case "booking_confirmed": {
      const subject = "Desk " + c.seatCode + " booked for " + dateLong;
      const intro = "Your desk is booked.";
      return {
        subject,
        html: layout(
          "Booking confirmed",
          paragraph(intro) + facts,
          "Check in when you arrive. A desk nobody checks into is released back to the floor and given to somebody else.",
        ),
        text: plain(subject, [intro, ...seatLines(c)]),
      };
    }

    case "booking_edited": {
      const subject = "Desk booking changed to " + c.seatCode + ", " + dateLong;
      const was = c.previous
        ? row(
            "Previously",
            c.previous.seatCode +
              " · " +
              longDate(c.previous.bookingDate) +
              " · " +
              c.previous.slot.label,
          )
        : "";
      return {
        subject,
        html: layout("Booking changed", paragraph("This booking has been changed.") + facts + was),
        text: plain(subject, [
          "This booking has been changed.",
          ...seatLines(c),
          c.previous
            ? "Previously: " +
              c.previous.seatCode +
              ", " +
              longDate(c.previous.bookingDate) +
              ", " +
              c.previous.slot.label
            : "",
        ]),
      };
    }

    case "booking_cancelled": {
      const subject = "Desk " + c.seatCode + " cancelled for " + dateLong;
      const why = c.reason ?? "This desk booking has been cancelled.";
      return {
        subject,
        html: layout(
          "Booking cancelled",
          paragraph(why) + facts,
          "The desk is back in the pool and can be booked by anybody.",
        ),
        text: plain(subject, [why, ...seatLines(c)]),
      };
    }

    case "auto_released": {
      const subject = "Desk " + c.seatCode + " released — no check-in";
      const why =
        c.reason ??
        "Nobody checked in to " +
          c.seatCode +
          ", so it has been released back to the floor for somebody else to use.";
      return {
        subject,
        html: layout(
          "Desk released",
          paragraph(why) + facts,
          "If you are still coming in, book another desk from the floor plan.",
        ),
        text: plain(subject, [why, ...seatLines(c)]),
      };
    }

    case "reminder": {
      // Sent halfway through the grace window, before anything is taken away.
      // It has one job: turn a forgotten scan back into a real check-in.
      const subject = "Check in to " + c.seatCode + " — it is about to be released";
      const intro =
        "You have not checked in to " +
        c.seatCode +
        " yet, so it is due to be released back to the floor shortly.";
      return {
        subject,
        html: layout(
          "Your desk is about to be released",
          paragraph(intro) + facts,
          "Scan the QR code on the desk to keep it. That scan is also what records the desk as used.",
        ),
        text: plain(subject, [intro, ...seatLines(c)]),
      };
    }

    case "series_occurrence_failed": {
      // A recurring booking that could not be made — almost always because
      // somebody took the desk first. Sent once per occurrence and never
      // retried, because the day it is about will have passed by the time a
      // second message would arrive.
      const subject = "Could not book " + c.seatCode + " for " + dateLong;
      const intro =
        "Your recurring booking for " +
        c.seatCode +
        " could not be made — the desk was already taken for that slot. " +
        "The rest of the series is unaffected.";
      return {
        subject,
        html: layout(
          "A recurring booking could not be made",
          paragraph(intro) + facts,
          "Pick another desk from the floor plan for that day. Nothing else in the series has changed.",
        ),
        text: plain(subject, [intro, ...seatLines(c)]),
      };
    }
  }
}

/* -------------------------------------------------------------- room kinds */

export function renderRoomNotification(
  kind: "room_confirmed" | "room_cancelled",
  c: RoomNotificationContext,
  timezone: string = APP_TIMEZONE,
): RenderedNotification {
  const day = formatInTimeZone(c.startsAt, timezone, "EEEE d MMMM yyyy");
  const window =
    formatInTimeZone(c.startsAt, timezone, "HH:mm") +
    "–" +
    formatInTimeZone(c.endsAt, timezone, "HH:mm");
  const facts =
    row("Meeting", c.title) + row("Room", c.roomName) + row("Date", day) + row("Time", window, true);
  const lines = ["Meeting: " + c.title, "Room: " + c.roomName, "Date: " + day, "Time: " + window];

  if (kind === "room_confirmed") {
    const subject = c.roomName + " booked — " + day + ", " + window;
    return {
      subject,
      html: layout("Room booked", paragraph(c.roomName + " is held for you.") + facts),
      text: plain(subject, [c.roomName + " is held for you.", ...lines]),
    };
  }

  const subject = c.roomName + " booking cancelled — " + day + ", " + window;
  const why = c.reason ?? "This room booking has been cancelled.";
  return {
    subject,
    html: layout("Room booking cancelled", paragraph(why) + facts),
    text: plain(subject, [why, ...lines]),
  };
}
