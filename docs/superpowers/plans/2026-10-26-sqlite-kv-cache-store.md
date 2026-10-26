# SQLite KV Cache Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two in-memory `Map`s in `app/api/compare/route.ts` (benchmark rate cache, provider quote cache) with a persistent, file-backed key-value store, so cached data survives a server restart instead of resetting to empty every time.

**Architecture:** A genuinely low-level KV primitive (`lib/sqliteKv.ts` — `get`/`set` on a single `(key TEXT, value TEXT)` table, nothing else) underneath a typed adapter (`lib/cacheStore.ts`) that JSON-serializes values and exposes the same `{ get(key), set(key, value) }` shape Tasks 1 and 3 already depend on. Because a plain JS `Map` already structurally satisfies that shape, generalizing `BenchmarkCache`/`QuoteCacheMap` from the literal type `Map<string, Entry>` to an interface `CacheStore<Entry>` requires no change to Tasks 1–3's own logic or tests — they keep passing a `Map` in tests, and `route.ts` passes a SQLite-backed store in production. TTL/freshness logic stays exactly where it already is (inside `getBenchmarkRate` and `getAllProviderQuotes`, which compare a stored `fetchedAtMs` against `nowMs()`) — the KV store itself has no concept of expiry, it just durably holds whatever string it's given.

**Tech Stack:** `better-sqlite3` (synchronous API, file-based, already in Next.js's own default `serverExternalPackages` auto-externalized list — confirmed by reading `node_modules/next/dist/docs`, so this plan does **not** need the manual `serverExternalPackages` config entry Task 3b needed for `pdf-parse`). Chosen over Redis/Vercel KV specifically because no deployment target has been decided yet — SQLite needs no external account, service, or env var, and works identically in local dev and on any host with a writable disk.

**Spec:** `docs/prd-eur-inr-comparison.md` §7.4 (Storage & schema — this plan is a minimal slice of it: durable caching, not the full provider/quote schema persistence or history §7.4 ultimately implies) and the three already-implemented plans/modules this one builds on top of without modifying their logic: `lib/benchmarkRate.ts` (Task 1), `lib/costEngine.ts` (Task 2), `lib/pdfRateWorker.ts` + `lib/providerQuotes.ts` (Task 3/3b).

## Global Constraints

- The KV store has no TTL/expiry logic of its own — freshness is entirely the caller's responsibility (already implemented, already tested in Tasks 1 and 3). Do not add expiry to `lib/sqliteKv.ts` or `lib/cacheStore.ts`; that would duplicate logic that already exists and is already correct.
- The SQLite database file lives at `data/cache.sqlite`, relative to the process's working directory, and is git-ignored — it's runtime state, not source. The directory is created if missing; the file is created by `better-sqlite3` itself on first open.
- `BenchmarkCache` and `QuoteCacheMap` become interfaces (`CacheStore<BenchmarkCacheEntry>` / `CacheStore<QuoteCacheEntry>`), not concrete `Map` types — this is the one change to already-shipped code this plan makes, and it must not break any existing test in `tests/benchmarkRate.test.ts`, `tests/costEngine.test.ts`, `tests/pdfRateWorker.test.ts`, or `tests/providerQuotes.test.ts`, all of which construct a literal `new Map()` and must keep doing so unchanged.
- Namespacing: both caches share one SQLite file and one table, distinguished by a key prefix (`benchmark:` / `quote:`) — not two separate tables or files. Simpler, and nothing here needs per-cache-type SQL schema differences.

## Review Focus

- **Two different cache entry shapes (`BenchmarkCacheEntry` vs `QuoteCacheEntry`, which embeds a full `Quote` object) must round-trip through JSON serialization without corruption** — the quote cache entry is a deeply nested object, not a flat one. Covered in Task 2 below with a test using a real-shaped entry, not a trivial flat object.
- **A key that was never set must return `undefined`, not throw or return a confusing falsy value that's hard to distinguish from "stored empty string."** Covered in Task 1.
- **Re-setting an existing key must overwrite, not insert a duplicate row or throw a primary-key-conflict error.** Covered in Task 1 (the upsert path).
- **The existing Task 1/2/3 test suites must still pass unchanged after `BenchmarkCache`/`QuoteCacheMap` become interfaces instead of concrete `Map` types** — this is the main regression risk of this plan's one touch to already-shipped code. Covered as an explicit full-suite run at the end of Task 2, not just the new tests passing in isolation.
- **Restart persistence — the actual point of this plan — needs a real, not just unit-tested, verification.** A Jest test can prove the SQLite store round-trips a value within one process; it cannot prove a *second, independent* `next dev` process sees what the first one wrote. Covered in Task 3 with a manual `npm run dev` → curl → kill → restart → curl verification, the same discipline used to catch the real `pdf-parse` bundling bug in the previous phase.

---

### Task 1: Low-Level SQLite KV Primitive (`lib/sqliteKv.ts`)

**Files:**
- Create: `lib/sqliteKv.ts`
- Test: `tests/sqliteKv.test.ts`
- Modify: `.gitignore` (add `data/`)

**Interfaces:**
- Consumes: nothing (no dependency on any other task)
- Produces (for Task 2 to use):
  ```ts
  // lib/sqliteKv.ts
  import Database from "better-sqlite3";

  export function openKvDb(path: string): Database.Database
  export function kvGet(db: Database.Database, key: string): string | undefined
  export function kvSet(db: Database.Database, key: string, value: string): void
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sqliteKv.test.ts
import Database from "better-sqlite3";
import { openKvDb, kvGet, kvSet } from "../lib/sqliteKv";

describe("sqliteKv", () => {
  // ":memory:" is better-sqlite3's own in-memory mode — no file I/O, no
  // cleanup needed, verified directly against the installed library before
  // writing this plan.
  function freshDb(): Database.Database {
    return openKvDb(":memory:");
  }

  it("returns undefined for a key that was never set", () => {
    const db = freshDb();
    expect(kvGet(db, "missing")).toBeUndefined();
  });

  it("round-trips a value that was set", () => {
    const db = freshDb();
    kvSet(db, "foo", "bar");
    expect(kvGet(db, "foo")).toBe("bar");
  });

  it("overwrites an existing key on a second set, without erroring", () => {
    const db = freshDb();
    kvSet(db, "foo", "bar");
    kvSet(db, "foo", "baz");
    expect(kvGet(db, "foo")).toBe("baz");
  });

  it("opening the same db twice sees data written through the first handle", () => {
    // Exercises the CREATE TABLE IF NOT EXISTS path on a second open against
    // the same underlying file, not just a fresh :memory: db each time.
    const path = `${__dirname}/../data/test-sqlite-kv-${Date.now()}.sqlite`;
    const db1 = openKvDb(path);
    kvSet(db1, "foo", "bar");
    db1.close();

    const db2 = openKvDb(path);
    expect(kvGet(db2, "foo")).toBe("bar");
    db2.close();

    require("fs").unlinkSync(path);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/sqliteKv.test.ts`
Expected: FAIL — `openKvDb`/`kvGet`/`kvSet` not defined / module not found.

- [ ] **Step 3: Implement `lib/sqliteKv.ts`**

`openKvDb(path)`: if `path !== ":memory:"`, ensure the parent directory exists (`fs.mkdirSync(dirname(path), { recursive: true })`) before opening — `better-sqlite3` does not create missing directories itself. Open with `new Database(path)`, run `CREATE TABLE IF NOT EXISTS kv_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL)` via `.exec(...)`, return the handle.

`kvGet(db, key)`: `db.prepare("SELECT value FROM kv_cache WHERE key = ?").get(key)` returns `{ value: string } | undefined` (verified directly against the installed `better-sqlite3@13.0.3` before writing this plan — a missing key returns `undefined`, not `null`); return `row?.value`.

`kvSet(db, key, value)`: a single upsert statement — `INSERT INTO kv_cache (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value` — verified directly against the installed library to update in place rather than erroring on the primary-key conflict.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/sqliteKv.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Add `data/` to `.gitignore`**

- [ ] **Step 6: Commit**

```bash
git add lib/sqliteKv.ts tests/sqliteKv.test.ts .gitignore
git commit -m "feat: add low-level SQLite KV primitive (PRD §7.4, minimal slice)"
```

---

### Task 2: Typed Cache Store Adapter + Generalize Task 1/3's Cache Types

**Files:**
- Create: `lib/cacheStore.ts`
- Test: `tests/cacheStore.test.ts`
- Modify: `lib/types.ts` (`BenchmarkCache` becomes an interface, not a `Map` alias)
- Modify: `lib/providerQuotes.ts` (`QuoteCacheMap` becomes an interface, not a `Map` alias)

**Interfaces:**
- Consumes: `openKvDb`, `kvGet`, `kvSet` from Task 1 (`lib/sqliteKv.ts`)
- Produces (for Task 3 to wire into `route.ts`):
  ```ts
  // lib/cacheStore.ts
  export interface CacheStore<T> {
    get(key: string): T | undefined;
    set(key: string, value: T): void;
  }

  export function createSqliteCacheStore<T>(
    db: Database.Database,
    namespace: string
  ): CacheStore<T>
  ```

Type change (this plan's call): in `lib/types.ts`, change
```ts
export type BenchmarkCache = Map<string, BenchmarkCacheEntry>;
```
to
```ts
export type BenchmarkCache = CacheStore<BenchmarkCacheEntry>;
```
(importing `CacheStore` from `./cacheStore`), and in `lib/providerQuotes.ts`, change the `QuoteCacheMap` type the same way, to `CacheStore<QuoteCacheEntry>`. A `Map<K, V>` already has compatible `.get(key): V | undefined` and `.set(key, value)` methods, so this is a widening, not a breaking change — every existing test that does `new Map([...])` and passes it where a `BenchmarkCache`/`QuoteCacheMap` is expected keeps compiling and passing without being touched.

- [ ] **Step 1: Write the failing tests for `createSqliteCacheStore`**

```ts
// tests/cacheStore.test.ts
import { openKvDb } from "../lib/sqliteKv";
import { createSqliteCacheStore } from "../lib/cacheStore";
import type { QuoteCacheEntry } from "../lib/providerQuotes";

describe("createSqliteCacheStore", () => {
  it("returns undefined for a key that was never set", () => {
    const store = createSqliteCacheStore<{ n: number }>(openKvDb(":memory:"), "test");
    expect(store.get("missing")).toBeUndefined();
  });

  it("round-trips a flat object", () => {
    const store = createSqliteCacheStore<{ n: number }>(openKvDb(":memory:"), "test");
    store.set("a", { n: 42 });
    expect(store.get("a")).toEqual({ n: 42 });
  });

  // Review Focus: the quote cache's real entry shape is deeply nested
  // (a full Quote inside a QuoteCacheEntry), not a flat object — this must
  // survive JSON.stringify/parse without losing or mangling anything.
  it("round-trips a real-shaped QuoteCacheEntry without corruption", () => {
    const store = createSqliteCacheStore<QuoteCacheEntry>(openKvDb(":memory:"), "quote");
    const entry: QuoteCacheEntry = {
      fetchedAtMs: 123,
      quote: {
        provider_id: "hdfc",
        corridor: { from_currency: "EUR", to_currency: "INR" },
        amount_tier: { min: 0, max: 19160.76 },
        fee_model: "flat",
        flat_fee: 0,
        percentage_fee_bps: null,
        fee_min: null,
        fee_max: null,
        fx_spread_bps: 232.445,
        quoted_rate: 104.38,
        eligibility: null,
        provenance: "official_document",
        fetched_at: "2026-10-25T12:00:00.000Z",
      },
    };
    store.set("hdfc", entry);
    expect(store.get("hdfc")).toEqual(entry);
  });

  it("two namespaced stores sharing one db do not collide on the same key", () => {
    const db = openKvDb(":memory:");
    const a = createSqliteCacheStore<{ n: number }>(db, "a");
    const b = createSqliteCacheStore<{ n: number }>(db, "b");
    a.set("x", { n: 1 });
    b.set("x", { n: 2 });
    expect(a.get("x")).toEqual({ n: 1 });
    expect(b.get("x")).toEqual({ n: 2 });
  });

  it("overwrites an existing key on a second set", () => {
    const store = createSqliteCacheStore<{ n: number }>(openKvDb(":memory:"), "test");
    store.set("a", { n: 1 });
    store.set("a", { n: 2 });
    expect(store.get("a")).toEqual({ n: 2 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/cacheStore.test.ts`
Expected: FAIL — `createSqliteCacheStore` not defined. (`QuoteCacheEntry` must already be exported from `lib/providerQuotes.ts` — it already is, from Task 3b.)

- [ ] **Step 3: Implement `lib/cacheStore.ts`**

`createSqliteCacheStore<T>(db, namespace)` returns an object whose `get(key)` calls `kvGet(db, `${namespace}:${key}`)`, returning `undefined` if that's `undefined`, else `JSON.parse(...)` as `T`. Its `set(key, value)` calls `kvSet(db, `${namespace}:${key}`, JSON.stringify(value))`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/cacheStore.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Change `BenchmarkCache` and `QuoteCacheMap` from `Map` aliases to `CacheStore<T>` interfaces**

Edit `lib/types.ts` and `lib/providerQuotes.ts` exactly as described in this task's Interfaces section above.

- [ ] **Step 6: Run the FULL suite to confirm no regression**

Run: `npm test`
Expected: PASS, all tests across every test file green — the exact count from before this task started, plus this task's own 5 new tests. This is the step that proves the `Map`-to-interface generalization didn't break Tasks 1–3's existing, frozen tests.

- [ ] **Step 7: Commit**

```bash
git add lib/cacheStore.ts lib/types.ts lib/providerQuotes.ts tests/cacheStore.test.ts
git commit -m "feat: add typed SQLite cache store adapter, generalize cache types to an interface (PRD §7.4)"
```

---

### Task 3: Wire the SQLite Store into the API Route, Verify Restart Persistence

**Files:**
- Modify: `app/api/compare/route.ts`

**Interfaces:**
- Consumes: `openKvDb` (Task 1), `createSqliteCacheStore` (Task 2)
- Produces: nothing further downstream — this is the top of the call chain.

- [ ] **Step 1: Replace the two `new Map()` cache instances in `route.ts`**

Open one shared db at module scope — `const db = openKvDb(path.join(process.cwd(), "data", "cache.sqlite"))` — and construct `benchmarkCache = createSqliteCacheStore<BenchmarkCacheEntry>(db, "benchmark")` and `quoteCache = createSqliteCacheStore<QuoteCacheEntry>(db, "quote")` in place of the two `new Map()` calls. No other line in `route.ts` changes — `getBenchmarkRate` and `getAllProviderQuotes` already only need the `{ get, set }` shape.

- [ ] **Step 2: Run the full suite and type-check**

Run: `npm test && npx tsc --noEmit`
Expected: PASS / clean. (No new test is written for this step — `route.ts` itself has never been unit-tested, by the same established choice as Task 3b's production fetchers; this wiring is proven by the manual restart test in Step 3, which is the thing a mocked unit test cannot prove anyway.)

- [ ] **Step 3: Manually verify restart persistence**

```bash
rm -f data/cache.sqlite   # start from a clean cache
npm run dev &
sleep 4
curl -s "http://localhost:3000/api/compare?amount=1000"   # cold: expect ~3s, real PDF/network fetch
kill %1; sleep 1
npm run dev &
sleep 4
curl -s "http://localhost:3000/api/compare?amount=1000"   # after restart: expect a fast response (ms, not seconds) if the cache TTL hasn't expired, proving the SQLite file — not an in-memory Map that would have reset to empty — served the cached entry
kill %1
sqlite3 data/cache.sqlite "SELECT key FROM kv_cache;"   # or: node -e "console.log(require('better-sqlite3')('data/cache.sqlite').prepare('SELECT key FROM kv_cache').all())"
```

Expected: the second `curl` is fast (served from the SQLite-backed cache across the restart, not re-fetched), and the final query lists the expected keys (`benchmark:EUR:INR`, `quote:hdfc`, `quote:sbi`).

- [ ] **Step 4: Commit**

```bash
git add app/api/compare/route.ts
git commit -m "feat: persist benchmark/quote caches to SQLite, surviving a server restart (PRD §7.4)"
```
