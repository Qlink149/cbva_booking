import { createHmac, timingSafeEqual } from "node:crypto";
import { SystemClock, type Clock } from "@/lib/clock";
import { jwtSecret } from "@/lib/config";

export const JWT_COOKIE_NAME = "cbva_session";
const ISSUER = "cbva-workspace";
const defaultClock: Clock = new SystemClock();

export interface JwtUserPayload {
  userId: string;
  email: string;
  grade: string;
  isAdmin: boolean;
  iat: number;
  exp: number;
  iss: typeof ISSUER;
}

function encode(value: object | Buffer): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), "utf8");
  return bytes.toString("base64url");
}

function sign(data: string): Buffer {
  return createHmac("sha256", jwtSecret()).update(data).digest();
}

/** Create a seven-day, HMAC-signed session token. */
export function signJwt(
  user: Omit<JwtUserPayload, "iat" | "exp" | "iss">,
  expiresInSeconds = 7 * 24 * 60 * 60,
  clock: Clock = defaultClock,
): string {
  const iat = Math.floor(clock.now().getTime() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ ...user, iat, exp: iat + expiresInSeconds, iss: ISSUER });
  const data = `${header}.${payload}`;
  return `${data}.${encode(sign(data))}`;
}

/** Verify a token's header, HMAC, issuer, shape and expiry. */
export function verifyJwt(token: string, clock: Clock = defaultClock): JwtUserPayload | null {
  const [encodedHeader, encodedPayload, encodedSignature, ...extra] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra.length > 0) return null;

  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as {
      alg?: unknown;
      typ?: unknown;
    };
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;

    const data = `${encodedHeader}.${encodedPayload}`;
    const actual = Buffer.from(encodedSignature, "base64url");
    const expected = sign(data);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<JwtUserPayload>;
    if (
      payload.iss !== ISSUER ||
      typeof payload.userId !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.grade !== "string" ||
      typeof payload.isAdmin !== "boolean" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp <= Math.floor(clock.now().getTime() / 1000)
    ) {
      return null;
    }
    return payload as JwtUserPayload;
  } catch {
    return null;
  }
}
