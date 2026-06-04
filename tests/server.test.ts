/**
 * Tests for the MCP tool handlers (the service layer beneath the server).
 *
 * The handlers are exercised directly with a temp config and a fake dialect, so no
 * live database or MCP transport is needed. The contracts under test: DSNs never leak,
 * reads connect read-only, the write gate is enforced, and connection failures surface
 * as sanitized diagnostics.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake dialect the mocked registry hands back; mutated per test.
const state = vi.hoisted(() => ({ dialect: null as unknown }));

vi.mock("../src/dialects/registry.js", () => ({
  dialectFor: () => state.dialect,
  supportedSchemes: () => ["postgres", "postgresql"],
}));

import { Handlers } from "../src/handlers.js";
import { buildServer } from "../src/server.js";
import { WriteRejected } from "../src/safety.js";

const CONFIG = {
  connections: [
    { name: "prod", dsn: "postgresql://u:SECRET@h/prod", mode: "read" },
    { name: "dev", dsn: "postgresql://u:SECRET@h/dev", mode: "write" },
    { name: "trusted", dsn: "postgresql://u:SECRET@h/t", mode: "write", yolo: true },
  ],
};

function cfgPath(): string {
  const path = join(mkdtempSync(join(tmpdir(), "dbconn-srv-")), "connections.json");
  writeFileSync(path, JSON.stringify(CONFIG), "utf-8");
  return path;
}

class FakeConn {
  closed = false;
}

interface FakeDialectOpts {
  raiseOnConnect?: Error;
  execResult?: Record<string, unknown>;
}

class FakeDialect {
  readonly scheme = "postgresql";
  connectedReadOnly: boolean | null = null;
  readonly conn = new FakeConn();
  private readonly raiseOnConnect?: Error;
  private readonly execResult: Record<string, unknown>;

  constructor(opts: FakeDialectOpts = {}) {
    this.raiseOnConnect = opts.raiseOnConnect;
    this.execResult = opts.execResult ?? { columns: [], rows: [] };
  }

  async connect(_dsn: string, opts: { readOnly: boolean }): Promise<FakeConn> {
    this.connectedReadOnly = opts.readOnly;
    if (this.raiseOnConnect) {
      throw this.raiseOnConnect;
    }
    return this.conn;
  }
  async close(conn: FakeConn): Promise<void> {
    conn.closed = true;
  }
  async listTables(): Promise<unknown[]> {
    return [{ schema: "public", name: "users", kind: "table" }];
  }
  async getSchema(_conn: unknown, table: string): Promise<Record<string, unknown>> {
    return { table, columns: [], primary_key: [], foreign_keys: [] };
  }
  async sampleRows(): Promise<unknown[]> {
    return [{ id: 1 }];
  }
  async execute(): Promise<Record<string, unknown>> {
    return this.execResult;
  }
  validateReadOnly(): void {
    // Permissive stub; the real read-only gate is covered in postgres.test.ts.
  }
  async findColumns(): Promise<unknown[]> {
    return [{ schema: "public", table: "users", column: "email" }];
  }
  async searchValue(): Promise<Record<string, unknown>> {
    return {
      results: [{ schema: "public", table: "users", column: "email" }],
      truncated: false,
    };
  }
}

/** A pg-style auth error carrying the invalid_password SQLSTATE. */
function authError(): Error {
  return Object.assign(new Error("auth failed for u at h:5432 with SECRET"), { code: "28P01" });
}

beforeEach(() => {
  state.dialect = new FakeDialect();
});

describe("list_databases", () => {
  it("hides the dsn", async () => {
    const result = await new Handlers(cfgPath()).listDatabases();
    const blob = JSON.stringify(result);
    expect(blob).not.toContain("SECRET");
    expect(result.every((row) => !("dsn" in row))).toBe(true);
    expect(new Set(result.map((r) => r.name))).toEqual(new Set(["prod", "dev", "trusted"]));
  });
});

describe("reads connect read-only", () => {
  it("list_tables connects read-only and closes", async () => {
    const dialect = new FakeDialect();
    state.dialect = dialect;
    const result = await new Handlers(cfgPath()).listTables("prod");
    expect(dialect.connectedReadOnly).toBe(true);
    expect((result[0] as { name: string }).name).toBe("users");
    expect(dialect.conn.closed).toBe(true);
  });

  it("find_columns connects read-only and closes", async () => {
    const dialect = new FakeDialect();
    state.dialect = dialect;
    const result = await new Handlers(cfgPath()).findColumns("prod", "email");
    expect(dialect.connectedReadOnly).toBe(true);
    expect((result[0] as { column: string }).column).toBe("email");
    expect(dialect.conn.closed).toBe(true);
  });

  it("search_value connects read-only and closes", async () => {
    const dialect = new FakeDialect();
    state.dialect = dialect;
    const result = await new Handlers(cfgPath()).searchValue("prod", "x@y.com", ["users"]);
    expect(dialect.connectedReadOnly).toBe(true);
    expect((result.results as Array<{ table: string }>)[0]!.table).toBe("users");
    expect(result.truncated).toBe(false);
    expect(dialect.conn.closed).toBe(true);
  });

  it("execute_read_query connects read-only", async () => {
    const dialect = new FakeDialect({ execResult: { columns: ["id"], rows: [{ id: 1 }] } });
    state.dialect = dialect;
    const result = await new Handlers(cfgPath()).executeReadQuery("prod", "SELECT id FROM users");
    expect(dialect.connectedReadOnly).toBe(true);
    expect(result.rows).toEqual([{ id: 1 }]);
  });
});

describe("the write gate", () => {
  it("rejects a write to a read DB without connecting", async () => {
    const dialect = new FakeDialect();
    state.dialect = dialect;
    await expect(
      new Handlers(cfgPath()).executeWriteQuery("prod", "DELETE FROM users", true),
    ).rejects.toThrow(/read-only/);
    expect(dialect.connectedReadOnly).toBeNull();
  });

  it("rejects a write without consent", async () => {
    state.dialect = new FakeDialect();
    await expect(
      new Handlers(cfgPath()).executeWriteQuery("dev", "DELETE FROM users", false),
    ).rejects.toThrow(/user_consent/);
  });

  it("runs a consented write on a writable DB", async () => {
    const dialect = new FakeDialect({ execResult: { rows_affected: 2 } });
    state.dialect = dialect;
    const result = await new Handlers(cfgPath()).executeWriteQuery(
      "dev",
      "DELETE FROM users",
      true,
    );
    expect(dialect.connectedReadOnly).toBe(false);
    expect(result).toEqual({ rows_affected: 2 });
  });

  it("runs a yolo write without consent", async () => {
    const dialect = new FakeDialect({ execResult: { rows_affected: 1 } });
    state.dialect = dialect;
    const result = await new Handlers(cfgPath()).executeWriteQuery(
      "trusted",
      "DELETE FROM x",
      false,
    );
    expect(dialect.connectedReadOnly).toBe(false);
    expect(result).toEqual({ rows_affected: 1 });
  });

  it("WriteRejected is the thrown type", async () => {
    state.dialect = new FakeDialect();
    await expect(
      new Handlers(cfgPath()).executeWriteQuery("prod", "DELETE FROM users", true),
    ).rejects.toBeInstanceOf(WriteRejected);
  });
});

describe("set_yolo_mode", () => {
  it("persists to disk", async () => {
    const path = cfgPath();
    await new Handlers(path).setYoloMode("dev", true);
    const reloaded = JSON.parse(readFileSync(path, "utf-8")) as typeof CONFIG;
    const dev = reloaded.connections.find((c) => c.name === "dev")!;
    expect((dev as { yolo?: boolean }).yolo).toBe(true);
  });
});

describe("check_database", () => {
  it("reports OK", async () => {
    state.dialect = new FakeDialect();
    const result = await new Handlers(cfgPath()).checkDatabase("prod");
    expect(result[0]!.status).toBe("OK");
  });

  it("reports a sanitized cause when unreachable", async () => {
    state.dialect = new FakeDialect({ raiseOnConnect: authError() });
    const result = await new Handlers(cfgPath()).checkDatabase("prod");
    const entry = result[0]!;
    expect(entry.status).not.toBe("OK");
    expect(entry.category).toBe("AUTH_FAILED");
    expect(JSON.stringify(entry)).not.toContain("SECRET");
  });

  it("probes all when no name is given", async () => {
    state.dialect = new FakeDialect();
    const result = await new Handlers(cfgPath()).checkDatabase();
    expect(new Set(result.map((r) => r.database))).toEqual(new Set(["prod", "dev", "trusted"]));
  });
});

describe("connect failure on a normal tool", () => {
  it("surfaces a sanitized diagnostic", async () => {
    state.dialect = new FakeDialect({ raiseOnConnect: authError() });
    await expect(new Handlers(cfgPath()).listTables("prod")).rejects.toThrow();
    await expect(new Handlers(cfgPath()).listTables("prod")).rejects.not.toThrow(/SECRET/);
  });
});

describe("build_server smoke", () => {
  it("builds without error", () => {
    expect(buildServer(cfgPath())).not.toBeNull();
  });
});
