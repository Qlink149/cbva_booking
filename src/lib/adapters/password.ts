import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { JWT_COOKIE_NAME, verifyJwt } from "@/lib/auth/jwt";
import type { AuthProvider } from "@/lib/adapters/types";
import type { User } from "@/lib/db/schema";

/** Password-session auth used where Entra ID is not configured yet. */
export class PasswordAuthProvider implements AuthProvider {
  async currentUser(): Promise<User | null> {
    const token = (await cookies()).get(JWT_COOKIE_NAME)?.value;
    if (!token) return null;
    let payload;
    try {
      payload = verifyJwt(token);
    } catch {
      return null;
    }
    if (!payload) return null;

    const [user] = await db()
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, payload.userId))
      .limit(1);
    // Authorisation is always read from the database, never trusted from the
    // token. Deactivating or de-adminning an account takes effect immediately.
    return user?.isActive ? user : null;
  }
}
