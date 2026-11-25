import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, afterEach } from "vitest";

import {
  IMAGE_MIME_TYPES,
  buildAllowedRoots,
  resolveServedFile,
} from "../server/files";

const tempDirs: string[] = [];

const makeTempTree = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "archivist-files-"));
  tempDirs.push(base);
  const allowed = path.join(base, "thumbs");
  const sibling = path.join(base, "thumbs2");
  const secret = path.join(base, "secret");
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.mkdirSync(secret, { recursive: true });
  return { base, allowed, sibling, secret };
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("resolveServedFile", () => {
  it("allows files with valid extensions inside allowed roots, including symlinked roots", () => {
    const { base, allowed } = makeTempTree();
    const img = path.join(allowed, "a.png");
    fs.writeFileSync(img, "pngdata");

    const linkRoot = path.join(base, "shots-link");
    fs.symlinkSync(allowed, linkRoot);
    const roots = buildAllowedRoots([linkRoot]);

    expect(
      resolveServedFile(path.join(linkRoot, "a.png"), roots, IMAGE_MIME_TYPES),
    ).toEqual({
      kind: "ok",
      filePath: fs.realpathSync(img),
      contentType: "image/png",
    });
  });

  it("blocks files outside allowed roots, sibling prefixes, and symlinks escaping roots", () => {
    const { allowed, sibling, secret } = makeTempTree();
    const roots = buildAllowedRoots([allowed]);

    const secretImg = path.join(secret, "leak.png");
    fs.writeFileSync(secretImg, "secret");
    expect(resolveServedFile(secretImg, roots, IMAGE_MIME_TYPES)).toEqual({
      kind: "forbidden",
    });

    const siblingImg = path.join(sibling, "other.png");
    fs.writeFileSync(siblingImg, "other");
    expect(resolveServedFile(siblingImg, roots, IMAGE_MIME_TYPES)).toEqual({
      kind: "forbidden",
    });

    const escapeLink = path.join(allowed, "escape.png");
    fs.symlinkSync(secretImg, escapeLink);
    expect(resolveServedFile(escapeLink, roots, IMAGE_MIME_TYPES)).toEqual({
      kind: "forbidden",
    });
  });

  it("rejects directories, disallowed extensions, traversal, and missing files", () => {
    const { allowed } = makeTempTree();
    const roots = buildAllowedRoots([allowed]);

    const subDir = path.join(allowed, "dir.png");
    fs.mkdirSync(subDir);
    expect(resolveServedFile(subDir, roots, IMAGE_MIME_TYPES)).toEqual({
      kind: "invalid",
    });

    const dbFile = path.join(allowed, "data.db");
    fs.writeFileSync(dbFile, "sqlite");
    expect(resolveServedFile(dbFile, roots, IMAGE_MIME_TYPES)).toEqual({
      kind: "invalid",
    });

    expect(
      resolveServedFile(
        path.join(allowed, "..", "secret", "x.png"),
        roots,
        IMAGE_MIME_TYPES,
      ),
    ).toEqual({ kind: "forbidden" });

    expect(
      resolveServedFile(`${allowed}/../secret/x.png`, roots, IMAGE_MIME_TYPES),
    ).toEqual({ kind: "invalid" });

    expect(
      resolveServedFile(
        path.join(allowed, "missing.png"),
        roots,
        IMAGE_MIME_TYPES,
      ),
    ).toEqual({ kind: "not_found" });
  });
});
