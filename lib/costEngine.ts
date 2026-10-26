import type { CostResult, Quote } from "./types";

export function computeQuoteCost(
  quote: Quote,
  benchmarkRate: number,
  amountFromCurrency: number
): CostResult {
  const { provider_id, amount_tier, corridor } = quote;

  if (amountFromCurrency < amount_tier.min) {
    return {
      provider_id,
      excluded_reason: `minimum transfer: ${formatDisplayAmount(amount_tier.min)} ${corridor.from_currency}`,
      effective_rate: null,
      amount_received: null,
      total_cost_from_currency: null,
    };
  }

  if (amount_tier.max !== null && amountFromCurrency > amount_tier.max) {
    return {
      provider_id,
      excluded_reason: `maximum transfer: ${formatDisplayAmount(amount_tier.max)} ${corridor.from_currency}`,
      effective_rate: null,
      amount_received: null,
      total_cost_from_currency: null,
    };
  }

  let fee = (quote.flat_fee ?? 0) + amountFromCurrency * ((quote.percentage_fee_bps ?? 0) / 10000);
  if (quote.fee_min !== null) fee = Math.max(fee, quote.fee_min);
  if (quote.fee_max !== null) fee = Math.min(fee, quote.fee_max);

  const netSend = amountFromCurrency - fee;
  const effectiveRate = benchmarkRate * (1 - quote.fx_spread_bps / 10000);
  const amountReceived = netSend * effectiveRate;
  const totalCost = (amountFromCurrency * benchmarkRate - amountReceived) / benchmarkRate;

  return {
    provider_id,
    excluded_reason: null,
    effective_rate: effectiveRate,
    amount_received: amountReceived,
    total_cost_from_currency: totalCost,
  };
}

export function formatDisplayAmount(value: number): string {
  const rounded = Math.round((value + 1e-9) * 100) / 100;
  return rounded.toFixed(2);
}
