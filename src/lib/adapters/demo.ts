import { cookies } from "next/headers";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type {
  AuthProvider,
  CalendarSync,
  CheckInSource,
  MailProvider,
  OutboundMail,
} from "@/lib/adapters/types";
import type { BadgeEvent, RoomBooking, User } from "@/lib/db/schema";
import { JWT_COOKIE_NAME, verifyJwt } from "@/lib/auth/jwt";

/** Cookie the role switcher writes. Value is a seeded user's email. */
export const ROLE_COOKIE = "cbva_role";

/**
 * Demo auth: returns whichever seeded user the role switcher cookie names.
 * Real sign-in is Entra ID; see production.ts.
 */
export class DemoAuthProvider implements AuthProvider {
  async currentUser(): Promise<User | null> {
    const jar = await cookies();
    const token = jar.get(JWT_COOKIE_NAME)?.value;

    // A password-authenticated demo user takes precedence over the convenience
    // role switcher. The role-switch endpoint explicitly clears this cookie
    // when a presenter chooses another representative person.
    if (token) {
      let payload = null;
      try {
        payload = verifyJwt(token);
      } catch {
        // A stale cookie must not make a demo unavailable after its secret is
        // rotated or a local developer has not configured password auth.
      }
      if (payload) {
        const [user] = await db()
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, payload.userId))
          .limit(1);
        if (user?.isActive) return user;
      }
    }
    const email = jar.get(ROLE_COOKIE)?.value;

    if (email) {
      const [user] = await db()
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);
      if (user) return user;
      // Fall through: stale cookie, or the database was reseeded under it.
    }

    // No cookie, or it named nobody. Resolve a default from the seed rather
    // than hard-coding an address — seeded names are generated, so any literal
    // here silently rots the moment the roster changes.
    return this.defaultUser();
  }

  private async defaultUser(): Promise<User | null> {
    const [admin] = await db()
      .select()
      .from(schema.users)
      .where(eq(schema.users.isAdmin, true))
      .orderBy(asc(schema.users.email))
      .limit(1);
    if (admin) return admin;

    const [anyone] = await db()
      .select()
      .from(schema.users)
      .orderBy(asc(schema.users.email))
      .limit(1);
    return anyone ?? null;
  }
}

/**
 * Demo mail: a transport that delivers nowhere and succeeds.
 *
 * It used to write the notification_log row itself. It no longer does, and that
 * is the point: from Phase 3 `notification_log` is the OUTBOX, written inside
 * the booking transaction by src/lib/notifications/outbox.ts, and a
 * MailProvider is only the thing that carries a message out of the building.
 * Two writers would have meant every demo notification appearing twice, and
 * would have hidden the queue's retry behaviour behind an adapter that could
 * never fail.
 *
 * So in demo mode the message is already recorded and viewable at
 * /admin/notifications before this is called; delivery is the only part that is
 * simulated. Production swaps in GraphMailProvider and nothing else changes.
 */
export class DemoMailProvider implements MailProvider {
  async send(_msg: OutboundMail): Promise<void> {
    // Nothing leaves the machine. The outbox row is the demonstration.
  }
}

/** Demo calendar: a plausible-looking fake event id, marked as such. */
export class DemoCalendarSync implements CalendarSync {
  async upsert(b: RoomBooking): Promise<string> {
    return b.calendarEventId ?? `demo-evt-${crypto.randomUUID()}`;
  }

  async remove(_id: string): Promise<void> {
    // No external calendar to remove from in demo mode.
  }
}

/**
 * Demo check-in: no badge hardware, so the UI "Simulate Badge Swipe" button
 * pushes events through here. The subscriber contract is identical to the one a
 * real webhook will satisfy, so Phase 3's check-in handler never changes.
 */
export class DemoCheckInSource implements CheckInSource {
  private readonly subscribers: Array<(e: BadgeEvent) => void> = [];

  subscribe(cb: (e: BadgeEvent) => void): void {
    this.subscribers.push(cb);
  }

  /** Demo-only entry point, called by the badge-swipe API route. */
  emit(e: BadgeEvent): void {
    for (const cb of this.subscribers) cb(e);
  }
}
