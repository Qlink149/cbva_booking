/**
 * Per-desk QR codes.
 *
 * The strongest recommendation we have made to this client. A door swipe proves
 * somebody entered the floor; it does not prove they used C3-04. Occupancy
 * analytics built on door swipes cannot tell a full floor from a half-full one
 * where everybody walked past the same reader — and it makes the whole product
 * depend on an access-control vendor whose export format we have never seen.
 *
 * A sticker on the desk removes both problems. The QR encodes an ordinary URL;
 * the identity comes from the session, not from the code, so the sticker is not
 * a secret and a photograph of it grants nothing.
 */
import QRCode from "qrcode";

/** Where the printed codes point. Falls back to the dev origin. */
export function appOrigin(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:8081").replace(/\/+$/, "");
}

export function seatCheckInUrl(seatCode: string, origin = appOrigin()): string {
  return `${origin}/checkin/${encodeURIComponent(seatCode)}`;
}

/**
 * SVG rather than a data-URI PNG: it prints at any size without going soft, and
 * inlining it means the print sheet has no network dependency at all — which
 * matters when 158 of them are being run off on an office printer.
 *
 * Error correction M tolerates a smudged or partly peeled sticker.
 */
export async function seatQrSvg(seatCode: string, origin = appOrigin()): Promise<string> {
  return QRCode.toString(seatCheckInUrl(seatCode, origin), {
    type: "svg",
    margin: 0,
    errorCorrectionLevel: "M",
  });
}
