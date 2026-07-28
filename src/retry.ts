import type { createLogger } from "./logger";

type Logger = ReturnType<typeof createLogger>;

export type Backoff =
  | { kind: "immediate" }
  | { kind: "fixed"; ms: number }
  | { kind: "exponential"; baseMs: number };

// The outcome of a single attempt. "retry" lets the helper pick the delay from
// the configured backoff, "retry-after" is for when the remote tells us how
// long to wait, and "fail" is a permanent error that must not be retried.
export type Attempt<T> =
  | { kind: "done"; value: T }
  | { kind: "retry"; reason: string }
  | { kind: "retry-after"; reason: string; waitMs: number }
  | { kind: "fail"; reason: string };

export interface RetryConfig {
  label: string;
  attempts: number;
  backoff: Backoff;
  log: Logger;
}

type Failure =
  | { kind: "thrown"; error: unknown }
  | { kind: "returned"; reason: string };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const delayFor = (backoff: Backoff, attempt: number): number => {
  switch (backoff.kind) {
    case "immediate":
      return 0;
    case "fixed":
      return backoff.ms;
    case "exponential":
      return backoff.baseMs * 2 ** (attempt - 1);
  }
};

// Runs `run` until it reports "done", up to `config.attempts` times. A thrown
// error counts as transient and is retried; callers that can tell a permanent
// error apart must return "fail" for it. Reasons are logged verbatim, so a
// caller whose errors embed credentials has to redact them before returning.
export const withRetry = async <T>(
  config: RetryConfig,
  run: () => Promise<Attempt<T>>,
): Promise<T> => {
  const { label, attempts, backoff, log } = config;
  let last: Failure | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let result: Attempt<T>;
    let thrown: Failure | null = null;
    try {
      result = await run();
    } catch (e: any) {
      result = { kind: "retry", reason: e?.message ?? String(e) };
      thrown = { kind: "thrown", error: e };
    }

    if (result.kind === "done") return result.value;
    if (result.kind === "fail") throw new Error(result.reason);

    last = thrown ?? { kind: "returned", reason: result.reason };

    if (attempt === attempts) break;

    const waitMs =
      result.kind === "retry-after"
        ? result.waitMs
        : delayFor(backoff, attempt);

    if (waitMs > 0) {
      log.warn(
        "%s attempt %d/%d failed: %s, retrying in %ds",
        label,
        attempt,
        attempts,
        result.reason,
        Math.ceil(waitMs / 1000),
      );
      await wait(waitMs);
    } else {
      log.warn(
        "%s attempt %d/%d failed: %s",
        label,
        attempt,
        attempts,
        result.reason,
      );
    }
  }

  if (last?.kind === "thrown") throw last.error;
  throw new Error(
    `${label} failed after ${attempts} attempts: ${last?.reason ?? "unknown"}`,
  );
};
