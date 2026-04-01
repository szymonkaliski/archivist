import type { PaginatedResponse } from "./types";

export const encodeId = (id: string): string => id;

export const fetchResults = async (
  query?: string,
  offset = 0,
  limit = 100,
): Promise<PaginatedResponse> => {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("offset", String(offset));
  params.set("limit", String(limit));

  const res = await fetch(`/api/search?${params}`);

  if (!res.ok) throw new Error(`search failed: ${res.status}`);

  return res.json();
};
