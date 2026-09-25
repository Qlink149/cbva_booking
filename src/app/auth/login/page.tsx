"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Lock, LogIn, Mail } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Unable to sign in.");
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      router.replace("/");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mx-auto max-w-md rounded-md border border-hairline bg-surface p-6 shadow-xs sm:p-8">
      <h1 className="font-title text-2xl text-ink">Sign in to CBVA Workspace</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Use the credentials issued by your workspace administrator.
      </p>
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <label className="block text-sm font-medium text-ink" htmlFor="email">
          Work email
          <span className="relative mt-1 block">
            <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-10 w-full rounded-sm border border-hairline bg-paper py-2 pr-3 pl-9 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
            />
          </span>
        </label>
        <label className="block text-sm font-medium text-ink" htmlFor="password">
          Password
          <span className="relative mt-1 block">
            <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-10 w-full rounded-sm border border-hairline bg-paper py-2 pr-3 pl-9 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
            />
          </span>
        </label>
        {error ? <p role="alert" className="rounded-sm bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-sm bg-navy px-4 text-sm font-medium text-white hover:bg-navy/90 disabled:opacity-60"
        >
          <LogIn className="size-4" />
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <Link href="/" className="mt-5 inline-block text-sm text-navy hover:underline">
        Back to workspace
      </Link>
    </section>
  );
}
