import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { JWT_COOKIE_NAME, signJwt } from "@/lib/auth/jwt";
import { clearLoginAttempts, recordLoginAttempt } from "@/lib/auth/login-rate-limit";
import { verifyPassword } from "@/lib/auth/password";
import { ROLE_COOKIE } from "@/lib/adapters/demo";
import { db, schema } from "@/lib/db";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(1_024),
});

function clientKey(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function invalidCredentials() {
  return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
}

export async function POST(request: Request) {
  const key = clientKey(request);
  const limit = recordLoginAttempt(key);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const input = bodySchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return invalidCredentials();

  const email = input.data.email.toLowerCase();
  const [user] = await db()
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (!user?.isActive || !(await verifyPassword(input.data.password, user.passwordHash))) {
    return invalidCredentials();
  }

  clearLoginAttempts(key);
  let token: string;
  try {
    token = signJwt({
      userId: user.id,
      email: user.email,
      grade: user.grade,
      isAdmin: user.isAdmin,
    });
  } catch {
    return NextResponse.json(
      { error: "Password sign-in is not configured for this environment." },
      { status: 503 },
    );
  }
  const response = NextResponse.json({
    ok: true,
    user: {
      email: user.email,
      displayName: user.displayName,
      grade: user.grade,
      isAdmin: user.isAdmin,
    },
  });
  response.cookies.set(JWT_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  // A real password session supersedes the demo picker rather than leaving two
  // competing identities in the browser.
  response.cookies.delete({ name: ROLE_COOKIE, path: "/" });
  return response;
}
