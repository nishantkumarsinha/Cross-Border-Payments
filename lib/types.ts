export interface BenchmarkCacheEntry {
  rate: number;
  asOf: string;
  fetchedAtMs: number;
}

export type BenchmarkCache = Map<string, BenchmarkCacheEntry>;

export interface BenchmarkRateResult {
  rate: number;
  asOf: string;
  stale: boolean;
}

export interface FetchLike {
  (url: string): Promise<{ ok: boolean; json: () => Promise<any> }>;
}
