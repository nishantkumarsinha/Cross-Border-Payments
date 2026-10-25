# Benchmark Rate Source & Cost Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two zero-dependency pieces the PRD's own build sequencing (§8, Day 0) calls out as safe to start first — the live benchmark FX rate source (§7.1) and the provider cost/ranking engine (§7.3) — as real, tested TypeScript modules.

**Architecture:** Two independent, pure-ish modules with no shared state and no I/O side effects beyond one injected fetch call. `benchmarkRate.ts` fetches/caches the EUR→INR mid-market rate with last-known-good fallback. `costEngine.ts` turns a provider's raw quote plus that benchmark rate into a ranked-comparable cost figure. Neither depends on the other, a database, or an HTTP server — matching the PRD's note that these are "fully standalone" / "pure function, testable with fixtures." Later phases (§7.2 adapters, §7.4 storage, §7.5's fetch-and-cache *layer* wiring this into real providers, §7.7 API, §7.8 frontend) build on top of these two modules but are out of scope here.

**Tech Stack:** TypeScript on Node.js (LTS), Vitest for tests, npm for package management. Not specified in the PRD — this is my call, made because the spike (`index.html`) was already plain JS/no-framework, and neither module needs a web framework or database yet.

**Spec:** `docs/prd-eur-inr-comparison.md` (v0.3) — primarily §2 (Goals), §5 FR-3/FR-4/FR-6/FR-7/FR-8/FR-9, §7 rows 7.1/7.3, §7.4a (quote schema), and §7's Critical Notes on 7.1's fetch/cache/fallback model.

## Global Constraints

- Corridor is EUR → INR only for this phase (§2) — no multi-currency logic yet, but field names (`from_currency`/`to_currency`) must not bake in EUR/INR literals, per §7's critical note that corridor support is a data-model decision, not a later rewrite.
- Cache freshness window is 5–10 minutes (FR-4, §7.5); this plan picks the concrete value **5 minutes (300000ms)** — my call, since the PRD gives a range, not a number.
- All monetary rounding is half-up to 2 decimal places, **display only** — ranking/comparison always uses full-precision values (FR-8).
- `fx_spread_bps` and `percentage_fee_bps` are basis points: divide by 10000 to get a fraction (7.4a).
- `eligibility` and `provenance` are display/filter-only fields and must never influence cost or ranking (7.4a, closing note).
- A quote below its own `amount_tier.min` is excluded with a visible reason, not silently dropped (FR-6).

## Review Focus

- **Amount exactly equal to a quote's stated minimum** — FR-6 says "below," so an amount equal to the minimum must NOT be excluded; an off-by-one boundary bug here would wrongly reject valid comparisons. Covered in Task 2.
- **Zero FX spread** — a provider with `fx_spread_bps: 0` must produce an effective rate exactly equal to the benchmark rate, not a value nudged by floating-point drift. Covered in Task 2.
- **Benchmark API response missing the expected rate key** — a malformed or shape-changed API response (e.g. no `rates.INR`) must be treated as a fetch failure (triggering fallback/error), not crash or silently return `undefined` as a rate. Covered in Task 1.
- **Cache TTL boundary** — a cache entry exactly at the TTL age must be treated as expired (`>=`), not fresh, so staleness is never understated by an off-by-one. Covered in Task 1.
- **Fee floor/cap clamping producing a fee of zero or below** — `fee_min`/`fee_max` must clamp the computed fee even when the raw flat+percentage sum is zero, so a provider that nominally charges "0.5% with a €5 minimum" at a tiny amount doesn't show as free. Covered in Task 2.

---

### Task 1: Benchmark Rate Source (§7.1)

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/types.ts`
- Create: `src/benchmarkRate.ts`
- Test: `tests/benchmarkRate.test.ts`

**Interfaces:**
- Consumes: nothing (no dependency on any other task)
- Produces (for Task 2 and later phases to use):
  ```ts
  // src/types.ts
  export interface BenchmarkCacheEntry { rate: number; asOf: string; fetchedAtMs: number; }
  export type BenchmarkCache = Map<string, BenchmarkCacheEntry>;
  export interface BenchmarkRateResult { rate: number; asOf: string; stale: boolean; }
  export interface FetchLike { (url: string): Promise<{ ok: boolean; json: () => Promise<any> }>; }

  // src/benchmarkRate.ts
  export function getBenchmarkRate(
    fromCurrency: string,
    toCurrency: string,
    cache: BenchmarkCache,
    deps: { fetchFn: FetchLike; nowMs: () => number; cacheTtlMs: number }
  ): Promise<BenchmarkRateResult>
  ```

- [ ] **Step 1: Scaffold the project**

Create `package.json` (name `cross-border-payments`, type `module`, devDependencies `typescript` and `vitest`, scripts `"test": "vitest run"`), `tsconfig.json` (target ES2022, module ESNext, strict true, outDir irrelevant since Vitest runs TS directly), and `vitest.config.ts` (default config, no plugins needed). Create `src/types.ts` with just the four interfaces listed above in Produces.

Run: `npm install`
Expected: installs without error, creates `node_modules` and `package-lock.json`.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/benchmarkRate.test.ts
import { describe, it, expect, vi } from "vitest";
import { getBenchmarkRate } from "../src/benchmarkRate";
import type { BenchmarkCache, FetchLike } from "../src/types";

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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/benchmarkRate.test.ts`
Expected: FAIL — `getBenchmarkRate` is not defined / module not found.

- [ ] **Step 4: Implement `getBenchmarkRate` in `src/benchmarkRate.ts`**

Build the URL as `https://api.frankfurter.dev/v1/latest?from=${fromCurrency}&to=${toCurrency}`. Cache key is `` `${fromCurrency}:${toCurrency}` ``. Fresh-hit check must use `>=` against `cacheTtlMs` (not `>`) so the TTL boundary counts as expired. On a successful response, read `rates[toCurrency]`; if it's not a finite number, treat the call as failed. On any failure (thrown error, `!ok`, or missing rate), return the cached entry with `stale: true` if one exists, otherwise throw.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/benchmarkRate.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src/types.ts src/benchmarkRate.ts tests/benchmarkRate.test.ts
git commit -m "feat: add benchmark rate source with cache and last-known-good fallback (PRD §7.1)"
```

---

### Task 2: Cost Engine (§7.3)

**Files:**
- Modify: `src/types.ts` (add `Quote`, `CostResult`)
- Create: `src/costEngine.ts`
- Test: `tests/costEngine.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime (takes a plain `benchmarkRate: number`, not a `BenchmarkRateResult` — callers in a later phase pass `benchmarkRateResult.rate`)
- Produces (for later phases — §7.7's API, §7.8's frontend):
  ```ts
  // src/types.ts additions
  export type FeeModel = "flat" | "percentage" | "tiered" | "flat_plus_percentage";
  export interface AmountTier { min: number; max: number | null; }
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
    provenance: "official_api" | "manual_entry";
    fetched_at: string;
  }
  export interface CostResult {
    provider_id: string;
    excluded_reason: string | null;
    effective_rate: number | null;
    amount_received: number | null;
    total_cost_from_currency: number | null;
  }

  // src/costEngine.ts
  export function computeQuoteCost(quote: Quote, benchmarkRate: number, amountFromCurrency: number): CostResult
  export function formatDisplayAmount(value: number): string
  ```

Implementation note (this plan's call, since 7.4a names four `fee_model` values but gives only one set of numeric fields per quote): `fee_model` is treated as a display/categorization label only, per 7.4a's own closing note ("`fee_model` fields are kept for display ... and for detecting when a provider's fee structure changes shape"). The fee math itself is always `(flat_fee ?? 0) + amountFromCurrency * ((percentage_fee_bps ?? 0) / 10000)`, clamped by `fee_min`/`fee_max` when set — the same formula regardless of which `fee_model` string is attached, since a "flat" quote simply has `percentage_fee_bps: null` and a "percentage" quote has `flat_fee: null`. A multi-tier provider is modeled as multiple `Quote` rows (one per `amount_tier`), with 7.2 (a later phase) responsible for selecting the row matching the requested amount — not something `computeQuoteCost` resolves.

Deviation from the spec's literal wording, flagged explicitly (another of this plan's calls): FR-6's own example text is `"minimum transfer: €X"` — a hardcoded `€` symbol. Step 3 below pins `` `minimum transfer: ${quote.amount_tier.min} ${quote.corridor.from_currency}` `` instead (e.g. `"minimum transfer: 1000 EUR"`), using the quote's own `from_currency` rather than a literal `€`. This keeps the message correct for a future non-EUR corridor without a rewrite, consistent with §7's critical note that corridor support must never be hardcoded — but it is a real departure from FR-6's exact display text, not a transcription of it, and the eventual frontend (§7.8, out of scope here) may want to re-introduce a symbol lookup for display polish.

- [ ] **Step 1: Write the failing tests for `computeQuoteCost`**

```ts
// tests/costEngine.test.ts
import { describe, it, expect } from "vitest";
import { computeQuoteCost, formatDisplayAmount } from "../src/costEngine";
import type { Quote } from "../src/types";

const baseQuote: Quote = {
  provider_id: "test-provider",
  corridor: { from_currency: "EUR", to_currency: "INR" },
  amount_tier: { min: 1, max: null },
  fee_model: "flat_plus_percentage",
  flat_fee: 2,
  percentage_fee_bps: 50, // 0.5%
  fee_min: null,
  fee_max: null,
  fx_spread_bps: 100, // 1%
  quoted_rate: 90,
  eligibility: null,
  provenance: "manual_entry",
  fetched_at: "2026-10-25T00:00:00Z",
};

describe("computeQuoteCost", () => {
  it("computes fee, effective rate, and amount received for a flat+percentage quote", () => {
    const result = computeQuoteCost(baseQuote, 90, 1000);
    expect(result.excluded_reason).toBeNull();
    expect(result.effective_rate).toBeCloseTo(89.1, 5);
    expect(result.amount_received).toBeCloseTo(88476.3, 5);
    expect(result.total_cost_from_currency).toBeCloseTo(16.93, 5);
  });

  it("excludes a quote when the amount is below the stated minimum", () => {
    const quote = { ...baseQuote, amount_tier: { min: 1000, max: null } };
    const result = computeQuoteCost(quote, 90, 999);
    expect(result.excluded_reason).toBe("minimum transfer: 1000 EUR");
    expect(result.effective_rate).toBeNull();
    expect(result.amount_received).toBeNull();
  });

  it("does not exclude a quote when the amount exactly equals the minimum", () => {
    const quote = { ...baseQuote, amount_tier: { min: 1000, max: null } };
    const result = computeQuoteCost(quote, 90, 1000);
    expect(result.excluded_reason).toBeNull();
  });

  it("yields an effective rate exactly equal to the benchmark when spread is zero", () => {
    const quote = { ...baseQuote, fx_spread_bps: 0 };
    const result = computeQuoteCost(quote, 90, 1000);
    expect(result.effective_rate).toBe(90);
  });

  it("clamps the fee up to fee_min even when the raw fee would be zero", () => {
    const quote = { ...baseQuote, flat_fee: 0, percentage_fee_bps: 0, fee_min: 5 };
    const result = computeQuoteCost(quote, 90, 1000);
    // netSend = 1000 - 5 = 995; effective_rate = 90 * 0.99 = 89.1
    expect(result.amount_received).toBeCloseTo(995 * 89.1, 5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/costEngine.test.ts`
Expected: FAIL — `computeQuoteCost` is not defined.

- [ ] **Step 3: Implement `computeQuoteCost` in `src/costEngine.ts`**

Order of operations: check `amountFromCurrency < quote.amount_tier.min` first (strictly less than) and return the excluded form immediately if so, with `excluded_reason` formatted exactly as `` `minimum transfer: ${quote.amount_tier.min} ${quote.corridor.from_currency}` ``. Otherwise compute `fee` per the Implementation Note above, clamp with `fee_min`/`fee_max`, then `netSend = amountFromCurrency - fee`, `effective_rate = benchmarkRate * (1 - quote.fx_spread_bps / 10000)`, `amount_received = netSend * effective_rate`, and `total_cost_from_currency = (amountFromCurrency * benchmarkRate - amount_received) / benchmarkRate`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/costEngine.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Write the failing tests for `formatDisplayAmount`**

```ts
describe("formatDisplayAmount", () => {
  it("formats a plain value to 2 decimal places", () => {
    expect(formatDisplayAmount(99595.5)).toBe("99595.50");
  });

  it("rounds a decimal literal's intended value half-up, correcting for its binary float representation", () => {
    // 1.005 as an IEEE-754 double is actually ~1.0049999999999998934 — strictly
    // less than 1.005. A rounding function that rounds that raw stored value
    // would return "1.00". This test pins the deliberate choice to round as if
    // the input were the exact decimal a human intended, which gives "1.01".
    expect(formatDisplayAmount(1.005)).toBe("1.01");
  });

  it("carries a half-up round across a digit boundary", () => {
    expect(formatDisplayAmount(99999.995)).toBe("100000.00");
  });
});
```

Scope note: `formatDisplayAmount` is only ever called on non-negative monetary amounts in this codebase (amount received, cost figures) — negative-input rounding convention is intentionally untested and unspecified.

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx vitest run tests/costEngine.test.ts`
Expected: FAIL — `formatDisplayAmount` is not defined.

- [ ] **Step 7: Implement `formatDisplayAmount` in `src/costEngine.ts`**

Plain `Math.round(value * 100) / 100` already passes the plain-value and digit-boundary tests (verified: `Math.round(99999.995 * 100) / 100 === 100000`), but fails the `1.005` test because rounding the raw stored float (≈1.00499999999999989) correctly yields `1.00`, not `1.01`. To round as if the input were the exact decimal intended, add a small correction before rounding: `Math.round((value + 1e-9) * 100) / 100`, then format with `.toFixed(2)`. `1e-9` is far smaller than the 0.005 rounding boundary (won't flip a genuinely non-boundary value) but large enough to correct typical float drift from upstream arithmetic.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/costEngine.test.ts`
Expected: PASS, all 8 tests in the file green.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/costEngine.ts tests/costEngine.test.ts
git commit -m "feat: add cost engine for quote ranking and display formatting (PRD §7.3, FR-6, FR-8)"
```
