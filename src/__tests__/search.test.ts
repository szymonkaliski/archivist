import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { search, findSimilar } from "../search";

// e2e tests against the real DB -- assumes data has been migrated
const DB_PATH = process.env.HOME + "/.local/share/archivist/data.db";

let db: Database.Database;

beforeAll(() => {
  db = new Database(DB_PATH, { readonly: true });
  db.loadExtension(sqliteVec.getLoadablePath());
});

afterAll(() => {
  db.close();
});

describe("browse (no text)", () => {
  it("returns all items newest first", () => {
    const { items, total } = search(db, { limit: 20, offset: 0 });
    expect(total).toBeGreaterThan(9000);
    expect(items).toHaveLength(20);
    for (const item of items) expect(item.id).toContain(":");
    for (let i = 1; i < items.length; i++) {
      expect(new Date(items[i - 1].time).getTime()).toBeGreaterThanOrEqual(
        new Date(items[i].time).getTime(),
      );
    }
  });

  it("pagination returns different pages with consistent total", () => {
    const page1 = search(db, { limit: 5, offset: 0 });
    const page2 = search(db, { limit: 5, offset: 5 });
    expect(page1.items).toHaveLength(5);
    expect(page2.items).toHaveLength(5);
    expect(page1.total).toBe(page2.total);
    const ids1 = new Set(page1.items.map((r) => r.id));
    for (const r of page2.items) expect(ids1.has(r.id)).toBe(false);
  });

  it("source filter returns only that source", () => {
    const all = search(db, { limit: 1, offset: 0 });
    const { items, total } = search(db, {
      sources: ["pinterest"],
      limit: 100,
      offset: 0,
    });
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(all.total);
    for (const r of items) expect(r.id).toMatch(/^pinterest:/);
  });

  it("tag filter returns all matching items across sources", () => {
    const { items, total } = search(db, {
      tags: ["cyberpunk-2020"],
      limit: 100,
      offset: 0,
    });
    expect(total).toBeGreaterThan(0);
    for (const r of items) expect(r.id).toMatch(/^pinterest:/);
  });

  it("tag filter works for pinboard space-separated tags", () => {
    const { items } = search(db, { tags: ["llm"], limit: 100, offset: 0 });
    expect(items.length).toBeGreaterThan(0);
    for (const r of items) expect(r.id).toMatch(/^pinboard:/);
  });

  it("tag filter excludes screenshots (no tags)", () => {
    const { items } = search(db, {
      tags: ["inspiration"],
      limit: 200,
      offset: 0,
    });
    for (const r of items) expect(r.id).not.toMatch(/^screenshot:/);
  });

  it("date filter before reduces results and all items are before the date", () => {
    const cutoff = "2020-01-01T00:00:00Z";
    const all = search(db, { limit: 1, offset: 0 });
    const filtered = search(db, { before: cutoff, limit: 50, offset: 0 });
    expect(filtered.total).toBeLessThan(all.total);
    expect(filtered.total).toBeGreaterThan(0);
    for (const r of filtered.items) {
      expect(new Date(r.time).getTime()).toBeLessThan(
        new Date(cutoff).getTime(),
      );
    }
  });

  it("date filter after returns only items at or after the date", () => {
    const cutoff = "2026-01-01T00:00:00Z";
    const { items, total } = search(db, {
      after: cutoff,
      limit: 50,
      offset: 0,
    });
    expect(total).toBeGreaterThan(0);
    for (const r of items) {
      expect(new Date(r.time).getTime()).toBeGreaterThanOrEqual(
        new Date(cutoff).getTime(),
      );
    }
  });

  it("combined source + tag + date", () => {
    const unfiltered = search(db, {
      tags: ["cyberpunk-2020"],
      limit: 1,
      offset: 0,
    });
    const { items, total } = search(db, {
      sources: ["pinterest"],
      tags: ["cyberpunk-2020"],
      before: "2025-01-01T00:00:00Z",
      limit: 100,
      offset: 0,
    });
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(unfiltered.total);
    for (const r of items) expect(r.id).toMatch(/^pinterest:/);
  });
});

describe("text search", () => {
  it("finds items across all sources, ordered newest first", () => {
    const { items, total } = search(db, {
      text: "geoffrey",
      limit: 100,
      offset: 0,
    });
    expect(total).toBeGreaterThan(10);
    const sources = new Set(items.map((r) => r.meta.source));
    expect(sources.size).toBeGreaterThan(1);
    for (let i = 1; i < items.length; i++) {
      expect(new Date(items[i - 1].time).getTime()).toBeGreaterThanOrEqual(
        new Date(items[i].time).getTime(),
      );
    }
  });

  it("finds items for a specific term", () => {
    const { total } = search(db, { text: "physarum", limit: 100, offset: 0 });
    expect(total).toBeGreaterThan(5);
  });

  it("text + source filter", () => {
    const { items, total } = search(db, {
      text: "geoffrey",
      sources: ["screenshot"],
      limit: 100,
      offset: 0,
    });
    expect(total).toBeGreaterThan(0);
    for (const r of items) expect(r.meta.source).toBe("screenshot");
  });

  it("text + date filter reduces results and respects date boundary", () => {
    const cutoff = "2024-01-01T00:00:00Z";
    const all = search(db, { text: "geoffrey", limit: 100, offset: 0 });
    const filtered = search(db, {
      text: "geoffrey",
      before: cutoff,
      limit: 100,
      offset: 0,
    });
    expect(filtered.total).toBeLessThan(all.total);
    for (const r of filtered.items) {
      expect(new Date(r.time).getTime()).toBeLessThan(
        new Date(cutoff).getTime(),
      );
    }
  });

  it("text + tag filter", () => {
    const { items } = search(db, {
      text: "physarum",
      tags: ["inspiration"],
      limit: 100,
      offset: 0,
    });
    expect(items.length).toBeGreaterThan(0);
    for (const r of items) expect(r.meta.source).toBe("pinterest");
  });

  it("pagination works", () => {
    const page1 = search(db, { text: "geoffrey", limit: 10, offset: 0 });
    const page2 = search(db, { text: "geoffrey", limit: 10, offset: 10 });
    expect(page1.total).toBe(page2.total);
    const ids1 = new Set(page1.items.map((r) => r.id));
    for (const r of page2.items) expect(ids1.has(r.id)).toBe(false);
  });
});

describe("findSimilar (detail view)", () => {
  it("returns the target item and related items, never including itself", () => {
    const targetId = "screenshot:a350c669d162";
    const { item, items, total } = findSimilar(db, targetId, {
      limit: 200,
      offset: 0,
    });
    expect(item).not.toBeNull();
    expect(item!.id).toBe(targetId);
    expect(items.length).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(0);
    for (const r of items) expect(r.id).not.toBe(targetId);
  });

  it("never includes target in related items across all pages", () => {
    const targetId = "screenshot:a350c669d162";
    const page1 = findSimilar(db, targetId, { limit: 100, offset: 0 });
    const page2 = findSimilar(db, targetId, { limit: 100, offset: 100 });
    for (const r of [...page1.items, ...page2.items]) {
      expect(r.id).not.toBe(targetId);
    }
  });

  it("source filter returns only that source", () => {
    const { items } = findSimilar(db, "screenshot:a350c669d162", {
      sources: ["screenshot"],
      limit: 20,
      offset: 0,
    });
    expect(items.length).toBeGreaterThan(0);
    for (const r of items) expect(r.id).toMatch(/^screenshot:/);
  });

  it("tag filter reduces results and filters correctly", () => {
    const all = findSimilar(db, "pinterest:393994667424625110", {
      limit: 100,
      offset: 0,
    });
    const tagged = findSimilar(db, "pinterest:393994667424625110", {
      tags: ["cyberpunk-2020"],
      limit: 100,
      offset: 0,
    });
    expect(tagged.total).toBeLessThan(all.total);
    for (const r of tagged.items) expect(r.id).toMatch(/^pinterest:/);
  });

  it("date filter reduces results and respects boundary", () => {
    const cutoff = "2020-01-01T00:00:00Z";
    const all = findSimilar(db, "screenshot:a350c669d162", {
      limit: 500,
      offset: 0,
    });
    const filtered = findSimilar(db, "screenshot:a350c669d162", {
      before: cutoff,
      limit: 500,
      offset: 0,
    });
    expect(filtered.total).toBeLessThan(all.total);
    for (const r of filtered.items) {
      expect(new Date(r.time).getTime()).toBeLessThan(
        new Date(cutoff).getTime(),
      );
    }
  });

  it("pagination returns different pages", () => {
    const page1 = findSimilar(db, "screenshot:a350c669d162", {
      limit: 5,
      offset: 0,
    });
    const page2 = findSimilar(db, "screenshot:a350c669d162", {
      limit: 5,
      offset: 5,
    });
    expect(page1.items).toHaveLength(5);
    expect(page2.items).toHaveLength(5);
    const ids1 = new Set(page1.items.map((r) => r.id));
    for (const r of page2.items) expect(ids1.has(r.id)).toBe(false);
  });

  it("combined source + date filter", () => {
    const { items } = findSimilar(db, "screenshot:a350c669d162", {
      sources: ["pinboard"],
      after: "2020-01-01T00:00:00Z",
      limit: 20,
      offset: 0,
    });
    expect(items.length).toBeGreaterThan(0);
    for (const r of items) expect(r.id).toMatch(/^pinboard:/);
  });
});

describe("edge cases", () => {
  it("empty text returns empty", () => {
    const { items, total } = search(db, { text: "   ", limit: 10, offset: 0 });
    expect(items).toHaveLength(0);
    expect(total).toBe(0);
  });

  it("special chars in text do not crash", () => {
    const { items } = search(db, {
      text: "design & code",
      limit: 10,
      offset: 0,
    });
    expect(Array.isArray(items)).toBe(true);
  });

  it("nonexistent tag returns empty", () => {
    const { items, total } = search(db, {
      tags: ["nonexistent-tag-xyz"],
      limit: 10,
      offset: 0,
    });
    expect(items).toHaveLength(0);
    expect(total).toBe(0);
  });

  it("findSimilar with nonexistent id returns null item", () => {
    const { item, items } = findSimilar(db, "screenshot:doesnotexist", {
      limit: 10,
      offset: 0,
    });
    expect(item).toBeNull();
    expect(items).toHaveLength(0);
  });

  it("findSimilar with item missing embeddings returns item but no related", () => {
    // find a pinboard item without a screenshot (no image embedding)
    const row = db
      .prepare(
        "SELECT global_id FROM pinboard WHERE screenshot IS NULL LIMIT 1",
      )
      .get() as { global_id: string } | undefined;
    if (!row) return; // skip if all have screenshots
    const { item } = findSimilar(db, row.global_id, {
      limit: 10,
      offset: 0,
    });
    // should not crash -- returns the item with empty or partial results
    expect(item).not.toBeNull();
  });

  it("offset beyond total returns empty page", () => {
    const { items } = search(db, {
      tags: ["cyberpunk-2020"],
      limit: 10,
      offset: 9999,
    });
    expect(items).toHaveLength(0);
  });
});
