import type { BenchmarkCache, BenchmarkRateResult, FetchLike } from "./types";

export async function getBenchmarkRate(
  fromCurrency: string,
  toCurrency: string,
  cache: BenchmarkCache,
  deps: { fetchFn: FetchLike; nowMs: () => number; cacheTtlMs: number }
): Promise<BenchmarkRateResult> {
  const key = `${fromCurrency}:${toCurrency}`;
  const cached = cache.get(key);

  if (cached && deps.nowMs() - cached.fetchedAtMs < deps.cacheTtlMs) {
    return { rate: cached.rate, asOf: cached.asOf, stale: false };
  }

  try {
    const url = `https://api.frankfurter.dev/v1/latest?from=${fromCurrency}&to=${toCurrency}`;
    const response = await deps.fetchFn(url);
    if (!response.ok) {
      throw new Error(`benchmark rate fetch failed with non-ok response`);
    }
    const body = await response.json();
    const rate = body?.rates?.[toCurrency];
    if (typeof rate !== "number" || !Number.isFinite(rate)) {
      throw new Error(`benchmark rate response missing rate for ${toCurrency}`);
    }

    const fetchedAtMs = deps.nowMs();
    cache.set(key, { rate, asOf: body.date, fetchedAtMs });
    return { rate, asOf: body.date, stale: false };
  } catch (err) {
    if (cached) {
      return { rate: cached.rate, asOf: cached.asOf, stale: true };
    }
    throw err;
  }
}
