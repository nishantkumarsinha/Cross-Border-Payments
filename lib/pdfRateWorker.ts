import { PDFParse } from "pdf-parse";
import type { Quote } from "./types";
import { fetchWithTimeout } from "./httpUtil";

export interface PdfSource {
  bankId: string;
  url: string;
  inwardFeeInr: number;
  amountTierInr: { min: number; max: number | null };
  parse: (text: string) => number | null;
}

export interface PdfFetchLike {
  (url: string): Promise<ArrayBuffer>;
}

export interface PdfTextExtractor {
  (data: ArrayBuffer): Promise<string>;
}

function parseHdfcText(text: string): number | null {
  const match = text.match(/Euro\s+EUR\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  return match ? parseFloat(match[5]) : null;
}

function parseSbiText(text: string): number | null {
  const match = text.match(/EURO\s+EUR\/INR\s+([\d.]+)/i);
  return match ? parseFloat(match[1]) : null;
}

export const HDFC_SOURCE: PdfSource = {
  bankId: "hdfc",
  url: "https://www.hdfc.bank.in/content/dam/hdfcbankpws/in/en/personal-banking/discover-products/interest-rates/hdfc-bank-treasury-forex-card-rates.pdf",
  inwardFeeInr: 0,
  amountTierInr: { min: 0, max: 2_000_000 },
  parse: parseHdfcText,
};

export const SBI_SOURCE: PdfSource = {
  bankId: "sbi",
  url: "https://sbi.bank.in/documents/16012/1400784/FOREX_CARD_RATES.pdf",
  inwardFeeInr: 59,
  amountTierInr: { min: 1_000_000, max: 2_000_000 },
  parse: parseSbiText,
};

export const BANK_SOURCES: PdfSource[] = [HDFC_SOURCE, SBI_SOURCE];

export async function fetchBankQuote(
  source: PdfSource,
  benchmarkRate: number,
  deps: { fetchPdf: PdfFetchLike; extractText: PdfTextExtractor; nowIso: () => string }
): Promise<Quote> {
  const bytes = await deps.fetchPdf(source.url);
  const text = await deps.extractText(bytes);
  const ttBuyingRateInr = source.parse(text);

  if (ttBuyingRateInr === null || !Number.isFinite(ttBuyingRateInr) || ttBuyingRateInr <= 0) {
    throw new Error(`could not find a valid rate row for ${source.bankId}`);
  }

  const fxSpreadBps = ((benchmarkRate - ttBuyingRateInr) / benchmarkRate) * 10000;
  const flatFee = source.inwardFeeInr / ttBuyingRateInr;
  const amountTier = {
    min: source.amountTierInr.min / ttBuyingRateInr,
    max: source.amountTierInr.max !== null ? source.amountTierInr.max / ttBuyingRateInr : null,
  };

  return {
    provider_id: source.bankId,
    corridor: { from_currency: "EUR", to_currency: "INR" },
    amount_tier: amountTier,
    fee_model: "flat",
    flat_fee: flatFee,
    percentage_fee_bps: null,
    fee_min: null,
    fee_max: null,
    fx_spread_bps: fxSpreadBps,
    quoted_rate: ttBuyingRateInr,
    eligibility: null,
    provenance: "official_document",
    fetched_at: deps.nowIso(),
  };
}

const PDF_FETCH_TIMEOUT_MS = 8000;

export const httpFetchPdf: PdfFetchLike = async (url) => {
  const response = await fetchWithTimeout(url, PDF_FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`PDF fetch failed with status ${response.status}`);
  }
  return response.arrayBuffer();
};

export const extractPdfText: PdfTextExtractor = async (data) => {
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
};
