"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogIn, LogOut } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/components/app-shell/session";

export function AuthButton() {
  const { data, isPending } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["session"] });
    router.replace("/");
    router.refresh();
  }

  if (isPending) return <div aria-hidden="true" className="h-8 w-24 rounded-sm bg-surface-sunken" />;
  if (!data?.user) {
    return (
      <Link href="/auth/login" className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-navy px-3 text-xs font-medium text-white hover:bg-navy/90">
        <LogIn className="size-3.5" /> Sign in
      </Link>
    );
  }
  return (
    <button type="button" onClick={signOut} className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-hairline bg-surface px-3 text-xs font-medium text-ink hover:bg-surface-sunken">
      <LogOut className="size-3.5" /> Sign out
    </button>
  );
}
