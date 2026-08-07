import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/**
 * SQLite persistence layer. Opens a single connection (WAL mode), applies the
 * schema and any ordered migrations idempotently, and exposes a singleton `db`
 * plus a `withTransaction` helper.
 *
 * The DB path is read from the DB_PATH environment variable (the same variable
 * validated by config.ts), defaulting to ./data/github.db. Tests set
 * DB_PATH=":memory:" before importing this module to get an isolated in-memory
 * database. Use ":memory:" for a throwaway DB.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Base schema, applied as migration version 1. */
const SCHEMA_SQL = readFileSync(join(HERE, "schema.sql"), "utf8");

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Ordered migrations. Version 1 is the base schema. Append new migrations with
 * strictly increasing versions; each runs exactly once, in order.
 */
const MIGRATIONS: Migration[] = [{ version: 1, name: "init", sql: SCHEMA_SQL }];

export type DB = Database.Database;

function resolveDbPath(): string {
  const p = process.env.DB_PATH?.trim();
  return p && p.length > 0 ? p : "./data/github.db";
}

function applyMigrations(database: DB): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     );`,
  );

  const currentVersion =
    (
      database
        .prepare("SELECT MAX(version) AS v FROM schema_migrations")
        .get() as { v: number | null }
    ).v ?? 0;

  const record = database.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    const run = database.transaction(() => {
      database.exec(migration.sql);
      record.run(migration.version, migration.name, new Date().toISOString());
    });
    run();
  }
}

/**
 * Create (or open) a database at `path`, configure pragmas, and migrate. Useful
 * directly in tests; the app uses the shared `db` singleton below.
 */
export function createDb(path: string = resolveDbPath()): DB {
  if (path !== ":memory:") {
    // Ensure the parent directory exists before better-sqlite3 opens the file.
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("synchronous = NORMAL");

  applyMigrations(database);
  return database;
}

/** The shared singleton connection used by the repository modules. */
export const db: DB = createDb();

/**
 * Run `fn` inside a single transaction. Commits on success, rolls back if `fn`
 * throws. The return value of `fn` is passed through.
 */
export function withTransaction<T>(fn: (database: DB) => T): T {
  const txn = db.transaction(fn);
  return txn(db);
}
