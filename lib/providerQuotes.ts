import { fetchBankQuote, HDFC_SOURCE, SBI_SOURCE } from "./pdfRateWorker";
import type { PdfFetchLike, PdfSource, PdfTextExtractor } from "./pdfRateWorker";
import type { Quote } from "./types";
import type { CacheStore } from "./cacheStore";

export interface QuoteCacheEntry {
  quote: Quote;
  fetchedAtMs: number;
}

export type QuoteCacheMap = CacheStore<QuoteCacheEntry>;

export interface ProviderQuoteFailure {
  bankId: string;
  error: string;
}

export interface ProviderQuoteResult {
  quote: Quote;
  stale: boolean;
}

export interface ProviderQuotesResult {
  quotes: ProviderQuoteResult[];
  failures: ProviderQuoteFailure[];
}

export async function getAllProviderQuotes(
  benchmarkRate: number,
  cache: QuoteCacheMap,
  deps: {
    fetchPdf: PdfFetchLike;
    extractText: PdfTextExtractor;
    nowIso: () => string;
    nowMs: () => number;
    cacheTtlMs: number;
  },
  sources: PdfSource[] = [HDFC_SOURCE, SBI_SOURCE]
): Promise<ProviderQuotesResult> {
  const quotes: ProviderQuoteResult[] = [];
  const failures: ProviderQuoteFailure[] = [];

  await Promise.all(
    sources.map(async (source) => {
      const cached = cache.get(source.bankId);
      if (cached && deps.nowMs() - cached.fetchedAtMs < deps.cacheTtlMs) {
        quotes.push({ quote: cached.quote, stale: false });
        return;
      }

      try {
        const quote = await fetchBankQuote(source, benchmarkRate, {
          fetchPdf: deps.fetchPdf,
          extractText: deps.extractText,
          nowIso: deps.nowIso,
        });
        cache.set(source.bankId, { quote, fetchedAtMs: deps.nowMs() });
        quotes.push({ quote, stale: false });
      } catch (err) {
        // FR-4 / PRD risk table: fall back to the last-known-good quote,
        // marked stale, rather than reporting a failure when a perfectly
        // usable (if old) cached quote exists — mirrors getBenchmarkRate's
        // existing fallback behavior.
        if (cached) {
          quotes.push({ quote: cached.quote, stale: true });
          return;
        }
        failures.push({
          bankId: source.bankId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );

  return { quotes, failures };
}
