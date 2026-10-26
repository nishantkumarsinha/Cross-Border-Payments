import { fetchWithTimeout } from "../lib/httpUtil";

describe("fetchWithTimeout", () => {
  it("resolves normally when the underlying fetch resolves before the timeout", async () => {
    const quickFetch = jest.fn(async () => new Response("ok"));
    const res = await fetchWithTimeout("http://example.test", 1000, quickFetch);
    expect(await res.text()).toBe("ok");
  });

  it("passes an AbortSignal through, and rejects once it fires", async () => {
    // Simulates what a well-behaved fetch implementation does with the
    // signal it's given — we are testing that OUR wrapper constructs and
    // passes a signal that fires within the given timeout, not whether the
    // real global fetch/undici itself honors AbortSignal (that's not ours
    // to test).
    const respectsAbort = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        })
    );

    await expect(fetchWithTimeout("http://example.test", 10, respectsAbort)).rejects.toThrow(
      "aborted"
    );
  });
});
