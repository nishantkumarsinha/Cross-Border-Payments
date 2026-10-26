import { getAllProviderQuotes } from "../lib/providerQuotes";
import { HDFC_SOURCE, SBI_SOURCE } from "../lib/pdfRateWorker";
import type { PdfFetchLike, PdfTextExtractor } from "../lib/pdfRateWorker";
import type { QuoteCacheMap } from "../lib/providerQuotes";

const HDFC_FIXTURE_TEXT = `
Euro EUR 103.65 111.86 103.79 109.55 104.38 108.96 104.06 109.28 109.55
`;

const SBI_FIXTURE_TEXT = `
EURO EUR/INR 105.3 107.99 105.22 108.19 105.22 108.19 103.7 108.6
`;

const BENCHMARK_RATE = 106.864;

function makeDeps(overrides: Partial<Parameters<typeof getAllProviderQuotes>[2]> = {}) {
  return {
    fetchPdf: jest.fn<ReturnType<PdfFetchLike>, Parameters<PdfFetchLike>>(async () => new ArrayBuffer(0)),
    extractText: jest.fn<ReturnType<PdfTextExtractor>, Parameters<PdfTextExtractor>>(async () => {
      throw new Error("extractText stub not configured for this test");
    }),
    nowIso: () => "2026-10-26T12:00:00.000Z",
    nowMs: () => 0,
    cacheTtlMs: 600_000,
    ...overrides,
  };
}

describe("getAllProviderQuotes", () => {
  it("fetches both HDFC and SBI quotes successfully", async () => {
    const cache: QuoteCacheMap = new Map();
    // extractText has no way to know which bank it's extracting for from the
    // signature alone, so route by call order: HDFC is requested first.
    let callCount = 0;
    const deps = makeDeps({
      extractText: async () => {
        callCount++;
        return callCount === 1 ? HDFC_FIXTURE_TEXT : SBI_FIXTURE_TEXT;
      },
    });

    const result = await getAllProviderQuotes(BENCHMARK_RATE, cache, deps, [HDFC_SOURCE, SBI_SOURCE]);

    expect(result.failures).toEqual([]);
    expect(result.quotes).toHaveLength(2);
    expect(result.quotes.map((q) => q.provider_id).sort()).toEqual(["hdfc", "sbi"]);
  });

  it("isolates a failure to one provider — the other still succeeds (FR-7)", async () => {
    const cache: QuoteCacheMap = new Map();
    const deps = makeDeps({
      fetchPdf: async (url: string) => {
        if (url === HDFC_SOURCE.url) throw new Error("network down");
        return new ArrayBuffer(0);
      },
      extractText: async () => SBI_FIXTURE_TEXT,
    });

    const result = await getAllProviderQuotes(BENCHMARK_RATE, cache, deps, [HDFC_SOURCE, SBI_SOURCE]);

    expect(result.failures).toEqual([{ bankId: "hdfc", error: "network down" }]);
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0].provider_id).toBe("sbi");
  });

  it("serves a cache hit without calling fetchPdf again within the TTL", async () => {
    const cache: QuoteCacheMap = new Map();
    const fetchPdf = jest.fn(async () => new ArrayBuffer(0));
    const deps = makeDeps({
      fetchPdf,
      extractText: async () => HDFC_FIXTURE_TEXT,
      nowMs: () => 1000,
    });

    await getAllProviderQuotes(BENCHMARK_RATE, cache, deps, [HDFC_SOURCE]);
    await getAllProviderQuotes(BENCHMARK_RATE, cache, { ...deps, nowMs: () => 1000 + 60_000 }, [HDFC_SOURCE]);

    expect(fetchPdf).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the cache entry's TTL has expired", async () => {
    const cache: QuoteCacheMap = new Map();
    const fetchPdf = jest.fn(async () => new ArrayBuffer(0));
    const deps = makeDeps({
      fetchPdf,
      extractText: async () => HDFC_FIXTURE_TEXT,
      nowMs: () => 0,
      cacheTtlMs: 600_000,
    });

    await getAllProviderQuotes(BENCHMARK_RATE, cache, deps, [HDFC_SOURCE]);
    await getAllProviderQuotes(BENCHMARK_RATE, cache, { ...deps, nowMs: () => 600_000 }, [HDFC_SOURCE]);

    expect(fetchPdf).toHaveBeenCalledTimes(2);
  });
});
