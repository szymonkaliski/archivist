import type { z } from "zod";

const MAX_DELETION_RATIO = 0.2;
const MIN_ARCHIVE_FOR_GUARD = 10;

export type PageCheckResult =
  | { kind: "ok" }
  | {
      kind: "drifted";
      missingSelector: string;
      url: string;
      title: string;
      htmlLen: number;
    };

export type DeletionGuardResult =
  | { kind: "safe" }
  | {
      kind: "blocked";
      reason: string;
    };

export const nonEmptyString = (
  value: string | null | undefined,
): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const formatZodError = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (!issue) return error.message;
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${path}: ${issue.message}`;
};

export const parseWithSchema = <T>(
  schema: z.ZodType<T>,
  data: unknown,
  label: string,
): T => {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `${label} schema validation failed (${formatZodError(parsed.error)})`,
    );
  }
  return parsed.data;
};

// Runs in the browser context via a string expression so bundler helpers from
// module scope never leak into page.evaluate.
export const verifyPageSelectors = async (
  page: { evaluate: (expr: string) => Promise<unknown> },
  selectors: readonly string[],
): Promise<PageCheckResult> => {
  const diag = (await page.evaluate(`(() => {
    var selectors = ${JSON.stringify(selectors)};
    for (var i = 0; i < selectors.length; i++) {
      var sel = selectors[i];
      if (!document.querySelector(sel)) {
        var html = document.documentElement ? document.documentElement.outerHTML : "";
        var title = (document.title || "").replace(/\\s+/g, " ").trim();
        return {
          missingSelector: sel,
          url: location.href,
          title: title,
          htmlLen: html.length,
        };
      }
    }
    return { missingSelector: null };
  })()`)) as
    | { missingSelector: null }
    | {
        missingSelector: string;
        url: string;
        title: string;
        htmlLen: number;
      };

  if (diag.missingSelector !== null) {
    return {
      kind: "drifted",
      missingSelector: diag.missingSelector,
      url: diag.url,
      title: diag.title,
      htmlLen: diag.htmlLen,
    };
  }

  return { kind: "ok" };
};

export const checkDeletionSafe = (
  source: string,
  existingCount: number,
  removedCount: number,
): DeletionGuardResult => {
  if (removedCount <= 0 || existingCount < MIN_ARCHIVE_FOR_GUARD) {
    return { kind: "safe" };
  }

  const ratio = removedCount / existingCount;
  if (ratio > MAX_DELETION_RATIO) {
    return {
      kind: "blocked",
      reason: `${source} crawl would delete ${removedCount}/${existingCount} items (${Math.round(ratio * 100)}%, max ${Math.round(MAX_DELETION_RATIO * 100)}%); aborting deletion to prevent archive loss from UI/API drift`,
    };
  }

  return { kind: "safe" };
};

export const assertDeletionSafe = (
  source: string,
  existingCount: number,
  removedCount: number,
): void => {
  const check = checkDeletionSafe(source, existingCount, removedCount);
  if (check.kind === "blocked") {
    throw new Error(check.reason);
  }
};

export const selectUnreferencedFiles = (
  removedFiles: Iterable<string | null | undefined>,
  keptFiles: Iterable<string | null | undefined>,
): string[] => {
  const kept = new Set<string>();
  for (const f of keptFiles) {
    if (f) kept.add(f);
  }
  const unreferenced = new Set<string>();
  for (const f of removedFiles) {
    if (f && !kept.has(f)) unreferenced.add(f);
  }
  return [...unreferenced];
};
