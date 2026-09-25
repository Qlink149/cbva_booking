import { NextResponse } from "next/server";
import { JWT_COOKIE_NAME } from "@/lib/auth/jwt";

export const dynamic = "force-dynamic";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete({ name: JWT_COOKIE_NAME, path: "/" });
  return response;
}
