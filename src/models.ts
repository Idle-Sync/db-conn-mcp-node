/**
 * Zod schemas for `connections.json` — the single source of config truth.
 *
 * These types are database-agnostic: they describe *what* connections exist and how
 * they may be used, never *how* a specific database is queried (that lives in
 * `dialects/`). The `dsn` is a secret and must never be logged or returned by any
 * tool (Rule 6); use {@link publicView} for anything agent-facing.
 */

import { z } from "zod";

/** A connection's allowed access level. `read` is an absolute, native boundary. */
export const ModeSchema = z.enum(["read", "write"]);
export type Mode = z.infer<typeof ModeSchema>;

/** One database connection as declared in `connections.json`. */
export const ConnectionSchema = z.object({
  name: z.string(),
  dsn: z.string(), // secret — never logged, never returned by a tool
  mode: ModeSchema,
  yolo: z.boolean().default(false), // optional per-database write-consent bypass
});
export type Connection = z.infer<typeof ConnectionSchema>;

/** The whole `connections.json` document: `{"connections": [...]}`. */
export const ConfigSchema = z.object({
  connections: z.array(ConnectionSchema).default([]),
});
export type Config = z.infer<typeof ConfigSchema>;

/** The agent-safe projection of a connection (no `dsn`). */
export interface PublicConnection {
  name: string;
  mode: Mode;
  yolo: boolean;
}

/** Return the agent-safe projection of this connection (no `dsn`). */
export function publicView(conn: Connection): PublicConnection {
  return { name: conn.name, mode: conn.mode, yolo: conn.yolo };
}

/** Build an empty config document. */
export function emptyConfig(): Config {
  return { connections: [] };
}
