/**
 * The `Dialect` contract — the extensibility contract every database must satisfy.
 *
 * A dialect is one database family and the only place DB-specific SQL/behavior lives,
 * *including* native read-only enforcement (which must never leak upward).
 */

/** An opaque, dialect-owned connection handle. Layers above never inspect it. */
export type DbConn = unknown;

/** A generic result row (column name -> value). */
export type Row = Record<string, unknown>;

/** One database family. Implement this + register it to add a new database. */
export abstract class Dialect {
  /** The DSN scheme this dialect handles, e.g. `"postgresql"`. */
  abstract readonly scheme: string;

  /**
   * Open a connection.
   *
   * When `readOnly=true`, enforce it *natively* before returning the
   * connection (Postgres: `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`).
   */
  abstract connect(dsn: string, opts: { readOnly: boolean }): Promise<DbConn>;

  /**
   * Close a connection opened by {@link connect}.
   *
   * Node drivers have no duck-typed `close`, so the contract owns teardown — keeping
   * the layers above (`handlers`) database-agnostic.
   */
  abstract close(conn: DbConn): Promise<void>;

  /** Return tables and views as `[{schema, name, kind}]`. */
  abstract listTables(conn: DbConn): Promise<Row[]>;

  /** Return columns, types, nullability, and PK/FK for one table. */
  abstract getSchema(conn: DbConn, table: string): Promise<Row>;

  /** Return the first `n` rows. The identifier MUST be safely quoted (Rule 9). */
  abstract sampleRows(conn: DbConn, table: string, n?: number): Promise<Row[]>;

  /** Run raw SQL; return `{columns, rows}` or `{rows_affected}`. */
  abstract execute(conn: DbConn, sql: string): Promise<Row>;

  /**
   * Throw `Error` if `sql` is not a single read-only statement.
   *
   * Defense-in-depth for the read tool: the native read-only transaction is a
   * *session* setting an attacker-influenced query could flip (Postgres: `SET
   * SESSION CHARACTERISTICS ... READ WRITE`) or smuggle a second statement past.
   * This pure check rejects anything that isn't one read-only, row-returning
   * statement, *before* a connection is opened.
   */
  abstract validateReadOnly(sql: string): void;

  /**
   * Fuzzy (case-insensitive substring) search for columns by name across tables.
   *
   * Returns `[{schema, table, column, type, nullable}]` for columns whose name
   * matches `pattern`.
   */
  abstract findColumns(conn: DbConn, pattern: string): Promise<Row[]>;

  /**
   * Fuzzy search for `value` in the data across (optionally scoped) tables.
   *
   * When `tables` is given, only those are scanned; otherwise all non-system,
   * non-junk base tables. Returns
   * `{results: [{schema, table, column, matches, samples}], truncated: boolean}`.
   */
  abstract searchValue(
    conn: DbConn,
    value: string,
    tables?: string[] | null,
    limitPerColumn?: number,
  ): Promise<Row>;
}
