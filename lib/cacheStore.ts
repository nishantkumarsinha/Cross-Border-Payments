import type Database from "better-sqlite3";
import { kvGet, kvSet } from "./sqliteKv";

export interface CacheStore<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

export function createSqliteCacheStore<T>(db: Database.Database, namespace: string): CacheStore<T> {
  return {
    // A cache is an optimization, not a dependency a caller should fail
    // over — the Map this replaced could never throw, so a real backing
    // store (SQLITE_BUSY, disk I/O errors, a corrupt row) must fail soft
    // rather than propagate, or it breaks FR-7's provider isolation.
    get(key: string): T | undefined {
      try {
        const raw = kvGet(db, `${namespace}:${key}`);
        return raw === undefined ? undefined : (JSON.parse(raw) as T);
      } catch (err) {
        console.error(`cacheStore.get failed for ${namespace}:${key}`, err);
        return undefined;
      }
    },
    set(key: string, value: T): void {
      try {
        kvSet(db, `${namespace}:${key}`, JSON.stringify(value));
      } catch (err) {
        console.error(`cacheStore.set failed for ${namespace}:${key}`, err);
      }
    },
  };
}
