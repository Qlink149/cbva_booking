import { NextResponse } from "next/server";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { auth } from "@/lib/adapters";
import { ROLE_COOKIE } from "@/lib/adapters/demo";
import { JWT_COOKIE_NAME } from "@/lib/auth/jwt";
import { readDemoOffsetSeconds } from "@/lib/clock";
import { serverEnv } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Who am I, plus the shared demo clock offset, plus who I can switch to. */
export async function GET() {
  const environment = serverEnv();
  const user = await auth().currentUser();
  const offsetSeconds = await readDemoOffsetSeconds();

  // One representative person per grade for the demo role switcher.
  const candidates = environment.appMode === "demo" ? await db()
    .select({
      email: schema.users.email,
      displayName: schema.users.displayName,
      grade: schema.users.grade,
      seatMode: schema.users.seatMode,
      isAdmin: schema.users.isAdmin,
    })
    .from(schema.users)
    .orderBy(asc(schema.users.grade), asc(schema.users.displayName)) : [];

  const byGrade = new Map<string, (typeof candidates)[number]>();
  for (const c of candidates) {
    if (!byGrade.has(c.grade)) byGrade.set(c.grade, c);
  }
  // Make sure an admin is always reachable from the switcher — but keyed by
  // email, so an admin who is already the representative for their grade is
  // not listed twice.
  const roles = [...byGrade.values()];
  if (!roles.some((r) => r.isAdmin)) {
    const admin = candidates.find((c) => c.isAdmin);
    if (admin) roles.push(admin);
  }

  return NextResponse.json({
    appMode: environment.appMode,
    offsetSeconds,
    user: user
      ? {
          email: user.email,
          displayName: user.displayName,
          grade: user.grade,
          seatMode: user.seatMode,
          isAdmin: user.isAdmin,
          team: user.team,
        }
      : null,
    roles,
  });
}

const switchSchema = z.object({ email: z.email() });

/** Demo role switcher. Writes the cookie DemoAuthProvider reads. */
export async function POST(request: Request) {
  if (serverEnv().appMode === "production") {
    return NextResponse.json(
      { error: "Role switching is a demo-mode affordance." },
      { status: 403 },
    );
  }

  const parsed = switchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Provide the email address of a seeded user." },
      { status: 400 },
    );
  }

  const [user] = await db()
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.email, parsed.data.email))
    .limit(1);

  if (!user) {
    return NextResponse.json(
      { error: `No seeded user with the email ${parsed.data.email}.` },
      { status: 404 },
    );
  }

  const res = NextResponse.json({ ok: true, email: user.email });
  res.cookies.set(ROLE_COOKIE, user.email, {
    httpOnly: false, // demo affordance; real sessions are httpOnly (see production.ts)
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  // Choosing a demo role intentionally ends any password-authenticated
  // session, otherwise the JWT would continue to win in DemoAuthProvider.
  res.cookies.delete({ name: JWT_COOKIE_NAME, path: "/" });
  return res;
}
