import type Database from "better-sqlite3";
import { kvGet, kvSet } from "./sqliteKv";

export interface CacheStore<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

export function createSqliteCacheStore<T>(db: Database.Database, namespace: string): CacheStore<T> {
  return {
    get(key: string): T | undefined {
      const raw = kvGet(db, `${namespace}:${key}`);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    set(key: string, value: T): void {
      kvSet(db, `${namespace}:${key}`, JSON.stringify(value));
    },
  };
}
