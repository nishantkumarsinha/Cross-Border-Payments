import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export function openKvDb(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS kv_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

export function kvGet(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kv_cache WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function kvSet(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO kv_cache (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
