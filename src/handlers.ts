/**
 * The tool service layer — pure logic behind the MCP tools, no transport.
 *
 * Each method maps 1:1 to an MCP tool (see `server.ts`). Keeping this separate from
 * the server wiring makes the behavior unit-testable without a transport or a live DB.
 *
 * Every method that opens a connection routes failures through {@link explain}, so an
 * agent never sees a raw, leaky driver error and the DSN never appears in any result
 * (Rule 6).
 */

import * as config from "./config.js";
import { explain, type Diagnostic } from "./diagnostics.js";
import { type DbConn, type Dialect, type Row } from "./dialects/base.js";
import { dialectFor } from "./dialects/registry.js";
import { publicView, type Config, type Connection, type PublicConnection } from "./models.js";
import { authorizeWrite } from "./safety.js";

/** Render a {@link explain} diagnostic into a single sanitized line. */
function formatDiagnostic(diag: Diagnostic): string {
  const fixes = diag.fixes.join(" ");
  return `[${diag.category}] ${diag.cause} Fix: ${fixes}`;
}

/** A sanitized connection failure. Carries the diagnostic; message is agent-safe. */
export class ConnectionFailedError extends Error {
  readonly diag: Diagnostic;

  constructor(diag: Diagnostic) {
    super(formatDiagnostic(diag));
    this.name = "ConnectionFailedError";
    this.diag = diag;
  }
}

/** Bound to one resolved `connections.json` path; loads it fresh per call. */
export class Handlers {
  constructor(private readonly configPath: string) {}

  private load(): Config {
    return config.load(this.configPath);
  }

  /** Open a connection, converting any failure into a sanitized error. */
  private async connect(
    conn: Connection,
    opts: { readOnly: boolean },
  ): Promise<{ dialect: Dialect; db: DbConn }> {
    const dialect = dialectFor(conn.dsn);
    let db: DbConn;
    try {
      db = await dialect.connect(conn.dsn, { readOnly: opts.readOnly });
    } catch (err) {
      throw new ConnectionFailedError(explain(err));
    }
    return { dialect, db };
  }

  // ---- Exploration tools ---------------------------------------------------

  /** Return configured databases as `{name, mode, yolo}` — never the DSN. */
  async listDatabases(): Promise<PublicConnection[]> {
    return this.load().connections.map(publicView);
  }

  /** Return tables and views for one database. */
  async listTables(database: string): Promise<Row[]> {
    const conn = config.get(this.load(), database);
    const { dialect, db } = await this.connect(conn, { readOnly: true });
    try {
      return await dialect.listTables(db);
    } finally {
      await dialect.close(db);
    }
  }

  /** Return columns/types and PK/FK for one table. */
  async getTableSchema(database: string, table: string): Promise<Row> {
    const conn = config.get(this.load(), database);
    const { dialect, db } = await this.connect(conn, { readOnly: true });
    try {
      return await dialect.getSchema(db, table);
    } finally {
      await dialect.close(db);
    }
  }

  /** Return the first `n` rows of a table. */
  async sampleTableRows(database: string, table: string, n = 10): Promise<Row[]> {
    const conn = config.get(this.load(), database);
    const { dialect, db } = await this.connect(conn, { readOnly: true });
    try {
      return await dialect.sampleRows(db, table, n);
    } finally {
      await dialect.close(db);
    }
  }

  /** Fuzzy-search for columns by name across all tables in a database. */
  async findColumns(database: string, pattern: string): Promise<Row[]> {
    const conn = config.get(this.load(), database);
    const { dialect, db } = await this.connect(conn, { readOnly: true });
    try {
      return await dialect.findColumns(db, pattern);
    } finally {
      await dialect.close(db);
    }
  }

  /** Fuzzy-search for a value across (optionally scoped) tables' data. */
  async searchValue(
    database: string,
    value: string,
    tables: string[] | null = null,
    limitPerColumn = 5,
  ): Promise<Row> {
    const conn = config.get(this.load(), database);
    const { dialect, db } = await this.connect(conn, { readOnly: true });
    try {
      return await dialect.searchValue(db, value, tables, limitPerColumn);
    } finally {
      await dialect.close(db);
    }
  }

  // ---- Execution tools -----------------------------------------------------

  /**
   * Run a single read-only statement inside a native read-only transaction.
   *
   * The SQL is validated before any connection opens, so a write-ish or
   * session-flipping query (`SET ... READ WRITE`, a piggy-backed `; DELETE`) is
   * rejected without touching the database.
   */
  async executeReadQuery(database: string, sql: string): Promise<Row> {
    const conn = config.get(this.load(), database);
    dialectFor(conn.dsn).validateReadOnly(sql); // throws if not read-only
    const { dialect, db } = await this.connect(conn, { readOnly: true });
    try {
      return await dialect.execute(db, sql);
    } finally {
      await dialect.close(db);
    }
  }

  /** Run a mutation, gated by {@link authorizeWrite} (mode -> yolo -> consent). */
  async executeWriteQuery(database: string, sql: string, userConsent = false): Promise<Row> {
    const conn = config.get(this.load(), database);
    authorizeWrite(conn, userConsent); // throws WriteRejected if blocked
    const { dialect, db } = await this.connect(conn, { readOnly: false });
    try {
      return await dialect.execute(db, sql);
    } finally {
      await dialect.close(db);
    }
  }

  // ---- Configuration tool --------------------------------------------------

  /** Persist the `yolo` flag for one database to `connections.json`. */
  async setYoloMode(database: string, enabled: boolean): Promise<Row> {
    config.setYolo(this.configPath, database, enabled);
    return { database, yolo: enabled, persisted: true };
  }

  // ---- Diagnostics tool ----------------------------------------------------

  /** Probe one database (or all) and report `OK` or a sanitized diagnostic. */
  async checkDatabase(database?: string | null): Promise<Row[]> {
    const cfg = this.load();
    const targets = database ? [config.get(cfg, database)] : cfg.connections;
    const report: Row[] = [];
    for (const conn of targets) {
      try {
        const { dialect, db } = await this.connect(conn, { readOnly: true });
        await dialect.close(db);
        report.push({ database: conn.name, status: "OK" });
      } catch (err) {
        if (err instanceof ConnectionFailedError) {
          report.push({
            database: conn.name,
            status: "UNREACHABLE",
            category: err.diag.category,
            detail: err.message,
          });
        } else {
          throw err;
        }
      }
    }
    return report;
  }
}
