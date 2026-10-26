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

export interface ProviderQuotesResult {
  quotes: Quote[];
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
  const quotes: Quote[] = [];
  const failures: ProviderQuoteFailure[] = [];

  await Promise.all(
    sources.map(async (source) => {
      const cached = cache.get(source.bankId);
      if (cached && deps.nowMs() - cached.fetchedAtMs < deps.cacheTtlMs) {
        quotes.push(cached.quote);
        return;
      }

      try {
        const quote = await fetchBankQuote(source, benchmarkRate, {
          fetchPdf: deps.fetchPdf,
          extractText: deps.extractText,
          nowIso: deps.nowIso,
        });
        cache.set(source.bankId, { quote, fetchedAtMs: deps.nowMs() });
        quotes.push(quote);
      } catch (err) {
        failures.push({
          bankId: source.bankId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );

  return { quotes, failures };
}
