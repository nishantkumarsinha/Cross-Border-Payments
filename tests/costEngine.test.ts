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
    expect(result.excluded_reason).toBe("minimum transfer: 1000.00 EUR");
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
    expect(result.excluded_reason).toBe("maximum transfer: 1000.00 EUR");
    expect(result.effective_rate).toBeNull();
  });

  it("does not exclude a quote when the amount exactly equals the maximum", () => {
    const quote = { ...baseQuote, amount_tier: { min: 1, max: 1000 } };
    const result = computeQuoteCost(quote, 90, 1000);
    expect(result.excluded_reason).toBeNull();
  });

  // Final review finding: real-world (non-round) amount_tier bounds, like
  // those Task 3's PDF worker derives from a bank's own rate, must still
  // show a properly rounded figure in the exclusion message (FR-8) — not
  // the raw unrounded float.
  it("rounds the minimum-transfer exclusion message to 2 decimal places (FR-8)", () => {
    const quote = { ...baseQuote, amount_tier: { min: 9496.676163342831, max: null } };
    const result = computeQuoteCost(quote, 90, 100);
    expect(result.excluded_reason).toBe("minimum transfer: 9496.68 EUR");
  });

  it("rounds the maximum-transfer exclusion message to 2 decimal places (FR-8)", () => {
    const quote = { ...baseQuote, amount_tier: { min: 1, max: 18993.35232668566 } };
    const result = computeQuoteCost(quote, 90, 20000);
    expect(result.excluded_reason).toBe("maximum transfer: 18993.35 EUR");
  });
});

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
