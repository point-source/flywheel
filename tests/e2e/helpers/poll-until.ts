interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  description?: string;
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  options: PollOptions = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 90_000;
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
