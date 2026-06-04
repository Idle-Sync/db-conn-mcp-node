/**
 * PostgreSQL dialect (`pg` / node-postgres) — the only implementation in v1.
 *
 * The only module in the project that knows it is talking to PostgreSQL. Read-only is
 * enforced natively here via session characteristics; introspection uses
 * `information_schema`; identifiers are safely quoted before interpolation (Rule 9).
 *
 * NOTE: unlike asyncpg (whose `fetch()` always uses the extended protocol, which runs
 * exactly one command), node-postgres uses the *simple* query protocol when no values
 * are passed — and the simple protocol permits multiple `;`-separated statements. So
 * the read path forces the extended protocol by passing an (empty) `values` array;
 * that, plus `validateReadOnly`, is what refuses a piggy-backed `; DELETE ...`.
 */

import pg from "pg";
import type { Client, QueryResultRow } from "pg";

import { Dialect, type DbConn, type Row } from "./base.js";

/** DSN schemes routed to this dialect. */
export const SCHEMES = ["postgresql", "postgres"] as const;

/** Native, session-level read-only enforcement (the Postgres mechanism). */
const READ_ONLY_SQL = "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY";

// Leading keywords that begin a read-only, row-returning statement. This single set
// does double duty: execute() uses it to shape the result ({columns, rows}), and the
// read tool uses it as an allowlist (validateReadOnly). The overlap is the point —
// because every permitted read leader is row-returning, the statement runs through the
// extended (prepared-statement) protocol, which refuses to run more than one command.
// So banning non-read leaders also bans a trailing "; DELETE".
const READ_ONLY_LEADERS = new Set(["select", "with", "values", "table", "show", "explain"]);

const LIST_TABLES_SQL = `
    SELECT table_schema AS schema,
           table_name   AS name,
           CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END AS kind
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name
`;

const COLUMNS_SQL = `
    SELECT column_name                   AS name,
           data_type                     AS type,
           (is_nullable = 'YES')         AS nullable,
           column_default                AS default
    FROM information_schema.columns
    WHERE table_name = $1 AND ($2::text IS NULL OR table_schema = $2)
    ORDER BY ordinal_position
`;

// Primary- and foreign-key columns for one table, with the FK target as "table.column".
const KEYS_SQL = `
    SELECT kcu.column_name AS column,
           tc.constraint_type AS constraint_type,
           CASE WHEN tc.constraint_type = 'FOREIGN KEY'
                THEN ccu.table_name || '.' || ccu.column_name
                ELSE NULL END AS references
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.constraint_schema = tc.constraint_schema
    LEFT JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.constraint_schema = tc.constraint_schema
    WHERE tc.table_name = $1 AND ($2::text IS NULL OR tc.table_schema = $2)
      AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
`;

/** Fuzzy column-name search (Tool A). `$1` is the parameterized pattern. */
const FIND_COLUMNS_SQL = `
    SELECT table_schema AS schema,
           table_name   AS table,
           column_name  AS column,
           data_type    AS type,
           (is_nullable = 'YES') AS nullable
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND column_name ILIKE '%' || $1 || '%'
    ORDER BY table_schema, table_name, ordinal_position
`;

// Base-table columns (excludes views/system schemas); `$1::text[]` (NULL = all)
// restricts to specific table names for a scoped value search.
const SEARCH_COLUMNS_SQL = `
    SELECT c.table_schema AS schema,
           c.table_name   AS table,
           c.column_name  AS column
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
     AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
      AND ($1::text[] IS NULL OR c.table_name = ANY($1::text[]))
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
`;

/** Bound a value-search scan so a wide/huge scan fails safe instead of hanging. */
const SEARCH_TIMEOUT_SQL = "SET statement_timeout = '8s'";

/** Postgres SQLSTATE for a statement-timeout cancellation. */
const QUERY_CANCELED = "57014";

/** Tables skipped by default in an unscoped value search (framework/replication/stats). */
const JUNK_TABLES = new Set(["migrations", "jobs", "failed_jobs", "password_resets"]);
const JUNK_PREFIXES = ["awsdms_", "pg_stat"];

/** Whether a table is noise skipped by default (an explicit `tables=` overrides this). */
function isJunkTable(name: string): boolean {
  return JUNK_TABLES.has(name) || JUNK_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Safely quote a (optionally `schema.table`) SQL identifier (Rule 9).
 *
 * Mirrors Postgres `quote_ident`: wrap each dotted part in double quotes and double
 * any embedded double quotes, so a hostile name can never break out into runnable SQL.
 * Empty parts or null bytes are rejected.
 */
export function quoteIdentifier(identifier: string): string {
  if (!identifier || identifier.includes("\u0000")) {
    throw new Error("Invalid SQL identifier.");
  }
  const parts = identifier.split(".");
  if (parts.some((part) => part === "")) {
    throw new Error("Invalid SQL identifier.");
  }
  return parts.map((part) => '"' + part.replace(/"/g, '""') + '"').join(".");
}

/**
 * Single-pass aggregate that, per column, counts and samples fuzzy text matches.
 *
 * Scans the table once. `$1` is the (parameterized) search value; every column is cast
 * to text and matched case-insensitively (`ILIKE`). Identifiers are safely quoted
 * (Rule 9); the value is never interpolated.
 */
export function buildTableSearchSql(
  schema: string,
  table: string,
  columns: string[],
  limit: number,
): string {
  const qtable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const parts: string[] = [];
  columns.forEach((col, i) => {
    const qc = `${quoteIdentifier(col)}::text`;
    const cond = `${qc} ILIKE '%' || $1 || '%'`;
    parts.push(`count(*) FILTER (WHERE ${cond}) AS m_${i}`);
    parts.push(`(array_agg(DISTINCT ${qc}) FILTER (WHERE ${cond}))[1:${limit}] AS s_${i}`);
  });
  return `SELECT ${parts.join(", ")} FROM ${qtable}`;
}

/** Return `[table_name, schema_or_null]` for introspection parameters. */
export function splitSchemaTable(table: string): [string, string | null] {
  const idx = table.indexOf(".");
  if (idx >= 0) {
    return [table.slice(idx + 1), table.slice(0, idx)];
  }
  return [table, null];
}

/**
 * Return the first SQL keyword, lowercased, ignoring leading whitespace/comments.
 *
 * Leading `--` line comments and block comments are skipped so a query like
 * `-- note\nSELECT 1` still reports `select`. Returns `""` for blank or comment-only
 * input. Used both to shape results and to gate the read tool.
 */
export function leadingKeyword(sql: string): string {
  let s = sql.replace(/^\s+/, "");
  while (s) {
    if (s.startsWith("--")) {
      const newline = s.indexOf("\n");
      s = newline === -1 ? "" : s.slice(newline + 1).replace(/^\s+/, "");
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2).replace(/^\s+/, "");
    } else {
      break;
    }
  }
  if (!s) {
    return "";
  }
  const token = s.split(/\s+/, 1)[0] ?? "";
  return token.toLowerCase();
}

function asClient(conn: DbConn): Client {
  return conn as Client;
}

/** `pg`-backed PostgreSQL dialect. */
export class PostgresDialect extends Dialect {
  readonly scheme = "postgresql";

  override async connect(dsn: string, opts: { readOnly: boolean }): Promise<DbConn> {
    const client = new pg.Client({ connectionString: dsn });
    await client.connect();
    if (opts.readOnly) {
      // Enforce read-only natively before the caller can run anything.
      await client.query(READ_ONLY_SQL);
    }
    return client;
  }

  override async close(conn: DbConn): Promise<void> {
    await asClient(conn).end();
  }

  override async listTables(conn: DbConn): Promise<Row[]> {
    const res = await asClient(conn).query(LIST_TABLES_SQL, []);
    return res.rows;
  }

  override async getSchema(conn: DbConn, table: string): Promise<Row> {
    const [name, schema] = splitSchemaTable(table);
    const client = asClient(conn);
    const columns = (await client.query(COLUMNS_SQL, [name, schema])).rows;
    const keys = (await client.query(KEYS_SQL, [name, schema])).rows as Array<{
      column: string;
      constraint_type: string;
      references: string | null;
    }>;
    const primaryKey = keys.filter((k) => k.constraint_type === "PRIMARY KEY").map((k) => k.column);
    const foreignKeys = keys
      .filter((k) => k.constraint_type === "FOREIGN KEY")
      .map((k) => ({ column: k.column, references: k.references }));
    return {
      table,
      columns,
      primary_key: primaryKey,
      foreign_keys: foreignKeys,
    };
  }

  override async sampleRows(conn: DbConn, table: string, n = 10): Promise<Row[]> {
    const limit = Math.max(0, Math.trunc(Number(n))); // coerce to a safe non-negative int
    const sql = `SELECT * FROM ${quoteIdentifier(table)} LIMIT ${limit}`;
    const res = await asClient(conn).query(sql, []);
    return res.rows;
  }

  override async execute(conn: DbConn, sql: string): Promise<Row> {
    const client = asClient(conn);
    if (isRowReturning(sql)) {
      // Force the extended protocol (empty values) => exactly one command runs.
      const res = await client.query({ text: sql, values: [] });
      const rows = res.rows as QueryResultRow[];
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
      return { columns, rows };
    }
    const res = await client.query(sql);
    return { rows_affected: res.rowCount ?? 0 };
  }

  override validateReadOnly(sql: string): void {
    const leader = leadingKeyword(sql);
    if (!leader) {
      throw new Error("Empty SQL: provide a single read-only query.");
    }
    if (!READ_ONLY_LEADERS.has(leader)) {
      const allowed = [...READ_ONLY_LEADERS].sort().join(", ").toUpperCase();
      throw new Error(
        `Read query must be a single read-only statement starting with one of: ` +
          `${allowed}. Got '${leader.toUpperCase()}'. Use a write-mode database and ` +
          "execute_write_query for INSERT/UPDATE/DELETE/DDL or SET.",
      );
    }
  }

  override async findColumns(conn: DbConn, pattern: string): Promise<Row[]> {
    const res = await asClient(conn).query(FIND_COLUMNS_SQL, [pattern]);
    return res.rows;
  }

  override async searchValue(
    conn: DbConn,
    value: string,
    tables: string[] | null = null,
    limitPerColumn = 5,
  ): Promise<Row> {
    const limit = Math.max(1, Math.trunc(Number(limitPerColumn)));
    const client = asClient(conn);
    await client.query(SEARCH_TIMEOUT_SQL); // fail safe on a wide/huge scan
    const colRows = (
      await client.query(SEARCH_COLUMNS_SQL, [tables && tables.length ? tables : null])
    ).rows as Array<{ schema: string; table: string; column: string }>;

    const grouped = new Map<string, { schema: string; table: string; columns: string[] }>();
    for (const r of colRows) {
      const key = `${r.schema}\u0000${r.table}`;
      const group = grouped.get(key);
      if (group) {
        group.columns.push(r.column);
      } else {
        grouped.set(key, { schema: r.schema, table: r.table, columns: [r.column] });
      }
    }

    const results: Row[] = [];
    let truncated = false;
    for (const { schema, table, columns } of grouped.values()) {
      if ((!tables || tables.length === 0) && isJunkTable(table)) {
        continue;
      }
      const sql = buildTableSearchSql(schema, table, columns, limit);
      let row: Record<string, unknown> | undefined;
      try {
        row = (await client.query(sql, [value])).rows[0];
      } catch (err) {
        const code = errorCode(err);
        if (code === QUERY_CANCELED) {
          // statement_timeout tripped
          truncated = true;
          break;
        }
        if (code) {
          // one unscannable table — skip, keep going
          continue;
        }
        throw err;
      }
      if (!row) {
        continue;
      }
      columns.forEach((col, i) => {
        // count(*) returns bigint, which node-postgres yields as a STRING — coerce so
        // "0" doesn't read as truthy and a real count stays numeric.
        const matches = Number(row![`m_${i}`] ?? 0);
        if (matches) {
          results.push({
            schema,
            table,
            column: col,
            matches,
            samples: (row![`s_${i}`] as unknown[]) ?? [],
          });
        }
      });
    }
    return { results, truncated };
  }
}

/** Heuristic: does this statement return a result set? */
function isRowReturning(sql: string): boolean {
  return READ_ONLY_LEADERS.has(leadingKeyword(sql));
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
