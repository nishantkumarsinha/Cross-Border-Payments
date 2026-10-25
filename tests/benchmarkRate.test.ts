import { describe, it, expect, vi } from "vitest";
import { getBenchmarkRate } from "../lib/benchmarkRate";
import type { BenchmarkCache, FetchLike } from "../lib/types";

const okResponse = (rate: number, date: string) => ({
  ok: true,
  json: async () => ({ amount: 1, base: "EUR", date, rates: { INR: rate } }),
});

describe("getBenchmarkRate", () => {
  it("returns a fresh cache hit without calling fetch", async () => {
    const cache: BenchmarkCache = new Map([
      ["EUR:INR", { rate: 106.864, asOf: "2026-10-16", fetchedAtMs: 1000 }],
    ]);
    const fetchFn = vi.fn<FetchLike>();
    const result = await getBenchmarkRate("EUR", "INR", cache, {
      fetchFn, nowMs: () => 1000 + 60_000, cacheTtlMs: 300_000,
    });
    expect(result).toEqual({ rate: 106.864, asOf: "2026-10-16", stale: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refetches and updates the cache when the entry is expired", async () => {
    const cache: BenchmarkCache = new Map([
      ["EUR:INR", { rate: 100, asOf: "2026-10-15", fetchedAtMs: 0 }],
    ]);
    const fetchFn = vi.fn<FetchLike>(async () => okResponse(107.5, "2026-10-16"));
    const result = await getBenchmarkRate("EUR", "INR", cache, {
      fetchFn, nowMs: () => 300_000, cacheTtlMs: 300_000,
    });
    expect(result).toEqual({ rate: 107.5, asOf: "2026-10-16", stale: false });
    expect(cache.get("EUR:INR")).toEqual({ rate: 107.5, asOf: "2026-10-16", fetchedAtMs: 300_000 });
  });

  it("treats the TTL boundary itself as expired, not fresh", async () => {
    const cache: BenchmarkCache = new Map([
      ["EUR:INR", { rate: 100, asOf: "2026-10-15", fetchedAtMs: 0 }],
    ]);
    const fetchFn = vi.fn<FetchLike>(async () => okResponse(107.5, "2026-10-16"));
    await getBenchmarkRate("EUR", "INR", cache, { fetchFn, nowMs: () => 300_000, cacheTtlMs: 300_000 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the last-known-good entry, marked stale, when the live fetch fails", async () => {
    const cache: BenchmarkCache = new Map([
      ["EUR:INR", { rate: 100, asOf: "2026-10-15", fetchedAtMs: 0 }],
    ]);
    const fetchFn = vi.fn<FetchLike>(async () => { throw new Error("network down"); });
    const result = await getBenchmarkRate("EUR", "INR", cache, {
      fetchFn, nowMs: () => 999_999_999, cacheTtlMs: 300_000,
    });
    expect(result).toEqual({ rate: 100, asOf: "2026-10-15", stale: true });
  });

  it("throws when the fetch fails and there is no cached entry to fall back to", async () => {
    const cache: BenchmarkCache = new Map();
    const fetchFn = vi.fn<FetchLike>(async () => ({ ok: false, json: async () => ({}) }));
    await expect(
      getBenchmarkRate("EUR", "INR", cache, { fetchFn, nowMs: () => 0, cacheTtlMs: 300_000 })
    ).rejects.toThrow();
  });

  it("treats a response missing the expected rate key as a failure", async () => {
    const cache: BenchmarkCache = new Map([
      ["EUR:INR", { rate: 100, asOf: "2026-10-15", fetchedAtMs: 0 }],
    ]);
    const fetchFn = vi.fn<FetchLike>(async () => ({ ok: true, json: async () => ({ rates: {} }) }));
    const result = await getBenchmarkRate("EUR", "INR", cache, {
      fetchFn, nowMs: () => 999_999_999, cacheTtlMs: 300_000,
    });
    expect(result.stale).toBe(true);
  });
});
