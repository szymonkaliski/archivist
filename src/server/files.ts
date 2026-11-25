import fs from "fs";
import path from "path";

export const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface AllowedRoots {
  lexical: string[];
  real: string[];
}

export type ResolvedFile =
  | { kind: "ok"; filePath: string; contentType: string }
  | { kind: "invalid" }
  | { kind: "forbidden" }
  | { kind: "not_found" };

export const buildAllowedRoots = (roots: readonly string[]): AllowedRoots => {
  const lexical: string[] = [];
  const real: string[] = [];
  for (const dir of roots) {
    const resolved = path.resolve(dir);
    lexical.push(resolved);
    try {
      real.push(fs.realpathSync(resolved));
    } catch {
      real.push(resolved);
    }
  }
  return { lexical, real };
};

const isWithinRoot = (target: string, root: string): boolean => {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

const isWithinAny = (target: string, roots: readonly string[]): boolean =>
  roots.some((root) => isWithinRoot(target, root));

export const resolveServedFile = (
  decoded: string,
  allowed: AllowedRoots,
  mimeByExt: Record<string, string>,
): ResolvedFile => {
  if (!decoded || decoded.includes("\0")) return { kind: "invalid" };
  const resolved = path.resolve(decoded);
  if (!path.isAbsolute(resolved) || resolved !== decoded) {
    return { kind: "invalid" };
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = Object.hasOwn(mimeByExt, ext) ? mimeByExt[ext] : null;
  if (!contentType) return { kind: "invalid" };

  if (
    !isWithinAny(resolved, allowed.lexical) &&
    !isWithinAny(resolved, allowed.real)
  ) {
    return { kind: "forbidden" };
  }

  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return { kind: "not_found" };
  }

  if (!isWithinAny(real, allowed.real)) {
    return { kind: "forbidden" };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return { kind: "not_found" };
  }
  if (!stat.isFile()) return { kind: "invalid" };

  return { kind: "ok", filePath: real, contentType };
};
