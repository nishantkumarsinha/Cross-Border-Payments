import type { CacheStore } from "./cacheStore";

export interface BenchmarkCacheEntry {
  rate: number;
  asOf: string;
  fetchedAtMs: number;
}

export type BenchmarkCache = CacheStore<BenchmarkCacheEntry>;

export interface BenchmarkRateResult {
  rate: number;
  asOf: string;
  stale: boolean;
}

export interface FetchLike {
  (url: string): Promise<{ ok: boolean; json: () => Promise<any> }>;
}

export type FeeModel = "flat" | "percentage" | "tiered" | "flat_plus_percentage";

export interface AmountTier {
  min: number;
  max: number | null;
}

export interface Quote {
  provider_id: string;
  corridor: { from_currency: string; to_currency: string };
  amount_tier: AmountTier;
  fee_model: FeeModel;
  flat_fee: number | null;
  percentage_fee_bps: number | null;
  fee_min: number | null;
  fee_max: number | null;
  fx_spread_bps: number;
  quoted_rate: number;
  eligibility: string | null;
  provenance: "official_api" | "manual_entry" | "official_document";
  fetched_at: string;
}

export interface CostResult {
  provider_id: string;
  excluded_reason: string | null;
  effective_rate: number | null;
  amount_received: number | null;
  total_cost_from_currency: number | null;
}
