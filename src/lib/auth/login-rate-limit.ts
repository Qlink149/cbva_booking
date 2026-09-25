import { SystemClock } from "@/lib/clock";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_KEYS = 10_000;
const clock = new SystemClock();

type Attempt = { count: number; resetAt: number };
const attempts = new Map<string, Attempt>();

function prune(now: number) {
  for (const [key, value] of attempts) {
    if (value.resetAt <= now) attempts.delete(key);
  }
  if (attempts.size > MAX_KEYS) attempts.clear();
}

/**
 * Best-effort per-instance throttling. A deployment should also apply an edge
 * rate limit, but this prevents trivial password spraying on a single instance
 * without adding a new infrastructure dependency.
 */
export function recordLoginAttempt(key: string, now = clock.now().getTime()) {
  prune(now);
  const previous = attempts.get(key);
  const next = previous && previous.resetAt > now
    ? { count: previous.count + 1, resetAt: previous.resetAt }
    : { count: 1, resetAt: now + WINDOW_MS };
  attempts.set(key, next);
  return {
    allowed: next.count <= MAX_ATTEMPTS,
    retryAfterSeconds: Math.max(1, Math.ceil((next.resetAt - now) / 1000)),
  };
}

export function clearLoginAttempts(key: string) {
  attempts.delete(key);
}

/** Test-only reset; not imported by application code. */
export function resetLoginRateLimitForTests() {
  attempts.clear();
}
