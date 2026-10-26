# Benchmark Rate Source & Cost Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two zero-dependency pieces the PRD's own build sequencing (§8, Day 0) calls out as safe to start first — the live benchmark FX rate source (§7.1) and the provider cost/ranking engine (§7.3) — plus a first real §7.2 provider adapter (a PDF-sourced rate worker for HDFC and SBI) that depends on Task 2's `Quote` type, as real, tested TypeScript modules.

**Architecture:** Three modules, two of them (Tasks 1 and 2) independent of each other with no shared state and no I/O beyond one injected fetch call; the third (Task 3) depends on Task 2's `Quote` type. `lib/benchmarkRate.ts` fetches/caches the EUR→INR mid-market rate with last-known-good fallback. `lib/costEngine.ts` turns a provider's raw quote plus that benchmark rate into a ranked-comparable cost figure. `lib/pdfRateWorker.ts` fetches each bank's own published forex-card-rate PDF, extracts the EUR TT-buying rate, and constructs a `Quote` — the first real instance of §7.2's "per-provider adapter." None of the three need a database, a framework, or an HTTP server. They live under `lib/` rather than `app/` because they have no routing or UI concerns of their own; later phases (the rest of §7.2's adapters, §7.4 storage, §7.5's fetch-and-cache *layer*, §7.7's `app/api/.../route.ts` handlers, §7.8's page UI, and whatever schedules Task 3 to actually run — a deployment decision, not part of this plan) build on top of these modules but are out of scope here.

**Tech Stack:** Next.js (TypeScript) for the whole product — frontend and backend in one app, one deploy target, decided over a separate Go backend specifically to avoid running two services/toolchains for an MVP the PRD itself frames as demand-validation (§10). Vitest for tests, npm for package management, plus one external dependency (`pdf-parse`, added in Task 3 — Tasks 1 and 2 use none). Tasks 1–3 need none of Next.js's routing or React machinery — they're plain TypeScript modules that a future API route will import — so this plan does not scaffold `create-next-app` itself; that belongs to the phase that actually adds routes/pages.

**Spec:** `docs/prd-eur-inr-comparison.md` (v0.3) — primarily §2 (Goals), §5 FR-3/FR-4/FR-6/FR-7/FR-8/FR-9, §7 rows 7.1/7.2/7.3, §7.4a (quote schema), §9 (Data Acquisition Strategy — Task 3 is the "official PDF" row in practice, closer in legitimacy to "Official API" than to "Scraping," since it's a publicly published document rather than an interactive calculator), and §7's Critical Notes on 7.1's fetch/cache/fallback model and on 7.2 depending on 7.3/7.4's schema being frozen first.

## Global Constraints

- Corridor is EUR → INR only for this phase (§2) — no multi-currency logic yet, but field names (`from_currency`/`to_currency`) must not bake in EUR/INR literals, per §7's critical note that corridor support is a data-model decision, not a later rewrite.
- Cache freshness window is 5–10 minutes (FR-4, §7.5); this plan picks the concrete value **5 minutes (300000ms)** — my call, since the PRD gives a range, not a number. Scoped to Task 1's on-demand fetch model only — Task 3's daily-cadence worker deliberately does not use this cache pattern at all (see its own Cadence note), so this constraint does not apply to it.
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
- **Amount above a quote's stated maximum** — FR-6 only specifies a minimum exclusion, but a real provider (HDFC, per Task 3's research) publishes an upper ceiling too ("applicable up to INR 20 lacs equivalent"). Extended into Task 2 below, symmetric with the minimum check: excluded only when strictly above `max`, not at it.
- **A bank's PDF row format changing or going missing** — Task 3's regex-based parsers have no fallback if a bank reformats its published rate sheet; `fetchBankQuote` must fail loudly (throw) rather than silently construct a `Quote` with a garbage or `NaN` rate. Covered in Task 3.

---

### Task 1: Benchmark Rate Source (§7.1)

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `lib/types.ts`
- Create: `lib/benchmarkRate.ts`
- Test: `tests/benchmarkRate.test.ts`

**Interfaces:**
- Consumes: nothing (no dependency on any other task)
- Produces (for Task 2 and later phases to use):
  ```ts
  // lib/types.ts
  export interface BenchmarkCacheEntry { rate: number; asOf: string; fetchedAtMs: number; }
  export type BenchmarkCache = Map<string, BenchmarkCacheEntry>;
  export interface BenchmarkRateResult { rate: number; asOf: string; stale: boolean; }
  export interface FetchLike { (url: string): Promise<{ ok: boolean; json: () => Promise<any> }>; }

  // lib/benchmarkRate.ts
  export function getBenchmarkRate(
    fromCurrency: string,
    toCurrency: string,
    cache: BenchmarkCache,
    deps: { fetchFn: FetchLike; nowMs: () => number; cacheTtlMs: number }
  ): Promise<BenchmarkRateResult>
  ```

- [ ] **Step 1: Scaffold the project**

Create `package.json` (name `cross-border-payments`, type `module`, devDependencies `typescript` and `vitest`, scripts `"test": "vitest run"` — no `next` dependency yet, since nothing here needs it), `tsconfig.json` (target ES2022, module ESNext, strict true), and `vitest.config.ts` (default config, no plugins needed). Create `lib/types.ts` with just the four interfaces listed above in Produces.

Run: `npm install`
Expected: installs without error, creates `node_modules` and `package-lock.json`.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/benchmarkRate.test.ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/benchmarkRate.test.ts`
Expected: FAIL — `getBenchmarkRate` is not defined / module not found.

- [ ] **Step 4: Implement `getBenchmarkRate` in `lib/benchmarkRate.ts`**

Build the URL as `https://api.frankfurter.dev/v1/latest?from=${fromCurrency}&to=${toCurrency}`. Cache key is `` `${fromCurrency}:${toCurrency}` ``. Fresh-hit check must use `>=` against `cacheTtlMs` (not `>`) so the TTL boundary counts as expired. On a successful response, read `rates[toCurrency]`; if it's not a finite number, treat the call as failed. On any failure (thrown error, `!ok`, or missing rate), return the cached entry with `stale: true` if one exists, otherwise throw.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/benchmarkRate.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts lib/types.ts lib/benchmarkRate.ts tests/benchmarkRate.test.ts
git commit -m "feat: add benchmark rate source with cache and last-known-good fallback (PRD §7.1)"
```

---

### Task 2: Cost Engine (§7.3)

**Files:**
- Modify: `lib/types.ts` (add `Quote`, `CostResult`)
- Create: `lib/costEngine.ts`
- Test: `tests/costEngine.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime (takes a plain `benchmarkRate: number`, not a `BenchmarkRateResult` — callers in a later phase pass `benchmarkRateResult.rate`)
- Produces (for later phases — §7.7's API route, §7.8's page UI):
  ```ts
  // lib/types.ts additions
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

  // lib/costEngine.ts
  export function computeQuoteCost(quote: Quote, benchmarkRate: number, amountFromCurrency: number): CostResult
  export function formatDisplayAmount(value: number): string
  ```

Implementation note (this plan's call, since 7.4a names four `fee_model` values but gives only one set of numeric fields per quote): `fee_model` is treated as a display/categorization label only, per 7.4a's own closing note ("`fee_model` fields are kept for display ... and for detecting when a provider's fee structure changes shape"). The fee math itself is always `(flat_fee ?? 0) + amountFromCurrency * ((percentage_fee_bps ?? 0) / 10000)`, clamped by `fee_min`/`fee_max` when set — the same formula regardless of which `fee_model` string is attached, since a "flat" quote simply has `percentage_fee_bps: null` and a "percentage" quote has `flat_fee: null`. A multi-tier provider is modeled as multiple `Quote` rows (one per `amount_tier`), with 7.2 (a later phase) responsible for selecting the row matching the requested amount — not something `computeQuoteCost` resolves.

`provenance: "official_document"` (added to the union above) is for Task 3's PDF-sourced quotes — neither a live API response nor a human-typed entry, but an automated extraction from a bank's own published document. It carries no special handling in `computeQuoteCost` itself; it's display/filter metadata only, same as the other two values.

Symmetric with the minimum check (FR-6): if `quote.amount_tier.max` is non-null and `amountFromCurrency > quote.amount_tier.max` (strictly greater than — an amount exactly at the maximum is still allowed), return the excluded form with `excluded_reason` set to `` `maximum transfer: ${quote.amount_tier.max} ${quote.corridor.from_currency}` ``. This check runs after the minimum check (an amount can't trigger both).

Deviation from the spec's literal wording, flagged explicitly (another of this plan's calls): FR-6's own example text is `"minimum transfer: €X"` — a hardcoded `€` symbol. Step 3 below pins `` `minimum transfer: ${quote.amount_tier.min} ${quote.corridor.from_currency}` `` instead (e.g. `"minimum transfer: 1000 EUR"`), using the quote's own `from_currency` rather than a literal `€`. This keeps the message correct for a future non-EUR corridor without a rewrite, consistent with §7's critical note that corridor support must never be hardcoded — but it is a real departure from FR-6's exact display text, not a transcription of it, and the eventual page UI (§7.8, out of scope here) may want to re-introduce a symbol lookup for display polish.

- [ ] **Step 1: Write the failing tests for `computeQuoteCost`**

```ts
// tests/costEngine.test.ts
import { describe, it, expect } from "vitest";
import { computeQuoteCost, formatDisplayAmount } from "../lib/costEngine";
import type { Quote } from "../lib/types";

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

  it("excludes a quote when the amount exceeds the stated maximum", () => {
    const quote = { ...baseQuote, amount_tier: { min: 1, max: 1000 } };
    const result = computeQuoteCost(quote, 90, 1001);
    expect(result.excluded_reason).toBe("maximum transfer: 1000 EUR");
    expect(result.effective_rate).toBeNull();
  });

  it("does not exclude a quote when the amount exactly equals the maximum", () => {
    const quote = { ...baseQuote, amount_tier: { min: 1, max: 1000 } };
    const result = computeQuoteCost(quote, 90, 1000);
    expect(result.excluded_reason).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/costEngine.test.ts`
Expected: FAIL — `computeQuoteCost` is not defined.

- [ ] **Step 3: Implement `computeQuoteCost` in `lib/costEngine.ts`**

Order of operations: check `amountFromCurrency < quote.amount_tier.min` first (strictly less than) and return the excluded form immediately if so, with `excluded_reason` formatted exactly as `` `minimum transfer: ${quote.amount_tier.min} ${quote.corridor.from_currency}` ``. Then, if `quote.amount_tier.max !== null && amountFromCurrency > quote.amount_tier.max` (strictly greater than), return the excluded form with `` `maximum transfer: ${quote.amount_tier.max} ${quote.corridor.from_currency}` ``. Otherwise compute `fee` per the Implementation Note above, clamp with `fee_min`/`fee_max`, then `netSend = amountFromCurrency - fee`, `effectiveRate = benchmarkRate * (1 - quote.fx_spread_bps / 10000)`, `amount_received = netSend * effectiveRate`, and `total_cost_from_currency = (amountFromCurrency * benchmarkRate - amount_received) / benchmarkRate`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/costEngine.test.ts`
Expected: PASS, all 7 tests green.

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

- [ ] **Step 7: Implement `formatDisplayAmount` in `lib/costEngine.ts`**

Plain `Math.round(value * 100) / 100` already passes the plain-value and digit-boundary tests (verified: `Math.round(99999.995 * 100) / 100 === 100000`), but fails the `1.005` test because rounding the raw stored float (≈1.00499999999999989) correctly yields `1.00`, not `1.01`. To round as if the input were the exact decimal intended, add a small correction before rounding: `Math.round((value + 1e-9) * 100) / 100`, then format with `.toFixed(2)`. `1e-9` is far smaller than the 0.005 rounding boundary (won't flip a genuinely non-boundary value) but large enough to correct typical float drift from upstream arithmetic.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/costEngine.test.ts`
Expected: PASS, all 10 tests in the file green (7 in `computeQuoteCost`, 3 in `formatDisplayAmount`).

- [ ] **Step 9: Commit**

```bash
git add lib/types.ts lib/costEngine.ts tests/costEngine.test.ts
git commit -m "feat: add cost engine for quote ranking and display formatting (PRD §7.3, FR-6, FR-8)"
```

---

### Task 3: Bank PDF Rate Worker (§7.2, official-document acquisition)

**Why this is Task 3, not parallel with Task 1/2:** per §7's critical note, "7.2's independence is conditional ... every one depends on the 7.3/7.4 schema being frozen first." This task produces `Quote` values (Task 2's type) from two banks' own published forex-card-rate PDFs — it cannot be built before that type exists.

**Scope, stated plainly:** only HDFC and SBI. Those are the only two banks where earlier research found a stable, predictable PDF URL. ICICI only had a live HTML rate page (not a PDF); IDFC First, Yes Bank, Commerzbank, and ING had no discoverable stable source at all. Adding more banks later means adding more `PdfSource` entries and bank-specific parsers, not changing this task's design.

**Cadence, stated plainly:** this task builds the fetch-parse-construct logic as a pure, callable function — not a scheduled job. *When* it runs (a cron-triggered Next.js route, a standalone script, Vercel Cron) is a deployment decision deferred to whichever phase actually sets up hosting; forcing that decision now would be scope creep. The only architectural fact pinned here is that it should NOT run on every user query like §7.1 — a bank's PDF changes at most once per business day, so re-parsing it per-request would be wasteful and fragile.

**Files:**
- Create: `lib/pdfRateWorker.ts`
- Test: `tests/pdfRateWorker.test.ts`
- Modify: `package.json` (add `pdf-parse` as a dependency — the only external dependency introduced by this plan; Tasks 1 and 2 used none)

**Interfaces:**
- Consumes: `Quote` (the type) from Task 2's `lib/types.ts` — `fetchBankQuote` itself does not call `computeQuoteCost`; that import appears only in this task's test file, for one integration assertion proving Task 2's existing exclusion logic handles a real bank's real threshold without modification.
- Produces (for §7.4's storage and §7.7's API, once they exist):
  ```ts
  // lib/pdfRateWorker.ts
  export interface PdfSource {
    bankId: string;
    url: string;
    inwardFeeInr: number;
    amountTierInr: { min: number; max: number | null };
    parse: (text: string) => number | null; // extracted EUR TT-buying rate in INR, or null if not found
  }

  export const HDFC_SOURCE: PdfSource;
  export const SBI_SOURCE: PdfSource;
  export const BANK_SOURCES: PdfSource[]; // [HDFC_SOURCE, SBI_SOURCE]

  export interface PdfFetchLike { (url: string): Promise<ArrayBuffer>; }
  export interface PdfTextExtractor { (data: ArrayBuffer): Promise<string>; }

  export async function fetchBankQuote(
    source: PdfSource,
    benchmarkRate: number,
    deps: { fetchPdf: PdfFetchLike; extractText: PdfTextExtractor; nowIso: () => string }
  ): Promise<Quote>

  // Production implementations, not exercised by these tests directly —
  // later phases wire these in as the real `deps`.
  export const httpFetchPdf: PdfFetchLike;
  export const extractPdfText: PdfTextExtractor; // wraps the `pdf-parse` package
  ```

**Unit-conversion notes (this plan's calls, pin these exactly — corrected from an earlier draft that divided by `benchmarkRate`; see the note below on why that was wrong):**
- `fx_spread_bps = (benchmarkRate - ttBuyingRateInr) / benchmarkRate * 10000`. Do not hardcode a previously-computed value (e.g. an old manual estimate of "233bps" for HDFC) — compute it live from whatever rate was actually parsed, since that's the entire point of automating this. By construction, `effectiveRate` as `computeQuoteCost` later reconstructs it (`benchmarkRate * (1 - fx_spread_bps / 10000)`) comes back out to exactly `ttBuyingRateInr` — useful to know for the next two conversions.
- HDFC's and SBI's own published inward handling fees are denominated in INR (the *to*-currency), deducted *after* conversion in reality — but Task 2's `computeQuoteCost` deducts `flat_fee` from the EUR amount *before* multiplying by `effectiveRate`: `amount_received = (amountFromCurrency - flat_fee) * effectiveRate`. For this to equal the true post-conversion deduction (`amountFromCurrency * effectiveRate - inwardFeeInr`), algebra requires `flat_fee * effectiveRate = inwardFeeInr`, i.e. `flat_fee = inwardFeeInr / effectiveRate` — and since `effectiveRate` reconstructs to `ttBuyingRateInr` (previous bullet), that's the same as `flat_fee = inwardFeeInr / ttBuyingRateInr`. **Divide by the bank's own parsed rate, not by `benchmarkRate`** — those differ by exactly the spread, and using `benchmarkRate` here was an earlier mistake in this plan that silently introduced a real (not rounding-level) error: for SBI's €1000/₹59 case it overstated the amount received by about ₹0.86, because it used the wrong rate in the division.
- Likewise, `source.amountTierInr.min`/`.max` are stated in INR (SBI's own document: "for transactions of value less than Rs. 10 lakhs, please contact the nearest branch," applicable range ₹10–20 lakh) describing the actual INR amount a transaction converts to — which is governed by the bank's own rate, not the benchmark. Divide both by `ttBuyingRateInr` (the same rate just parsed), not `benchmarkRate`, before constructing the `Quote`. Caught by a sanity check worth re-running after implementing: HDFC's and SBI's shared ₹20-lakh ceiling must NOT convert to the same EUR figure for both banks (they use different rates) — if it does, the wrong rate is being used in this division.
- The per-bank `inwardFeeInr` and `amountTierInr` values themselves (₹0 and ₹0–20L for HDFC; ₹59 and ₹10–20L for SBI) are hardcoded constants in each `PdfSource`, not parsed from the PDF text. Only the EUR TT-buying rate is parsed live — the fee and threshold are slow-changing policy facts, and parsing free-form regulatory-note text robustly is far more fragile than parsing one numeric table row. Revisit only if these figures are observed to actually change.

- [ ] **Step 1: Add the `pdf-parse` dependency**

Run: `npm install pdf-parse`
Expected: adds it to `package.json` dependencies (not devDependencies — it's used in the production `extractPdfText`, not just tests).

- [ ] **Step 2: Write the failing tests**

```ts
// tests/pdfRateWorker.test.ts
import { describe, it, expect } from "vitest";
import { fetchBankQuote, HDFC_SOURCE, SBI_SOURCE } from "../lib/pdfRateWorker";
import { computeQuoteCost } from "../lib/costEngine";

// Real extracted text shapes from each bank's own published PDF (abbreviated
// to the rows needed, but copied verbatim from an actual extraction — not
// synthesized) — HDFC dated 16/10/2026, SBI dated 17-10-2026.
const HDFC_FIXTURE_TEXT = `
 Classification - Internal #
DATE: 16/10/2026 TIME: 12:22:26 PM
U.A.E. Dirham AED 24.11 28.16 24.91 26.80 25.05 26.66 24.95 26.76 -
Euro EUR 103.65 111.86 103.79 109.55 104.38 108.96 104.06 109.28 109.55
Great Britain Pound GBP 122.54 131.07 122.23 130.58 122.92 129.88 122.54 130.26 130.58
`;

const SBI_FIXTURE_TEXT = `
Date 17-10-2026
Time 9:37 AM
TT BUY TT SELL BILL BUY BILL SELL FOREX TRAVEL CARD BUY FOREX TRAVEL CARD SELL CN BUY CN SELL
UNITED STATES DOLLAR USD/INR 94.45 95.3 94.38 95.47 94.38 95.47 93.25 95.8
EURO EUR/INR 105.3 107.99 105.22 108.19 105.22 108.19 103.7 108.6
GREAT BRITAIN POUND GBP/INR 125.02 127.88 124.93 128.11 124.93 128.11 123.15 129.15
CARD RATES FOR TRANSACTIONS BETWEEN Rs. 10 LAKHS AND Rs. 20 LAKHS. (To be used as reference rates)
1. For transactions of value less than Rs. 10 lakhs, please contact the nearest branch of SBI.
`;

const BENCHMARK_RATE = 106.864; // the real interbank EUR/INR rate on 2026-10-16, used throughout

const stubDeps = (text: string) => ({
  fetchPdf: async () => new ArrayBuffer(0),
  extractText: async () => text,
  nowIso: () => "2026-10-25T12:00:00.000Z",
});

describe("fetchBankQuote", () => {
  it("builds a correct Quote from HDFC's real PDF text shape", async () => {
    const quote = await fetchBankQuote(HDFC_SOURCE, BENCHMARK_RATE, stubDeps(HDFC_FIXTURE_TEXT));
    expect(quote.provider_id).toBe("hdfc");
    expect(quote.quoted_rate).toBe(104.38);
    expect(quote.fx_spread_bps).toBeCloseTo(232.445, 2);
    expect(quote.flat_fee).toBe(0);
    expect(quote.amount_tier.min).toBe(0);
    expect(quote.amount_tier.max).toBeCloseTo(19160.76, 1); // 2,000,000 / 104.38 (HDFC's own rate)
    expect(quote.provenance).toBe("official_document");
  });

  it("builds a correct Quote from SBI's real PDF text shape", async () => {
    const quote = await fetchBankQuote(SBI_SOURCE, BENCHMARK_RATE, stubDeps(SBI_FIXTURE_TEXT));
    expect(quote.quoted_rate).toBe(105.3);
    expect(quote.fx_spread_bps).toBeCloseTo(146.354, 2);
    expect(quote.flat_fee).toBeCloseTo(0.5603, 3);           // 59 / 105.30 (SBI's own rate, not benchmarkRate)
    expect(quote.amount_tier.min).toBeCloseTo(9496.68, 1);   // 1,000,000 / 105.30
    expect(quote.amount_tier.max).toBeCloseTo(18993.35, 1);  // 2,000,000 / 105.30 — deliberately NOT equal to HDFC's max above
  });

  it("throws when the expected currency row is not found in the extracted text", async () => {
    await expect(
      fetchBankQuote(HDFC_SOURCE, BENCHMARK_RATE, stubDeps("some unrelated PDF content"))
    ).rejects.toThrow();
  });
});

describe("fetchBankQuote integrated with Task 2's computeQuoteCost", () => {
  it("SBI's real stated minimum correctly excludes the standard €1000 comparison amount", async () => {
    const quote = await fetchBankQuote(SBI_SOURCE, BENCHMARK_RATE, stubDeps(SBI_FIXTURE_TEXT));
    const result = computeQuoteCost(quote, BENCHMARK_RATE, 1000);
    expect(result.excluded_reason).toMatch(/^minimum transfer:/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/pdfRateWorker.test.ts`
Expected: FAIL — `fetchBankQuote`/`HDFC_SOURCE`/`SBI_SOURCE` not defined.

- [ ] **Step 4: Implement `lib/pdfRateWorker.ts`**

Define `parseHdfcText` using `/Euro\s+EUR\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i` and return `match ? parseFloat(match[5]) : null` — the 5th captured number is the "T.T. Buying (Inw Rem)" column (verified against the real column order: Cash Buy, Cash Sell, Bills Buy, Bills Sell, **TT Buy**, TT Sell, Card Buy, Card Sell, DD). Define `parseSbiText` using `/EURO\s+EUR\/INR\s+([\d.]+)/i` and return `match ? parseFloat(match[1]) : null` — SBI's column order puts TT Buy first. Build `HDFC_SOURCE` and `SBI_SOURCE` from the `PdfSource` shape in Interfaces, using the exact constants from the Unit-conversion notes (HDFC: `inwardFeeInr: 0`, `amountTierInr: { min: 0, max: 2_000_000 }`; SBI: `inwardFeeInr: 59`, `amountTierInr: { min: 1_000_000, max: 2_000_000 }`).

`fetchBankQuote` calls `deps.fetchPdf(source.url)`, pipes the result through `deps.extractText`, calls `source.parse(text)`, and throws (e.g. `new Error(`could not find a rate row for ${source.bankId}`)`) if that returns `null`. On a successful parse (call the result `ttBuyingRateInr`), compute `fx_spread_bps` from it and `benchmarkRate` per the first Unit-conversion note, then divide `source.inwardFeeInr` and both `source.amountTierInr` bounds by `ttBuyingRateInr` — **not `benchmarkRate`** — per the corrected notes above, to get `flat_fee` and `amount_tier`. Construct the `Quote` with `corridor: { from_currency: "EUR", to_currency: "INR" }`, `fee_model: "flat"`, `percentage_fee_bps: null`, `fee_min: null`, `fee_max: null`, `eligibility: null`, `fetched_at: deps.nowIso()`.

`httpFetchPdf` and `extractPdfText` (production implementations, not exercised by Step 2's tests): `httpFetchPdf` calls the global `fetch`, checks `.ok`, and returns `.arrayBuffer()`. `extractPdfText` calls `pdf-parse`'s default export on a `Buffer` built from the `ArrayBuffer` and returns `.text`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/pdfRateWorker.test.ts -v`
Expected: PASS, all 4 tests green.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/pdfRateWorker.ts tests/pdfRateWorker.test.ts
git commit -m "feat: add HDFC/SBI PDF rate worker producing Task 2 Quotes (PRD §7.2, official-document provenance)"
```
