/**
 * Provision or rotate one employee's password without ever storing plaintext
 * credentials in seed data. Supply AUTH_USER_EMAIL and AUTH_USER_PASSWORD via
 * the process environment (not source control).
 */
import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", quiet: true });

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { hashPassword } from "../src/lib/auth/password";
import * as schema from "../src/lib/db/schema";

async function main() {
  const email = process.env.AUTH_USER_EMAIL?.trim().toLowerCase();
  const password = process.env.AUTH_USER_PASSWORD;
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!email || !password || password.length < 12) {
    throw new Error("Set AUTH_USER_EMAIL and a 12+ character AUTH_USER_PASSWORD.");
  }
  if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set.");

  const pool = new Pool({ connectionString: url, max: 1 });
  const database = drizzle(pool, { schema });
  try {
    const [user] = await database
      .select({ id: schema.users.id, isActive: schema.users.isActive })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (!user?.isActive) throw new Error("No active user exists for AUTH_USER_EMAIL.");
    await database
      .update(schema.users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(schema.users.id, user.id));
    console.log(`Password updated for ${email}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
