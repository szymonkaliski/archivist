import { afterEach, describe, expect, it, vi } from "vitest";
import {
  matchesBoardFeedUrl,
  PIN_PAGINATE,
} from "../sources/pinterest/crawler";

const runPinPaginate = (
  firstUrl: string,
  headers: Record<string, string>,
  knownIds: string[],
  fakeFetch: typeof fetch,
) => {
  const fn = new Function("fetch", "location", `return (${PIN_PAGINATE});`)(
    fakeFetch,
    { origin: "https://pl.pinterest.com" },
  );
  return fn(firstUrl, headers, knownIds);
};

describe("PIN_PAGINATE", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const firstUrl =
    "https://pl.pinterest.com/resource/BoardFeedResource/get/?source_url=%2Falice%2Fink%2F&data=%7B%22options%22%3A%7B%22board_id%22%3A%221%22%7D%7D";

  it("stops at bookmark === '-end-' without issuing an extra request", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          resource_response: {
            data: [
              {
                id: "101",
                type: "pin",
                images: {
                  orig: { url: "https://i.pinimg.com/originals/1.jpg" },
                },
              },
            ],
            bookmark: "-end-",
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const pending = runPinPaginate(firstUrl, {}, [], fakeFetch);
    await vi.runAllTimersAsync();
    const res = await pending;

    expect(calls).toHaveLength(1);
    expect(res.kind).toBe("ok");
    expect(res.rawPins).toHaveLength(1);
  });

  it("surfaces HTTP errors on page 1+ instead of returning a truncated board as ok", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const fakeFetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            resource_response: {
              data: [
                {
                  id: "101",
                  type: "pin",
                  images: {
                    orig: { url: "https://i.pinimg.com/originals/1.jpg" },
                  },
                },
              ],
              bookmark: "cursor-page-2",
            },
          }),
          { status: 200 },
        );
      }
      return new Response("Rate limit", { status: 429 });
    }) as unknown as typeof fetch;

    const pending = runPinPaginate(firstUrl, {}, [], fakeFetch);
    await vi.runAllTimersAsync();
    const res = await pending;

    expect(res).toEqual({ kind: "http_error", status: 429 });
  });
});

describe("matchesBoardFeedUrl", () => {
  it("matches mixed-case profile names and percent-encoded non-ASCII board slugs", () => {
    const doubleEncoded =
      "https://pl.pinterest.com/resource/BoardFeedResource/get/?source_url=%2Falice%2Fcaf%25C3%25A9%2F&data=%7B%7D";
    const singleEncoded =
      "https://pl.pinterest.com/resource/BoardFeedResource/get/?source_url=%2Falice%2Fcaf%C3%A9%2F&data=%7B%7D";

    expect(matchesBoardFeedUrl(doubleEncoded, "Alice", "caf%C3%A9")).toBe(true);
    expect(matchesBoardFeedUrl(singleEncoded, "Alice", "caf%C3%A9")).toBe(true);
  });

  it("rejects other boards and malformed percent-encodings without throwing", () => {
    const otherBoard =
      "https://pl.pinterest.com/resource/BoardFeedResource/get/?source_url=%2Falice%2Fother%2F&data=%7B%7D";
    const malformed =
      "https://pl.pinterest.com/resource/BoardFeedResource/get/?source_url=%E0%A4%A";
    const malformedNoSource =
      "https://pl.pinterest.com/resource/BoardFeedResource/get/?data=%E0%A4%A";

    expect(matchesBoardFeedUrl(otherBoard, "Alice", "caf%C3%A9")).toBe(false);
    expect(() =>
      matchesBoardFeedUrl(malformed, "Alice", "caf%C3%A9"),
    ).not.toThrow();
    expect(matchesBoardFeedUrl(malformed, "Alice", "caf%C3%A9")).toBe(false);
    expect(() =>
      matchesBoardFeedUrl(malformedNoSource, "Alice", "caf%C3%A9"),
    ).not.toThrow();
    expect(matchesBoardFeedUrl(malformedNoSource, "Alice", "caf%C3%A9")).toBe(
      false,
    );
  });
});
