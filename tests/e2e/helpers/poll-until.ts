interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  description?: string;
}

// The default per-poll interval for every sandbox-driven assertion in the
// e2e suite. Centralized here per §spec:sandbox-test-budget so a maintainer
// can reason about worst-case per-run API cost from a single file
// (§req:sandbox-ci-budget-criteria).
//
// The shared sandbox installation enforces a ~5000-requests/hour primary
// rate-limit bucket against which the integration suite (every PR, every
// push to develop and main) and the e2e suite both draw. The e2e suite is
// polling-heavy — current estimate 300–500 API calls per run — and
// exhausting the bucket fails CI for non-code reasons, which teaches
// maintainers to treat red CI as flake-not-signal.
//
// 10 000 ms is a deliberately conservative floor: it sits above every
// explicit override currently in use (max is 5 000 ms), so changing this
// default does not alter the behavior of any existing call site —
// every scenario already passes an explicit `intervalMs`. The default
// governs only future call sites that do not opt in to faster polling.
// At a typical 60–90 s `timeoutMs`, a never-resolving default-interval
// poll consumes ≤ 9 API calls (vs ≤ 30 under the prior 3 000 ms default),
// preserving budget headroom for assertions that legitimately need
// faster feedback and that opt in explicitly per §spec:sandbox-test-budget
// ("the default is the floor, not the ceiling").
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 90_000;

export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  options: PollOptions = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const description = options.description ?? "condition";

  const start = Date.now();
  let last: T | undefined;
  let attempts = 0;

  while (Date.now() - start < timeoutMs) {
    last = await fn();
    attempts += 1;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const lastJson = safeJson(last);
  throw new Error(
    `pollUntil timed out after ${elapsed}s (${attempts} attempts) waiting for ${description}. Last value: ${lastJson}`,
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
