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
