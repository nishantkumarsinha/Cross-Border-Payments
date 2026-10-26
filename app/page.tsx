"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";

interface CompareResult {
  provider_id: string;
  provenance: string;
  excluded_reason: string | null;
  amount_received: string | null;
  effective_rate: number | null;
}

interface CompareFailure {
  bankId: string;
  error: string;
}

interface CompareResponse {
  benchmark: { rate: number; asOf: string; stale: boolean };
  amount: number;
  results: CompareResult[];
  failures: CompareFailure[];
}

interface CompareErrorResponse {
  error: string;
}

const th: CSSProperties = { textAlign: "left", borderBottom: "2px solid #ddd", padding: 8 };
const td: CSSProperties = { borderBottom: "1px solid #eee", padding: 8 };

export default function Page() {
  const [amount, setAmount] = useState("1000");
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runCompare = useCallback(async (amountValue: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/compare?amount=${encodeURIComponent(amountValue)}`);
      const json = (await res.json()) as CompareResponse | CompareErrorResponse;
      if (!res.ok) {
        setError("error" in json ? json.error : "Something went wrong");
        setData(null);
      } else {
        setData(json as CompareResponse);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount with a loading indicator; the alternative (deferring setLoading so it's not "synchronous" within the effect) loses the instant loading state for no behavior change.
    void runCompare("1000");
  }, [runCompare]);

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: "0 20px", fontFamily: "system-ui, sans-serif" }}>
      <h1>EUR &rarr; INR comparison</h1>
      <p style={{ color: "#666" }}>
        Live interbank rate, plus real HDFC and SBI rates pulled from each bank&apos;s own published
        forex-card-rate PDF — not illustrative figures.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runCompare(amount);
        }}
        style={{ display: "flex", gap: 8, margin: "20px 0" }}
      >
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          min="1"
          step="0.01"
          style={{ padding: 8, fontSize: 16, flex: 1 }}
          aria-label="Amount in EUR"
        />
        <button type="submit" disabled={loading} style={{ padding: "8px 16px", fontSize: 16 }}>
          {loading ? "Comparing…" : "Compare"}
        </button>
      </form>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {data && (
        <>
          <p style={{ fontSize: 14, color: "#666" }}>
            Interbank rate: {data.benchmark.rate.toFixed(4)} INR/EUR
            {data.benchmark.stale ? " (stale — live fetch failed, showing last known good)" : ""}
            {" — as of "}
            {data.benchmark.asOf}
          </p>

          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Provider</th>
                <th style={th}>Source</th>
                <th style={th}>You get (INR)</th>
                <th style={th}>Effective rate</th>
              </tr>
            </thead>
            <tbody>
              {data.results.map((r) => (
                <tr key={r.provider_id}>
                  <td style={td}>{r.provider_id.toUpperCase()}</td>
                  <td style={td}>{r.provenance}</td>
                  <td style={td}>
                    {r.amount_received !== null ? `₹${r.amount_received}` : r.excluded_reason ?? "unavailable"}
                  </td>
                  <td style={td}>{r.effective_rate !== null ? r.effective_rate.toFixed(4) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.failures.length > 0 && (
            <p style={{ color: "#a86a00", fontSize: 14, marginTop: 12 }}>
              Temporarily unavailable: {data.failures.map((f) => f.bankId.toUpperCase()).join(", ")}
            </p>
          )}
        </>
      )}
    </main>
  );
}
