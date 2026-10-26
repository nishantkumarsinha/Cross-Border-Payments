import type Database from "better-sqlite3";
import fs from "fs";
import { openKvDb, kvGet, kvSet } from "../lib/sqliteKv";

describe("sqliteKv", () => {
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
    const path = `${__dirname}/../data/test-sqlite-kv-${Date.now()}.sqlite`;
    const db1 = openKvDb(path);
    kvSet(db1, "foo", "bar");
    db1.close();

    const db2 = openKvDb(path);
    expect(kvGet(db2, "foo")).toBe("bar");
    db2.close();

    fs.unlinkSync(path);
  });
});
