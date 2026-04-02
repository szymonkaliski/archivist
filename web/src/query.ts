export interface ParsedQuery {
  text: string;
  sources: string[];
  tags: string[];
  before: string | null;
  after: string | null;
  detail: string | null;
}

export const parseQuery = (raw: string): ParsedQuery => {
  const result: ParsedQuery = {
    text: "",
    sources: [],
    tags: [],
    before: null,
    after: null,
    detail: null,
  };
  const textParts: string[] = [];

  for (const token of raw.split(/\s+/).filter(Boolean)) {
    const colonIdx = token.indexOf(":");
    if (colonIdx === -1) {
      textParts.push(token);
      continue;
    }
    const prefix = token.slice(0, colonIdx).toLowerCase();
    const value = token.slice(colonIdx + 1);
    if (!value) {
      textParts.push(token);
      continue;
    }
    switch (prefix) {
      case "source":
        result.sources.push(value.toLowerCase());
        break;
      case "tag":
        result.tags.push(value.toLowerCase());
        break;
      case "detail":
        result.detail = value;
        break;
      case "before":
        if (!isNaN(Date.parse(value))) result.before = value;
        else textParts.push(token);
        break;
      case "after":
        if (!isNaN(Date.parse(value))) result.after = value;
        else textParts.push(token);
        break;
      default:
        textParts.push(token);
    }
  }

  result.text = textParts.join(" ");
  return result;
};

export const buildQuery = (parsed: ParsedQuery): string => {
  const parts: string[] = [];
  for (const s of parsed.sources) parts.push(`source:${s}`);
  for (const t of parsed.tags) parts.push(`tag:${t}`);
  if (parsed.before) parts.push(`before:${parsed.before}`);
  if (parsed.after) parts.push(`after:${parsed.after}`);
  if (parsed.detail) parts.push(`detail:${parsed.detail}`);
  if (parsed.text) parts.push(parsed.text);
  return parts.join(" ");
};
