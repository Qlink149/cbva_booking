"use client";

import { ChevronDown } from "lucide-react";
import { useSession, useSwitchRole } from "@/components/app-shell/session";
import { GRADE_LABEL } from "@/lib/seed-data/inventory";
import type { Grade } from "@/lib/db/schema";
import { AuthButton } from "@/components/app-shell/auth-button";

/**
 * Demo affordance: switch which seeded person you are signed in as.
 *
 * This is the visible half of DemoAuthProvider — it writes the cbva_role
 * cookie the adapter reads. In production mode the endpoint 403s and this
 * control is replaced by the Entra ID identity.
 */
export function RoleSwitcher() {
  const { data, isPending } = useSession();
  const switchRole = useSwitchRole();

  if (isPending || !data) {
    return (
      <div
        className="h-8 w-40 rounded-sm border border-hairline bg-surface-sunken"
        aria-hidden="true"
      />
    );
  }

  if (data.appMode === "production") {
    return <AuthButton />;
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor="role-switcher" className="sr-only">
        Sign in as a different person (demo)
      </label>
      {/* max-w matters: a long "Firstname Lastname — Assistant Manager" option
          otherwise sets the select's intrinsic width and pushes the whole page
          into horizontal overflow on a phone. */}
      <div className="relative min-w-0">
        <select
          id="role-switcher"
          value={data.user?.email ?? ""}
          disabled={switchRole.isPending}
          onChange={(e) => switchRole.mutate(e.target.value)}
          className="h-8 w-36 appearance-none truncate rounded-sm sm:w-60 border border-hairline bg-surface py-0 pr-8 pl-2.5 text-xs text-ink focus-visible:border-navy focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy disabled:opacity-60"
        >
          {data.roles.map((r) => (
            <option key={r.email} value={r.email}>
              {r.displayName} — {GRADE_LABEL[r.grade as Grade] ?? r.grade}
              {r.isAdmin ? " (Admin)" : ""}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-ink-subtle"
        />
      </div>
      <span aria-live="polite" className="sr-only">
        {switchRole.isPending
          ? "Switching role…"
          : data.user
            ? `Signed in as ${data.user.displayName}`
            : ""}
      </span>
    </div>
  );
}
