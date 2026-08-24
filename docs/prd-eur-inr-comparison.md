# EUR → INR Rate Comparison — Product Requirements

**Status:** Draft v0.2
**Date:** 2026-08-24
**Owner:** Puneet Bharti

## 1. Overview

Consumers and businesses converting EUR to INR (and eventually other currency pairs) rely on banks and remittance apps — Wise, Revolut, Remitly, Western Union, traditional banks — but have no single place to see live, comparable pricing across them. Each provider's real cost is hidden behind a spread on the mid-market rate plus fee structures that are hard to compare directly. This product aggregates provider quotes and ranks them by true cost for a given transfer amount.

Comparable products already exist (Monito, CompareRemit, MoneyTransferComparison) and monetize via affiliate/referral commissions from providers rather than subscriptions — worth studying before building.

## 2. Goals (MVP)

- Single corridor: EUR → INR
- 4–5 providers: at least 2 via official API, remainder manual/curated entry
- Single primary flow: user enters an amount → sees providers ranked by total cost / INR received
- Rate refresh cadence: hourly
- No user accounts or auth required for v1

## 3. Non-Goals (v1)

- Multi-currency / multi-corridor support (architecture must not preclude it — see §7)
- Executing transfers (this is a comparison tool, not a payments platform)
- User accounts, saved searches, rate alerts
- Scraper-based acquisition at scale (see §9 — legal gate first)

## 4. Target Users

- Individuals sending money EUR → INR (remittances, family support, freelance payments received)
- Small businesses/freelancers invoicing in EUR and settling in INR
- Secondary: users comparing before committing to a provider they already use, for peace of mind

## 5. Functional Requirements

| ID | Requirement |
|----|-------------|
| FR-1 | User can input a EUR amount and see a ranked list of providers by total INR received / total cost |
| FR-2 | Each result shows: provider name, effective exchange rate, fee (flat + %), total cost in EUR, total INR received |
| FR-3 | Results are benchmarked against a displayed mid-market reference rate so users see the markup, not just the raw rate |
| FR-4 | Each quote displays a "last updated" timestamp; stale data (beyond refresh SLA) is flagged or excluded |
| FR-5 | Provider listings that are affiliate-linked are disclosed as such |
| FR-6 | If the entered amount is below a provider's stated minimum, that provider is excluded from results with a visible reason ("minimum transfer: €X"), not silently dropped |
| FR-7 | If a provider's quote fetch fails or errors (distinct from staleness in FR-4), it is shown as "temporarily unavailable" rather than omitted without explanation |
| FR-8 | All displayed monetary figures are rounded to 2 decimal places using half-up rounding for display only; ranking and cost comparisons are computed on full-precision values internally so display rounding never changes the ranked order |

## 6. Competitive Landscape

Monito, CompareRemit, MoneyTransferComparison — validate UX patterns and confirm affiliate-commission monetization model before committing engineering spend.

## 7. System Component Breakdown (MECE)

Decomposed by function, not by currency/provider — currency/corridor support is a data-model constraint threaded through §7.3/§7.4, not a standalone module (see Critical Notes).

| # | Component | Responsibility | Depends on |
|---|-----------|-----------------|------------|
| 7.1 | Benchmark rate source | Fetches independent mid-market EUR/INR rate | Nothing — fully standalone |
| 7.2 | Provider quote acquisition | Per-provider adapter fetching rate + fee for a given amount (API / scrape / manual) | Frozen schema from 7.3/7.4 |
| 7.3 | Normalization / cost engine | Converts each provider's raw quote into one comparable total-cost figure | Nothing — pure function, testable with fixtures |
| 7.4 | Storage & schema | Persists providers, corridors, quotes, timestamps, history | Schema decisions from 7.3 |
| 7.5 | Orchestration / scheduling | Runs fetchers on a cadence, retries, detects staleness | Generic infra, no knowledge of provider internals |
| 7.6 | Data QA / anomaly monitoring | Flags null, stale, or implausible fetched rates | 7.2's output shape |
| 7.7 | Comparison query API | Given amount + corridor, returns ranked provider list | Reads 7.4, calls 7.3 |
| 7.8 | Frontend / UI | Input form, ranked results, disclosures | 7.7's API contract |
| 7.9 | Monetization / affiliate ops | Referral program sign-up, tracked links, attribution | Nothing technical — business workstream, long external lead time |
| 7.10 | Legal / compliance review | ToS check per provider before choosing acquisition method | Nothing — gates 7.2 |

### 7.4a Fee-structure schema (resolves §10 risk: "fee structures don't normalize cleanly")

Each stored quote must capture enough structure to reproduce the provider's actual cost at any amount, not just the effective rate at fetch time:

```
quote {
  provider_id
  corridor: { from_currency, to_currency }
  amount_tier: { min, max }        // fee/rate can vary by bracket
  fee_model: "flat" | "percentage" | "tiered" | "flat_plus_percentage"
  flat_fee                          // fixed currency amount, or null
  percentage_fee_bps                // basis points on send amount, or null
  fee_min                           // floor after % calc, or null
  fee_max                           // cap after % calc, or null
  fx_spread_bps                     // markup vs. benchmark rate (7.1), separate from fee
  quoted_rate                       // raw rate as returned by provider
  effective_rate                    // computed: what the user actually gets, after fee_model + fx_spread
  fetched_at
}
```

`effective_rate` is what 7.3's cost engine ranks on; `fee_model` fields are kept for display (FR-2) and for detecting when a provider's fee structure changes shape and needs re-mapping.

### Critical notes on independence

- **Corridor/multi-currency support is not a module.** It's a data-model decision (`quote` keyed on `(provider, corridor, amount_tier)`) that must be baked into 7.3/7.4 from day one, or EUR-INR-only assumptions leak in and force a rewrite when USD-INR is added.
- **7.2's independence is conditional.** Individual provider adapters don't depend on each other, but every one depends on the 7.3/7.4 schema being frozen first. Sequence: freeze schema → fan out adapters in parallel, not the reverse.
- **7.10 gates 7.2, not the other way around.** If legal rules out scraping a given provider, that provider moves to manual entry or is dropped — this changes the freshness SLA promised in 7.8 and must be resolved before per-provider engineering time is spent.
- **7.9 has the longest external lead time in the plan.** Affiliate approval can take weeks and may be rejected pre-launch with no traffic. If revenue depends on it, start applications on day one, not after the product works.
- **7.1 is the only unconditionally independent piece** — no shared contract, no upstream decision. Correct place to start for a zero-risk first PR. Recommendation: poll a rate-aggregator API (e.g. Open Exchange Rates or Fixer.io) every 15 minutes as the live benchmark; cross-check daily against ECB reference rates as an audit/dispute-resolution source (ECB publishes once daily, so it's not suitable as the live benchmark itself). The benchmark's own refresh cadence must stay faster than the hourly provider-quote SLA in FR-4 — otherwise FR-3's "markup vs. benchmark" comparison is measuring providers against a reference that's nearly as stale as they are.
- **7.10 needs a decision rubric and an owner, not just a gate.** Owner: Puneet Bharti until dedicated legal counsel is engaged. Rubric for a given provider/method: (1) ToS explicitly permits automated/programmatic access to published rates → clear for scraping; (2) ToS is silent and robots.txt doesn't disallow the rate-calculator path → proceed with caution, revisit if provider objects; (3) ToS explicitly prohibits scraping/automated access → provider moves to manual entry or is dropped, does not get an exception. Document the outcome per provider so 7.2 adapters have an unambiguous green/red light before engineering starts.

## 8. Build Sequencing

```
Day 0 (parallel, no dependencies):
  7.1 benchmark rate source
  7.10 legal review of target providers
  7.9 kick off affiliate applications (slow external clock)
  7.3 cost-engine logic (against fixture data)

Once 7.3's output schema is frozen -> 7.4 schema locked:
  7.2 provider adapters (now parallelizable, one per provider)
  7.5 orchestration
  7.6 QA/monitoring
  7.7 API (against seeded DB)
  7.8 frontend (against mocked 7.7 contract)

Integration: wire real 7.2 adapters -> 7.4 -> 7.7 -> 7.8, enable 7.5's schedule
```

**Go/No-Go gate before full 7.2 provider rollout:** §6's competitive-monetization validation and 7.9's affiliate applications are not caveats to note in passing — they block committing engineering time to more than the 2 initial API-based providers. Before expanding 7.2 beyond the first providers, confirm at least one of: (a) an affiliate program has responded with viable terms, or (b) competitor research (§6) surfaces a viable non-affiliate monetization path. If neither holds by the time 7.3/7.4 are integration-ready, proceed per §10's mitigation — treat v1 as demand validation, and keep provider count at the MVP floor (4–5) rather than expanding further.

## 9. Data Acquisition Strategy

| Method | Coverage | Reliability | Legal risk | Use for MVP |
|--------|----------|-------------|------------|--------------|
| Official API / partnership | Limited to willing providers (e.g. Wise) | High | None | Yes, primary |
| Scraping public rate calculators | Broad | Fragile — breaks on DOM changes | Needs 7.10 review | v2, provider-by-provider after legal clears |
| Manual/curated entry | Any provider | Stale between updates | None | Yes, fallback for MVP providers without an API |
| Affiliate program data feed | Depends on program | Varies | None (by definition of agreement) | Opportunistic — some referral sign-ups include a feed |

Recommendation: MVP uses official APIs + manual entry only. Scraping is a v2 investment made after demand is validated and 7.10 has cleared specific targets.

## 10. Risks & Open Questions

| Risk | Impact | Mitigation |
|------|--------|------------|
| Scraping ToS/legal exposure | Could force removal of providers or legal action | Legal review (7.10) before any scraper is built |
| No affiliate revenue at launch | Product has no monetization path | Start applications day one; treat v1 as demand validation if none clear in time |
| Stale rate shown, user can't get it | Trust damage, worse than showing fewer providers | Timestamp every quote; flag/exclude stale entries (FR-4) |
| Provider fee structures don't normalize cleanly (tiered, min/max, hidden FX spread) | Cost engine produces misleading comparisons | Model fee structure explicitly per provider in schema; validate against real published examples before launch |

## 11. Data & Privacy

v1 has no user accounts (§2), but two data flows still touch EU residents and need handling before launch:

- **Affiliate click tracking (FR-5, §7.9):** clicking through to a provider is likely tracked (for attribution/commission) even without an account. This is still personal data processing (IP address, click event) under GDPR — needs a cookie/tracking consent banner and a privacy policy before any affiliate link goes live, not deferred to a later version.
- **Analytics on comparisons run (§12 success metric):** if usage analytics are added to measure "comparisons run per week," the same consent requirement applies, scoped to whatever is minimally needed for that metric (e.g. aggregate counts over per-user tracking).

No other personal data is collected in v1 (no accounts, no saved searches, no stored transfer details), so this section stays narrow — revisit if user accounts are added per the roadmap (§13).

## 12. Success Metrics (proposed — needs confirmation)

- Number of comparisons run per week
- Click-through rate to provider (affiliate link)
- Rate/data freshness (% of quotes within SLA at any given time)
- Provider coverage (count of providers live)

## 13. Roadmap

1. EUR → INR MVP (this document)
2. Add 2nd corridor (e.g. USD → INR) to validate the corridor abstraction from §7's critical notes
3. Expand provider count via scraping (post-legal-review)
4. Explore rate alerts / saved searches (deferred from v1 non-goals)

## Appendix: Candidate MVP Providers

To be confirmed — starting candidates: Wise (API), Revolut (API), 1–2 major Indian-remittance-corridor banks (manual entry).
