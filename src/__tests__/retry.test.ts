import { describe, it, expect, vi } from "vitest";
import { withRetry, type Attempt } from "../retry";

const log = { warn: vi.fn() } as any;

const config = (attempts: number) => ({
  label: "test",
  attempts,
  backoff: { kind: "immediate" as const },
  log,
});

describe("withRetry", () => {
  it("returns the value without retrying when the first attempt succeeds", async () => {
    const run = vi.fn(
      async (): Promise<Attempt<number>> => ({
        kind: "done",
        value: 1,
      }),
    );

    await expect(withRetry(config(3), run)).resolves.toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown error and returns the eventual value", async () => {
    let calls = 0;
    const run = async (): Promise<Attempt<string>> => {
      calls++;
      if (calls < 3) throw new Error("boom");
      return { kind: "done", value: "ok" };
    };

    await expect(withRetry(config(3), run)).resolves.toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows the original error once attempts are spent", async () => {
    const error = new Error("still broken");
    const run = async (): Promise<Attempt<never>> => {
      throw error;
    };

    await expect(withRetry(config(3), run)).rejects.toBe(error);
  });

  it("retries a returned retry and reports the reason on exhaustion", async () => {
    let calls = 0;
    const run = async (): Promise<Attempt<never>> => {
      calls++;
      return { kind: "retry", reason: "API 500" };
    };

    await expect(withRetry(config(2), run)).rejects.toThrow(
      "test failed after 2 attempts: API 500",
    );
    expect(calls).toBe(2);
  });

  it("does not retry a permanent failure", async () => {
    let calls = 0;
    const run = async (): Promise<Attempt<never>> => {
      calls++;
      return { kind: "fail", reason: "API 401" };
    };

    await expect(withRetry(config(5), run)).rejects.toThrow("API 401");
    expect(calls).toBe(1);
  });

  it("waits for the caller-supplied delay on retry-after", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const run = async (): Promise<Attempt<string>> => {
        calls++;
        if (calls === 1) {
          return {
            kind: "retry-after",
            reason: "rate limited",
            waitMs: 30_000,
          };
        }
        return { kind: "done", value: "ok" };
      };

      const pending = withRetry(config(3), run);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits the same fixed delay between every attempt", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const run = async (): Promise<Attempt<never>> => {
        calls++;
        throw new Error("boom");
      };

      const pending = withRetry(
        {
          label: "test",
          attempts: 3,
          backoff: { kind: "fixed", ms: 300_000 },
          log,
        },
        run,
      ).catch((e) => e);

      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(299_999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(299_999);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(3);

      expect((await pending).message).toBe("boom");
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off exponentially from the configured base", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const run = async (): Promise<Attempt<never>> => {
        calls++;
        throw new Error("boom");
      };

      const pending = withRetry(
        {
          label: "test",
          attempts: 4,
          backoff: { kind: "exponential", baseMs: 1000 },
          log,
        },
        run,
      ).catch((e) => e);

      // waits of 1000, 2000 and 4000 separate the four attempts
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(3);
      await vi.advanceTimersByTimeAsync(3999);
      expect(calls).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(4);

      expect(await pending).toBeInstanceOf(Error);
      expect((await pending).message).toBe("boom");
    } finally {
      vi.useRealTimers();
    }
  });
});
