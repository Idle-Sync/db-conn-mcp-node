/**
 * Resolve, load, validate, and save `connections.json`.
 *
 * Knows nothing about any specific database — only about where the config lives and
 * how to read/write it. Resolution order (first existing wins):
 *
 *   1. explicit path (`--config <path>`)
 *   2. `./connections.json` (repo-scoped)
 *   3. `~/.db-conn-mcp/connections.json` (global-scoped)
 *
 * All errors are thrown as {@link ConfigError} with actionable, **sanitized** messages
 * — never echoing a DSN or credentials (Rule 6).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { dialectFor, supportedSchemes } from "./dialects/registry.js";
import { ConfigSchema, type Config, type Connection } from "./models.js";

/** Filename used for both the repo- and global-scoped locations. */
export const CONFIG_FILENAME = "connections.json";

/** Thrown for missing/invalid config, with an actionable, sanitized message. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** The repo-scoped config path (`./connections.json`). */
export function repoConfigPath(): string {
  return join(process.cwd(), CONFIG_FILENAME);
}

/** The global-scoped config path (`~/.db-conn-mcp/connections.json`). */
export function globalConfigPath(): string {
  return join(homedir(), ".db-conn-mcp", CONFIG_FILENAME);
}

/**
 * Return the first config path that exists per the resolution order.
 *
 * Throws {@link ConfigError} with guidance (including `setup`) if none exist.
 */
export function resolvePath(explicit?: string | null): string {
  if (explicit != null) {
    if (!isFile(explicit)) {
      throw new ConfigError(
        `No config file at the path you passed with --config: ${explicit}. ` +
          "Create it, or run `db-conn-mcp setup` to generate one.",
      );
    }
    return explicit;
  }

  for (const candidate of [repoConfigPath(), globalConfigPath()]) {
    if (isFile(candidate)) {
      return candidate;
    }
  }

  throw new ConfigError(
    "No connections.json found. Looked in: " +
      `${repoConfigPath()} and ${globalConfigPath()}. ` +
      "Run `db-conn-mcp setup` to create one, or pass --config <path>.",
  );
}

/** Apply cross-field rules beyond the schema: unique names, known DSN schemes. */
function validate(config: Config): Config {
  const seen = new Set<string>();
  for (const conn of config.connections) {
    if (seen.has(conn.name)) {
      throw new ConfigError(`Duplicate connection name '${conn.name}'. Names must be unique.`);
    }
    seen.add(conn.name);
    try {
      dialectFor(conn.dsn);
    } catch {
      throw new ConfigError(
        `Connection '${conn.name}' uses an unsupported DSN scheme. ` +
          `Supported schemes: ${supportedSchemes().join(", ")}.`,
      );
    }
  }
  return config;
}

/** Resolve, parse, and validate the config. */
export function load(explicit?: string | null): Config {
  const path = resolvePath(explicit);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`${path} is not valid JSON: ${detail}.`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // Summarize without echoing field values (a value could be a DSN).
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid connections.json: ${problems}.`);
  }
  return validate(parsed.data);
}

/** Look up a connection by name; an unknown name lists the available names. */
export function get(config: Config, name: string): Connection {
  for (const conn of config.connections) {
    if (conn.name === name) {
      return conn;
    }
  }
  const available = config.connections.map((c) => c.name).join(", ") || "(none configured)";
  throw new ConfigError(`Unknown database '${name}'. Available: ${available}.`);
}

/** Serialize with stable key order and `yolo` always present (no field elided). */
function serialize(config: Config): string {
  const payload = {
    connections: config.connections.map((c) => ({
      name: c.name,
      dsn: c.dsn,
      mode: c.mode,
      yolo: c.yolo,
    })),
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

/** Atomically rewrite `connections.json` (temp file + rename). */
export function save(config: Config, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serialize(config), "utf-8");
  renameSync(tmp, path);
}

/** Persist the `yolo` flag for one named DB and return the updated config. */
export function setYolo(path: string, name: string, enabled: boolean): Config {
  const config = load(path);
  get(config, name).yolo = enabled; // throws ConfigError if the name is unknown
  save(config, path);
  return config;
}
