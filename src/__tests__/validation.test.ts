import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  assertDeletionSafe,
  checkDeletionSafe,
  nonEmptyString,
  parseWithSchema,
  verifyPageSelectors,
} from "../validation";
import {
  BoardFeedPinSchema,
  extractPinMetadata,
  PinterestPinDetailSchema,
  selectPinImages,
  toCrawledPin,
  validateBoardFeedResult,
} from "../sources/pinterest/crawler";
import { PinboardLinkSchema } from "../sources/pinboard/index";
import { ArenaBlockSchema, ArenaChannelSchema } from "../sources/arena/index";

const makeDomPage = (html: string, url = "https://pinterest.com/test") => {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  return {
    evaluate: async (expr: string) => dom.window.eval(expr),
  };
};

describe("nonEmptyString", () => {
  it("trims whitespace and rejects whitespace-only strings", () => {
    expect(nonEmptyString(null)).toBeUndefined();
    expect(nonEmptyString(undefined)).toBeUndefined();
    expect(nonEmptyString("")).toBeUndefined();
    expect(nonEmptyString(" ")).toBeUndefined();
    expect(nonEmptyString("  \n\t ")).toBeUndefined();
    expect(nonEmptyString("  record console ")).toBe("record console");
  });
});

describe("verifyPageSelectors", () => {
  it("returns ok when every selector matches", async () => {
    const page = makeDomPage(
      `<!doctype html><html><head><title>Boards</title></head><body>
        <div aria-label="Board"><a href="https://pinterest.com/u/b1/">B1</a></div>
        <div aria-label="Board"><a href="https://pinterest.com/u/b2/">B2</a></div>
      </body></html>`,
      "https://pinterest.com/u/boards",
    );

    const res = await verifyPageSelectors(page, [
      '[aria-label="Board"] a[href]',
    ]);
    expect(res).toEqual({ kind: "ok" });
  });

  it("returns drifted with the first missing selector when DOM changes", async () => {
    const page = makeDomPage(
      `<!doctype html><html><head><title>Login</title></head><body>
        <input id="streamlined-login-email" />
      </body></html>`,
      "https://pinterest.com/login",
    );

    const res = await verifyPageSelectors(page, [
      "#streamlined-login-email",
      "#streamlined-login-password",
    ]);

    expect(res.kind).toBe("drifted");
    if (res.kind === "drifted") {
      expect(res.missingSelector).toBe("#streamlined-login-password");
      expect(res.url).toBe("https://pinterest.com/login");
      expect(res.title).toBe("Login");
    }
  });
});

describe("checkDeletionSafe / assertDeletionSafe", () => {
  it("allows normal small removals", () => {
    expect(checkDeletionSafe("pinterest", 2698, 5)).toEqual({ kind: "safe" });
    expect(() => assertDeletionSafe("pinterest", 2698, 5)).not.toThrow();
  });

  it("allows removals on tiny archives below the guard threshold", () => {
    expect(checkDeletionSafe("arena", 5, 4)).toEqual({ kind: "safe" });
  });

  it("blocks mass deletions exceeding 20% of the archive", () => {
    const check = checkDeletionSafe("pinboard", 2073, 2073);
    expect(check.kind).toBe("blocked");
    expect(() => assertDeletionSafe("pinboard", 2073, 500)).toThrow(
      /pinboard crawl would delete 500\/2073 items/,
    );
  });
});

describe("Pinterest schemas and extractors", () => {
  it("falls back to 1200x/736x JPEG when orig image is HEIC", () => {
    const images = {
      orig: {
        url: "https://i.pinimg.com/originals/6b/cf/3d/6bcf3d.heic",
        width: 4284,
        height: 5712,
      },
      "1200x": {
        url: "https://i.pinimg.com/1200x/6b/cf/3d/6bcf3d.jpg",
        width: 1200,
        height: 1600,
      },
      "474x": {
        url: "https://i.pinimg.com/474x/6b/cf/3d/6bcf3d.jpg",
        width: 474,
        height: 632,
      },
    };

    expect(selectPinImages(images)).toEqual({
      biggestSrc: "https://i.pinimg.com/1200x/6b/cf/3d/6bcf3d.jpg",
      src: "https://i.pinimg.com/474x/6b/cf/3d/6bcf3d.jpg",
    });
  });

  it("ignores single-space description and falls back to auto_alt_text on board feed pins", () => {
    const raw = BoardFeedPinSchema.parse({
      type: "pin",
      id: "100001",
      title: "",
      grid_title: "",
      description: " ",
      alt_text: null,
      auto_alt_text: "a person sitting at a table in a room",
      images: {
        orig: { url: "https://i.pinimg.com/originals/6b/cf/3d/6bcf3d.heic" },
        "1200x": { url: "https://i.pinimg.com/1200x/6b/cf/3d/6bcf3d.jpg" },
      },
    });

    const crawled = toCrawledPin(raw, "https://pl.pinterest.com", "living");
    expect(crawled.biggestSrc).toBe(
      "https://i.pinimg.com/1200x/6b/cf/3d/6bcf3d.jpg",
    );
    expect(crawled.alt).toBe("a person sitting at a table in a room");
  });

  it("throws when BoardFeedResource items drift from expected pin schema", () => {
    expect(() =>
      validateBoardFeedResult(
        {
          kind: "ok",
          origin: "https://pl.pinterest.com",
          rawItemsSeen: 2,
          stoppedAtKnown: false,
          firstNonMatchingItem: null,
          rawPins: [
            { id: "1", type: "pin", images: {} },
            { id: "2", type: "pin", images: {} },
          ],
        },
        "https://pl.pinterest.com/u/board/",
        "board",
      ),
    ).toThrow(/pinterest BoardFeedResource pin schema drifted/);
  });

  it("extracts pin detail metadata and falls back past whitespace-only descriptions", () => {
    const detail = PinterestPinDetailSchema.parse({
      id: "100002",
      link: null,
      title: "222",
      grid_title: "",
      closeup_unified_title: "",
      description: " ",
      closeup_unified_description: " ",
      auto_alt_text: "an image of a woman holding a snake",
      created_at: "Thu, 08 Oct 2026 10:43:22 +0000",
      is_promoted: false,
      board: {
        url: "/alice/ink/",
        owner: { username: "alice" },
      },
      pinner: { username: "alice" },
    });

    expect(extractPinMetadata(detail)).toEqual({
      link: undefined,
      title: "222",
      text: "an image of a woman holding a snake",
      createdAt: "Thu, 08 Oct 2026 10:43:22 +0000",
      boardOwner: "alice",
      pinner: "alice",
      isPromoted: false,
    });
  });

  it("rejects pin detail objects missing created_at", () => {
    const parsed = PinterestPinDetailSchema.safeParse({
      id: "123",
      description: "hello",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("Are.na and Pinboard schemas", () => {
  it("validates Pinboard links and reports field path on drift", () => {
    expect(() =>
      parseWithSchema(
        PinboardLinkSchema,
        { href: "https://example.com", description: "test" },
        "pinboard link",
      ),
    ).toThrow(/pinboard link schema validation failed \(hash:/);
  });

  it("validates Are.na channels and blocks", () => {
    expect(() =>
      parseWithSchema(
        ArenaChannelSchema,
        {
          id: 1,
          type: "Channel",
          title: "UI",
          slug: "ui",
          counts: { blocks: 10, contents: 10 },
        },
        "arena channel",
      ),
    ).not.toThrow();

    expect(() =>
      parseWithSchema(
        ArenaBlockSchema,
        {
          id: 1,
          type: "UnknownType",
          base_type: "Block",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        "arena block",
      ),
    ).toThrow(/arena block schema validation failed \(type:/);
  });
});
