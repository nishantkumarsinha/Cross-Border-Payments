import { openKvDb } from "../lib/sqliteKv";
import { createSqliteCacheStore } from "../lib/cacheStore";
import type { QuoteCacheEntry } from "../lib/providerQuotes";

describe("createSqliteCacheStore", () => {
  it("returns undefined for a key that was never set", () => {
    const store = createSqliteCacheStore<{ n: number }>(openKvDb(":memory:"), "test");
    expect(store.get("missing")).toBeUndefined();
  });

  it("round-trips a flat object", () => {
    const store = createSqliteCacheStore<{ n: number }>(openKvDb(":memory:"), "test");
    store.set("a", { n: 42 });
    expect(store.get("a")).toEqual({ n: 42 });
  });

  it("round-trips a real-shaped QuoteCacheEntry without corruption", () => {
    const store = createSqliteCacheStore<QuoteCacheEntry>(openKvDb(":memory:"), "quote");
    const entry: QuoteCacheEntry = {
      fetchedAtMs: 123,
      quote: {
        provider_id: "hdfc",
        corridor: { from_currency: "EUR", to_currency: "INR" },
        amount_tier: { min: 0, max: 19160.76 },
        fee_model: "flat",
        flat_fee: 0,
        percentage_fee_bps: null,
        fee_min: null,
        fee_max: null,
        fx_spread_bps: 232.445,
        quoted_rate: 104.38,
        eligibility: null,
        provenance: "official_document",
        fetched_at: "2026-10-25T12:00:00.000Z",
      },
    };
    store.set("hdfc", entry);
    expect(store.get("hdfc")).toEqual(entry);
  });

  it("two namespaced stores sharing one db do not collide on the same key", () => {
    const db = openKvDb(":memory:");
    const a = createSqliteCacheStore<{ n: number }>(db, "a");
    const b = createSqliteCacheStore<{ n: number }>(db, "b");
    a.set("x", { n: 1 });
    b.set("x", { n: 2 });
    expect(a.get("x")).toEqual({ n: 1 });
    expect(b.get("x")).toEqual({ n: 2 });
  });

  it("overwrites an existing key on a second set", () => {
    const store = createSqliteCacheStore<{ n: number }>(openKvDb(":memory:"), "test");
    store.set("a", { n: 1 });
    store.set("a", { n: 2 });
    expect(store.get("a")).toEqual({ n: 2 });
  });
});
