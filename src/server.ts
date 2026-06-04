/**
 * The MCP server: 10 tools + 1 prompt, plus transport wiring.
 *
 * Knows nothing about PostgreSQL. It wires the pure/abstract layers together: the
 * {@link Handlers} service (which uses `config`, the dialect registry, `safety`, and
 * `diagnostics`) onto MCP tools and a prompt.
 */

import { createServer, type IncomingMessage } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { resolvePath } from "./config.js";
import { Handlers } from "./handlers.js";
import { VERSION } from "./version.js";

export type Transport = "stdio" | "http";

/** Default bind for the (secondary) HTTP transport. */
const HTTP_HOST = "127.0.0.1";
const HTTP_PORT = 8000;
const HTTP_PATH = "/mcp";

/** The full connection-gotchas checklist exposed by the troubleshoot_connection prompt. */
export const TROUBLESHOOT_CHECKLIST = `Database connection troubleshooting checklist:

1. Host & port — is the host correct and the port open (Postgres default 5432)?
2. Server up — is the database process actually running and accepting connections?
3. Firewall / security groups — is traffic allowed from your machine to the server?
4. Docker — inside a container, \`localhost\` is the container itself, NOT the database
   container. Use the service name (compose) or the host gateway.
5. SSL — does the server require SSL? Add an appropriate mode, e.g. \`?sslmode=require\`.
6. Database name — correct spelling and case? Does the database exist yet?
7. Credentials — correct user/password? Does the role exist and may it log in?
8. Connection limits — is the server's \`max_connections\` exhausted by idle sessions?
9. DNS / VPN — can the hostname be resolved? Is a required VPN connected?
`;

/** Wrap any handler result as a single JSON text-content block. */
function asContent(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

/** Construct the McpServer with all 10 tools and the troubleshoot prompt. */
export function buildServer(configPath?: string | null): McpServer {
  const resolved = resolvePath(configPath ?? null);
  const handlers = new Handlers(resolved);
  const server = new McpServer({ name: "db-conn-mcp", version: VERSION });

  // ---- Exploration tools ---------------------------------------------------
  server.registerTool(
    "list_databases",
    {
      description: "List configured databases with their allowed mode and yolo flag (no DSN).",
    },
    async () => asContent(await handlers.listDatabases()),
  );

  server.registerTool(
    "list_tables",
    {
      description: "List all tables and views in the named database.",
      inputSchema: { database: z.string() },
    },
    async ({ database }) => asContent(await handlers.listTables(database)),
  );

  server.registerTool(
    "get_table_schema",
    {
      description: "Get columns, types, and primary/foreign keys for a table.",
      inputSchema: { database: z.string(), table: z.string() },
    },
    async ({ database, table }) => asContent(await handlers.getTableSchema(database, table)),
  );

  server.registerTool(
    "sample_table_rows",
    {
      description: "Fetch the first N rows of a table to learn its data shape.",
      inputSchema: { database: z.string(), table: z.string(), n: z.number().int().default(10) },
    },
    async ({ database, table, n }) => asContent(await handlers.sampleTableRows(database, table, n)),
  );

  // ---- Discovery / search tools --------------------------------------------
  server.registerTool(
    "find_columns",
    {
      description:
        "Find columns by name across all tables (fuzzy, case-insensitive substring). " +
        'e.g. pattern "email" matches user_email, EMAIL_ADDRESS. Use this to locate where ' +
        "a concept lives before querying.",
      inputSchema: { database: z.string(), pattern: z.string() },
    },
    async ({ database, pattern }) => asContent(await handlers.findColumns(database, pattern)),
  );

  server.registerTool(
    "search_value",
    {
      description:
        "Find WHERE a value appears across tables (fuzzy, case-insensitive substring). " +
        "Returns the tables/columns containing the value, with match counts and samples. " +
        "For speed on large databases, first narrow with list_tables/find_columns and pass " +
        "a `tables` shortlist; otherwise it scans all non-system tables (bounded, may " +
        "return partial results flagged `truncated`).",
      inputSchema: {
        database: z.string(),
        value: z.string(),
        tables: z.array(z.string()).nullable().optional(),
        limit_per_column: z.number().int().default(5),
      },
    },
    async ({ database, value, tables, limit_per_column }) =>
      asContent(await handlers.searchValue(database, value, tables ?? null, limit_per_column)),
  );

  // ---- Execution tools -----------------------------------------------------
  server.registerTool(
    "execute_read_query",
    {
      description: "Run a read-only SELECT query (enforced as a read-only transaction).",
      inputSchema: { database: z.string(), sql: z.string() },
    },
    async ({ database, sql }) => asContent(await handlers.executeReadQuery(database, sql)),
  );

  server.registerTool(
    "execute_write_query",
    {
      description:
        "Run an INSERT/UPDATE/DELETE/DDL statement on a write-mode database. " +
        "SAFETY: Only allowed if the database is mode=write. Unless the database has " +
        "yolo enabled, you MUST first read the target table and its schema, then show " +
        "the user the EXACT SQL you intend to run and ask for explicit permission. Only " +
        "call again with user_consent=true if the user clearly says yes.",
      inputSchema: {
        database: z.string(),
        sql: z.string(),
        user_consent: z.boolean().default(false),
      },
    },
    async ({ database, sql, user_consent }) =>
      asContent(await handlers.executeWriteQuery(database, sql, user_consent)),
  );

  // ---- Configuration tool --------------------------------------------------
  server.registerTool(
    "set_yolo_mode",
    {
      description:
        "Enable/disable yolo (skip the write-consent prompt) for one database, persisted.",
      inputSchema: { database: z.string(), enabled: z.boolean() },
    },
    async ({ database, enabled }) => asContent(await handlers.setYoloMode(database, enabled)),
  );

  // ---- Diagnostics tool ----------------------------------------------------
  server.registerTool(
    "check_database",
    {
      description: "Test connectivity for one database (or all) — returns OK or a sanitized cause.",
      inputSchema: { database: z.string().nullable().optional() },
    },
    async ({ database }) => asContent(await handlers.checkDatabase(database ?? null)),
  );

  // ---- Prompt --------------------------------------------------------------
  server.registerPrompt(
    "troubleshoot_connection",
    { description: "The full database-connection gotchas checklist." },
    () => ({
      messages: [{ role: "user", content: { type: "text", text: TROUBLESHOOT_CHECKLIST } }],
    }),
  );

  return server;
}

/** Read and JSON-parse a request body (POST); returns `undefined` for empty bodies. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  return text ? JSON.parse(text) : undefined;
}

/** Launch over stdio (the path MCP clients use). */
async function runStdio(configPath?: string | null): Promise<void> {
  const server = buildServer(configPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Launch over Streamable HTTP (stateless, one server+transport per request).
 *
 * This is the modern replacement for FastMCP's deprecated SSE transport; the Python
 * `--transport http` maps to SSE, this maps to Streamable HTTP at the same role.
 */
async function runHttp(configPath?: string | null): Promise<void> {
  // Fail fast on missing config before binding the port.
  resolvePath(configPath ?? null);
  const httpServer = createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith(HTTP_PATH)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Not found. Use ${HTTP_PATH}.` }));
      return;
    }
    const server = buildServer(configPath);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, await readJsonBody(req));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error.", detail: String(err) }));
      }
    }
  });
  httpServer.listen(HTTP_PORT, HTTP_HOST);
}

/** Launch the server over the chosen transport (`stdio` default, or `http`). */
export async function run(
  transport: Transport = "stdio",
  configPath?: string | null,
): Promise<void> {
  if (transport === "http") {
    await runHttp(configPath);
  } else {
    await runStdio(configPath);
  }
}
