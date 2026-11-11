import { afterEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "puppeteer";
import {
  captureOnce,
  redirectedToRoot,
  savePage,
  tryArchiveToday,
} from "../sources/pinboard/fetcher";

describe("redirectedToRoot", () => {
  it("keeps redirects from a path to query-routed or hash-routed pages", () => {
    expect(
      redirectedToRoot(
        "https://example.com/p/123",
        "https://example.com/?id=123",
      ),
    ).toBe(false);
    expect(
      redirectedToRoot(
        "https://example.com/p/123",
        "https://example.com/#/post/123",
      ),
    ).toBe(false);
  });

  it("flags redirects to the bare root even when the requested URL had query params", () => {
    expect(
      redirectedToRoot(
        "https://example.com/2020/post?utm_source=rss",
        "https://example.com/",
      ),
    ).toBe(true);
    expect(
      redirectedToRoot(
        "https://example.com/2020/post",
        "https://example.com/#",
      ),
    ).toBe(true);
  });

  it("ignores root and index requests", () => {
    expect(
      redirectedToRoot(
        "https://example.com/?utm_source=hn",
        "https://example.com/",
      ),
    ).toBe(false);
    expect(
      redirectedToRoot(
        "https://example.com/index.html",
        "https://example.com/",
      ),
    ).toBe(false);
  });
});

describe("captureOnce", () => {
  it("reports failed when both screenshot and freeze fail", async () => {
    const bodyText = "x".repeat(300);
    const fakePage = {
      on: vi.fn(),
      setBypassCSP: vi.fn().mockResolvedValue(undefined),
      setViewport: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      url: () => "https://example.com/article",
      evaluate: vi.fn(async (script: string) => {
        if (script.includes("innerText")) return bodyText;
        throw new Error("CSP blocked eval");
      }),
      screenshot: vi.fn().mockRejectedValue(new Error("screenshot failed")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const fakeBrowser = {
      newPage: vi.fn().mockResolvedValue(fakePage),
    } as unknown as Browser;

    const attempt = await captureOnce(
      fakeBrowser,
      "https://example.com/article",
      "/tmp/nonexistent-shot.png",
      "/tmp/nonexistent-frozen.html",
      async () => ({ kind: "hard_404" }),
    );

    expect(attempt).toEqual({
      kind: "done",
      value: { kind: "failed" },
    });
  });
});

describe("Pinboard archive lookup and transient handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("treats HTTP 429 and 503 from archive.today as unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Too Many Requests", { status: 429 }),
    );

    const res = await tryArchiveToday("https://dead.example.test/post");
    expect(res).toEqual({ kind: "unavailable" });
  });

  it("returns transient_failed instead of permanently_failed when an archive lookup is unavailable", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("web.archive.org")) {
        return new Response("Service Unavailable", { status: 503 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const fakeBrowser = {
      newPage: vi.fn(),
    } as unknown as Browser;

    const pending = savePage(
      fakeBrowser,
      "http://127.0.0.1:1/recoverable-article",
      async () => ({ kind: "hard_404" }),
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toEqual({ kind: "transient_failed" });
  });

  it("returns permanently_failed when dead and both archives answer none", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );

    const fakeBrowser = {
      newPage: vi.fn(),
    } as unknown as Browser;

    const pending = savePage(
      fakeBrowser,
      "http://127.0.0.1:1/truly-gone-article",
      async () => ({ kind: "hard_404" }),
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toEqual({ kind: "permanently_failed" });
  });
});
