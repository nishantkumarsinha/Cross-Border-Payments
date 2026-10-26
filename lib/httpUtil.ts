// Shared timeout wrapper for every outbound fetch this app makes (benchmark
// rate, bank PDFs). Final review finding: neither had a timeout, so a slow
// or stalled upstream could hold a request open for minutes, breaking
// FR-7's provider isolation for a provider that hangs rather than fails
// outright.
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetchFn: FetchFn = fetch
): Promise<Response> {
  return fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
}
