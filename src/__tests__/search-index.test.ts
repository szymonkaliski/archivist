import fs from "fs";
import os from "os";
import path from "path";
import type Database from "better-sqlite3";
import { describe, it, expect, afterEach } from "vitest";

import { openDb } from "../db";
import {
  search,
  findSimilar,
  warmSearchIndex,
  type SearchOptions,
} from "../search";
import { SOURCES } from "../sources/registry";
import type { VecIndex } from "../vec-index";

const tempDirs: string[] = [];

const makeTempDbPath = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archivist-test-"));
  tempDirs.push(dir);
  return path.join(dir, "test.db");
};

const assertFtsIntegrity = (db: Database.Database): void => {
  for (const source of Object.values(SOURCES)) {
    const fts = source.ftsTable;
    db.exec(`INSERT INTO ${fts}(${fts}, rank) VALUES('integrity-check', 1)`);
  }
};

const searchIds = (
  db: Database.Database,
  opts: Partial<SearchOptions>,
): string[] =>
  search(db, { limit: 10, offset: 0, ...opts }).items.map((i) => i.id);

const emptyVecIndex: VecIndex = {
  hasImage: () => false,
  hasText: () => false,
  searchImage: () => [],
  searchText: () => [],
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("search index and FTS5 triggers", () => {
  it("keeps FTS5 and SearchIndex synced across CRUD, WAL commits, rollbacks, and edge cases", () => {
    const dbPath = makeTempDbPath();
    const writer = openDb(dbPath);
    const reader = openDb(dbPath, { readonly: true });
    warmSearchIndex(reader);

    writer.exec(`
      INSERT INTO pinboard (global_id, href, hash, meta, description, extended, tags, time, screenshot, frozen, fulltext)
      VALUES ('pinboard:a1', 'https://a.test/design-system', 'a1', '', 'Alpha Design-System', '', 'iOS tools', '2025-01-01T00:00:00Z', NULL, NULL, 'alpha body');

      INSERT INTO screenshot (global_id, filepath, filename, time, width, height, link, note)
      VALUES ('screenshot:s1', '/tmp/a.png', 'a.png', '2025-02-01T00:00:00Z', 100, 100, NULL, NULL);

      INSERT INTO arena (global_id, block_id, title, description, content, source_url, block_class, connected_at, channels, filename, width, height)
      VALUES ('arena:1', 1, 'Initial Title', NULL, NULL, NULL, 'Text', '2025-03-01T00:00:00Z', 'Drafts\tUI', NULL, 0, 0);

      INSERT INTO pinterest (global_id, board, filename, title, text, link, pinurl, pinid, crawldate, createdat, width, height)
      VALUES ('pinterest:p1', 'design', 'p1.jpg', 'Pin One', 'keyboard poster', NULL, 'https://pin/p1', 'p1', '2025-04-01T00:00:00Z', NULL, 100, 100);
    `);
    assertFtsIntegrity(writer);

    // Cross-connection WAL reader invalidates via pragma_data_version; NULL createdat sorts last and is excluded by date bounds
    expect(searchIds(reader, {})).toEqual([
      "arena:1",
      "screenshot:s1",
      "pinboard:a1",
      "pinterest:p1",
    ]);
    expect(
      search(reader, { before: "2030-01-01T00:00:00Z", limit: 10, offset: 0 })
        .total,
    ).toBe(3);
    expect(
      searchIds(reader, {
        after: "2025-01-01T00:00:00Z",
        before: "2025-03-01T00:00:00Z",
      }),
    ).toEqual(["screenshot:s1", "pinboard:a1"]);
    expect(
      searchIds(reader, {
        after: "2025-03-01T00:00:00Z",
        before: "2025-01-01T00:00:00Z",
      }),
    ).toEqual([]);

    // Phrase, 1-char prefix, and case-insensitive tag matching
    expect(searchIds(writer, { text: "design-system" })).toEqual([
      "pinboard:a1",
    ]);
    expect(searchIds(reader, { text: "k" })).toEqual(["pinterest:p1"]);
    expect(searchIds(reader, { tags: ["ios"] })).toEqual(["pinboard:a1"]);
    expect(searchIds(reader, { tags: ["ui"] })).toEqual(["arena:1"]);

    // INSERT OR REPLACE swaps FTS tokens cleanly
    writer.exec(`
      INSERT OR REPLACE INTO pinboard (global_id, href, hash, meta, description, extended, tags, time, screenshot, frozen, fulltext)
      VALUES ('pinboard:a1', 'https://a.test', 'a1', '', 'Gamma Bookmark', '', 'tools', '2025-01-01T00:00:00Z', NULL, NULL, 'gamma body');
    `);
    assertFtsIntegrity(writer);
    expect(searchIds(reader, { text: "alpha" })).toEqual([]);
    expect(searchIds(reader, { text: "gamma" })).toEqual(["pinboard:a1"]);

    // UPDATE screenshot indexed cols updates FTS; non-indexed xattr_attempts keeps FTS intact
    writer.exec(`
      UPDATE screenshot SET link = 'https://s.test', note = 'zebra diagram' WHERE global_id = 'screenshot:s1';
      UPDATE screenshot SET xattr_attempts = xattr_attempts + 1 WHERE global_id = 'screenshot:s1';
    `);
    assertFtsIntegrity(writer);
    expect(searchIds(reader, { text: "zebra" })).toEqual(["screenshot:s1"]);

    // UPDATE arena channels updates FTS and tag filter
    writer.exec(
      `UPDATE arena SET channels = 'Published\tUI' WHERE block_id = 1`,
    );
    assertFtsIntegrity(writer);
    expect(searchIds(reader, { tags: ["published"] })).toEqual(["arena:1"]);
    expect(searchIds(reader, { tags: ["drafts"] })).toEqual([]);

    // DELETE clears FTS and index
    writer.exec(`DELETE FROM screenshot WHERE global_id = 'screenshot:s1'`);
    assertFtsIntegrity(writer);
    expect(searchIds(reader, { text: "zebra" })).toEqual([]);
    expect(search(reader, { limit: 10, offset: 0 }).total).toBe(3);

    // Rolled-back transaction calling search() must not poison SearchIndex cache
    writer.exec("BEGIN");
    writer.exec(`
      INSERT INTO screenshot (global_id, filepath, filename, time, width, height, link, note)
      VALUES ('screenshot:rolled', '/tmp/rolled.png', 'rolled.png', '2026-01-01T00:00:00Z', 100, 100, NULL, 'phantom');
    `);
    expect(searchIds(writer, { text: "phantom" })).toEqual([
      "screenshot:rolled",
    ]);
    writer.exec("ROLLBACK");
    expect(searchIds(writer, { text: "phantom" })).toEqual([]);
    expect(search(writer, { limit: 10, offset: 0 }).total).toBe(3);

    // Edge cases: duplicate/unknown/prototype source names and limit=0
    expect(searchIds(reader, { sources: ["pinboard", "pinboard"] })).toEqual([
      "pinboard:a1",
    ]);
    for (const bad of ["nonexistent", "constructor", "__proto__"]) {
      expect(
        search(reader, { sources: [bad as any], limit: 10, offset: 0 }),
      ).toEqual({ items: [], total: 0 });
    }
    expect(
      findSimilar(reader, emptyVecIndex, "constructor:1", {
        limit: 10,
        offset: 0,
      }),
    ).toEqual({ item: null, items: [], total: 0 });
    expect(search(reader, { text: "gamma", limit: 0, offset: 0 })).toEqual({
      items: [],
      total: 1,
    });

    reader.close();
    writer.close();
  });
});
