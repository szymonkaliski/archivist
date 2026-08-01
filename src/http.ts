// Every outbound request in this codebase goes through here so that none of
// them can outlive its deadline. The signal stays armed while the caller reads
// the body, so the deadline covers the response as a whole and not just the
// wait for headers.
//
// undici already caps the wait for headers and the gap between body chunks at
// 300s each, but those are per-phase: a response that keeps trickling resets
// the body timer and can run for hours. This is a total bound, and a much
// tighter one, which is what an hourly job wants.
export const fetchWithDeadline = (
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> => {
  // composed rather than assigned, so passing a signal cancels the request
  // without also silently dropping its deadline
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (init?.signal) signals.push(init.signal);

  return fetch(url, { ...init, signal: AbortSignal.any(signals) });
};

// undici collapses transport failures into a bare "fetch failed" TypeError and
// keeps the real reason on `cause`, so both halves are needed to tell a refused
// connection apart from a stalled one.
export const describeFetchError = (e: any, timeoutMs: number): string => {
  if (e?.name === "TimeoutError") {
    return `no response within ${timeoutMs / 1000}s`;
  }
  const message = e?.message ?? String(e);
  const detail = e?.cause?.message ?? e?.cause?.code;
  return detail ? `${message}: ${detail}` : message;
};
