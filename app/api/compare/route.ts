import { getBenchmarkRate } from "@/lib/benchmarkRate";
import { getAllProviderQuotes } from "@/lib/providerQuotes";
import type { QuoteCacheMap } from "@/lib/providerQuotes";
import { httpFetchPdf, extractPdfText } from "@/lib/pdfRateWorker";
import { computeQuoteCost, formatDisplayAmount } from "@/lib/costEngine";
import type { BenchmarkCache } from "@/lib/types";

// Module-level singletons: persist across requests within the same server
// process (not per-request), same pattern Task 1/3's own cache design
// assumed a long-lived caller would provide.
const benchmarkCache: BenchmarkCache = new Map();
const quoteCache: QuoteCacheMap = new Map();

const BENCHMARK_CACHE_TTL_MS = 5 * 60 * 1000; // matches the plan's Task 1 constant
const QUOTE_CACHE_TTL_MS = 10 * 60 * 1000; // PDFs change at most daily; 10 min just avoids hammering on every request

export async function GET(request: Request) {
  const url = new URL(request.url);
  const amountParam = url.searchParams.get("amount");
  const amount = amountParam !== null ? parseFloat(amountParam) : 1000;

  if (!Number.isFinite(amount) || amount <= 0) {
    return Response.json({ error: "amount must be a positive number" }, { status: 400 });
  }

  let benchmark;
  try {
    benchmark = await getBenchmarkRate("EUR", "INR", benchmarkCache, {
      fetchFn: fetch,
      nowMs: () => Date.now(),
      cacheTtlMs: BENCHMARK_CACHE_TTL_MS,
    });
  } catch {
    return Response.json({ error: "benchmark rate unavailable" }, { status: 503 });
  }

  const { quotes, failures } = await getAllProviderQuotes(benchmark.rate, quoteCache, {
    fetchPdf: httpFetchPdf,
    extractText: extractPdfText,
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now(),
    cacheTtlMs: QUOTE_CACHE_TTL_MS,
  });

  const costed = quotes.map((quote) => ({ quote, cost: computeQuoteCost(quote, benchmark.rate, amount) }));
  costed.sort((a, b) => (b.cost.amount_received ?? -Infinity) - (a.cost.amount_received ?? -Infinity));

  const results = costed.map(({ quote, cost }) => ({
    provider_id: quote.provider_id,
    provenance: quote.provenance,
    excluded_reason: cost.excluded_reason,
    amount_received: cost.amount_received !== null ? formatDisplayAmount(cost.amount_received) : null,
    effective_rate: cost.effective_rate,
  }));

  return Response.json({
    benchmark: { rate: benchmark.rate, asOf: benchmark.asOf, stale: benchmark.stale },
    amount,
    results,
    failures,
  });
}
