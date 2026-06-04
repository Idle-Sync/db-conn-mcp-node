#!/usr/bin/env node
/**
 * Command-line entry point: commander wiring for the server and the setup wizard.
 *
 * Two responsibilities, no DB knowledge:
 *   * `db-conn-mcp [--transport stdio|http] [--config PATH]` — launch the server.
 *   * `db-conn-mcp setup` — interactive wizard to register the first DB and
 *     (optionally) inject the server into detected MCP client configs. Each client
 *     carries its own config path and entry format (`mcpServers` for Claude
 *     Desktop/Cursor/Agy/Windsurf/Claude Code/Cline, `servers` for VS Code,
 *     `context_servers` for Zed) via {@link ClientSpec}.
 *
 * The wizard's *logic* (path resolution, DB registration, config injection) lives in
 * pure helpers so it stays testable; the interactive loop is a thin shell over them.
 * Only the connection *name* is ever echoed — never the DSN (Rule 6).
 *
 * Overridable seams (interactive prompt, client discovery, Handlers, server launch,
 * and top-level command dispatch) are gathered in {@link hooks} so tests can swap them
 * the way the Python suite monkeypatches module globals.
 */

import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { Argument, Command, CommanderError } from "commander";

import * as config from "./config.js";
import { dialectFor } from "./dialects/registry.js";
import { Handlers } from "./handlers.js";
import { emptyConfig, publicView, type Config } from "./models.js";
import { run } from "./server.js";
import { VERSION } from "./version.js";

export type Scope = "global" | "repo";

/** How an MCP client stores server entries. */
export type ClientFormat = "mcpServers" | "vscode" | "zed";

/** A prompt function: ask a question, resolve with the typed answer. */
export type Prompt = (question: string) => Promise<string>;

/** The console-script name (its absolute path is what we inject). */
const SERVER_SCRIPT = "db-conn-mcp";

/** Thrown when an interactive prompt is cancelled (Ctrl+C / EOF). */
export class PromptCancelled extends Error {}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// ---- Interactive input (overridable via hooks.prompt) ------------------------

let activeReadline: readline.Interface | null = null;
let readlineClosed = false;

/** The real, readline-backed prompt; cancels cleanly on Ctrl+C / EOF. */
const realPrompt: Prompt = (question) => {
  if (!activeReadline) {
    activeReadline = readline.createInterface({ input: process.stdin, output: process.stdout });
    readlineClosed = false;
    activeReadline.on("close", () => {
      readlineClosed = true;
    });
    activeReadline.on("SIGINT", () => activeReadline?.close());
  }
  if (readlineClosed) {
    return Promise.reject(new PromptCancelled());
  }
  return activeReadline.question(question).catch(() => Promise.reject(new PromptCancelled()));
};

/** Tear down the readline interface after an interactive command finishes. */
function closeInput(): void {
  if (activeReadline) {
    activeReadline.close();
    activeReadline = null;
  }
}

/** Ask one question through the active prompt seam. */
function ask(question: string): Promise<string> {
  return hooks.prompt(question);
}

/** Locate an executable on PATH (a minimal `shutil.which` / `which`). */
function whichSync(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here — keep looking
      }
    }
  }
  return null;
}

/**
 * Return a `[command, args]` an MCP client can use to launch this server.
 *
 * Prefers the **absolute path** of the installed console script (`whichSync`), which
 * resolves whether the install is global/npx or a project-local `node_modules/.bin` —
 * so the client never needs the script on its own PATH. Falls back to the current Node
 * interpreter running this CLI file directly.
 */
export function serverLaunch(configPath: string): [string, string[]] {
  const exe = whichSync(SERVER_SCRIPT);
  if (exe) {
    return [exe, ["--config", configPath]];
  }
  return [process.execPath, [fileURLToPath(import.meta.url), "--config", configPath]];
}

// ---- Pure helpers (tested) ---------------------------------------------------

/** Resolve a setup scope to its `connections.json` path. */
export function scopeToPath(scope: Scope): string {
  return scope === "global" ? config.globalConfigPath() : config.repoConfigPath();
}

/** Return the scoped config path and its current contents (empty if absent). */
function loadScope(scope: Scope): [string, Config] {
  const path = scopeToPath(scope);
  const cfg = isFile(path) ? config.load(path) : emptyConfig();
  return [path, cfg];
}

/**
 * Validate a candidate connection against `cfg`; throw `Error` if invalid.
 *
 * Checks: known DSN scheme, unique name, and unique connection string. The DSN is
 * never echoed in any error (Rule 6) — duplicate-DSN errors name the existing entry.
 */
export function ensureNewConnection(cfg: Config, name: string, dsn: string): void {
  dialectFor(dsn); // validates the scheme; throws naming supported schemes
  if (cfg.connections.some((c) => c.name === name)) {
    throw new Error(`A connection named '${name}' already exists.`);
  }
  const existing = cfg.connections.find((c) => c.dsn === dsn);
  if (existing) {
    throw new Error(
      `That connection string is already registered as '${existing.name}'. ` +
        "Use that name, or remove it first if you want to re-add it.",
    );
  }
}

/**
 * Validate and append a connection to the scoped config; return its path.
 *
 * Throws `Error` for an unknown DSN scheme, a duplicate name, or a duplicate DSN.
 */
export function registerDatabase(
  scope: Scope,
  name: string,
  dsn: string,
  mode: "read" | "write",
  yolo = false,
): string {
  const [path, cfg] = loadScope(scope);
  ensureNewConnection(cfg, name, dsn);
  cfg.connections.push({ name, dsn, mode, yolo });
  config.save(cfg, path);
  return path;
}

/** One MCP client: where its config lives and which entry format it uses. */
export interface ClientSpec {
  key: string; // short id, e.g. "vscode"
  label: string; // human-facing name
  path: string; // config file (may not exist yet)
  fmt: ClientFormat;
}

/** Container key (top-level JSON object) each format stores server entries under. */
const CONTAINER_KEY: Record<ClientFormat, string> = {
  mcpServers: "mcpServers",
  vscode: "servers",
  zed: "context_servers",
};

/** Build a single server entry in the shape the given client format expects. */
function buildEntry(fmt: ClientFormat, command: string, args: string[]): Record<string, unknown> {
  if (fmt === "vscode") {
    return { type: "stdio", command, args };
  }
  if (fmt === "zed") {
    return { source: "custom", command: { path: command, args } };
  }
  return { command, args }; // mcpServers (Claude/Cursor/Windsurf/...)
}

/** Insert/overwrite the server entry under the format's container key, preserving the rest. */
export function injectEntry(
  existing: Record<string, unknown>,
  fmt: ClientFormat,
  name: string,
  command: string,
  args: string[],
): Record<string, unknown> {
  const key = CONTAINER_KEY[fmt];
  const container = (existing[key] as Record<string, unknown> | undefined) ?? {};
  container[name] = buildEntry(fmt, command, args);
  existing[key] = container;
  return existing;
}

/** Delete the server entry from the format's container key (no-op if absent). */
export function removeEntry(
  existing: Record<string, unknown>,
  fmt: ClientFormat,
  name: string,
): Record<string, unknown> {
  const container = existing[CONTAINER_KEY[fmt]];
  if (container && typeof container === "object" && !Array.isArray(container)) {
    delete (container as Record<string, unknown>)[name];
  }
  return existing;
}

/** OS-aware specs for known MCP clients (config files may not exist yet). */
export function clientSpecs(): ClientSpec[] {
  const home = homedir();
  const appdata = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  let claude: string;
  let vscodeUser: string;
  let zed: string;
  if (process.platform === "win32") {
    claude = join(appdata, "Claude", "claude_desktop_config.json");
    vscodeUser = join(appdata, "Code", "User");
    zed = join(appdata, "Zed", "settings.json");
  } else if (process.platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    claude = join(support, "Claude", "claude_desktop_config.json");
    vscodeUser = join(support, "Code", "User");
    zed = join(home, ".config", "zed", "settings.json");
  } else {
    claude = join(home, ".config", "Claude", "claude_desktop_config.json");
    vscodeUser = join(home, ".config", "Code", "User");
    zed = join(home, ".config", "zed", "settings.json");
  }
  const cline = join(
    vscodeUser,
    "globalStorage",
    "saoudrizwan.claude-dev",
    "settings",
    "cline_mcp_settings.json",
  );
  return [
    { key: "claude", label: "Claude Desktop", path: claude, fmt: "mcpServers" },
    { key: "cursor", label: "Cursor", path: join(home, ".cursor", "mcp.json"), fmt: "mcpServers" },
    // Agy (Google Antigravity) — unified MCP config shared by its CLI and IDE.
    {
      key: "agy",
      label: "Agy (Antigravity)",
      path: join(home, ".gemini", "config", "mcp_config.json"),
      fmt: "mcpServers",
    },
    {
      key: "windsurf",
      label: "Windsurf",
      path: join(home, ".codeium", "windsurf", "mcp_config.json"),
      fmt: "mcpServers",
    },
    { key: "claude-code", label: "Claude Code", path: join(home, ".claude.json"), fmt: "mcpServers" },
    { key: "cline", label: "Cline", path: cline, fmt: "mcpServers" },
    { key: "vscode", label: "VS Code", path: join(vscodeUser, "mcp.json"), fmt: "vscode" },
    { key: "zed", label: "Zed", path: zed, fmt: "zed" },
  ];
}

/** Back-compat view: `{client_key: config_path}` for all known clients. */
export function agentConfigPaths(): Record<string, string> {
  return Object.fromEntries(clientSpecs().map((s) => [s.key, s.path]));
}

/** The subset of {@link clientSpecs} whose config file actually exists. */
export function detectedClients(): ClientSpec[] {
  return hooks.clientSpecs().filter((s) => isFile(s.path));
}

/** Whether `name` is already registered under `spec`'s container key. */
export function isInjected(spec: ClientSpec, name = "db-conn-mcp"): boolean {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(spec.path, "utf-8"));
  } catch {
    return false;
  }
  if (!data || typeof data !== "object") {
    return false;
  }
  const container = (data as Record<string, unknown>)[CONTAINER_KEY[spec.fmt]];
  return Boolean(container) && typeof container === "object" && name in (container as object);
}

/**
 * Parse a user selection string into sorted, unique 0-based indices.
 *
 * Accepts `"all"` (case-insensitive), comma/space-separated 1-based numbers
 * (e.g. `"1,3"` or `"1 3"`), or empty for none. Out-of-range and non-numeric tokens
 * are ignored so a typo never injects into the wrong client.
 */
export function parseClientSelection(raw: string, count: number): number[] {
  const text = raw.trim().toLowerCase();
  if (!text) {
    return [];
  }
  if (text === "all") {
    return Array.from({ length: count }, (_, i) => i);
  }
  const chosen = new Set<number>();
  for (const token of text.split(/[,\s]+/)) {
    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n >= 1 && n <= count) {
        chosen.add(n - 1);
      }
    }
  }
  return [...chosen].sort((a, b) => a - b);
}

// ---- Shared interactive building blocks --------------------------------------

/** Return the config path that resolves (explicit/repo/global), or null. */
function existingConfig(configArg?: string | null): string | null {
  try {
    return config.resolvePath(configArg ?? null);
  } catch (err) {
    if (err instanceof config.ConfigError) {
      return null;
    }
    throw err;
  }
}

/** Prompt for where a brand-new config should live. */
async function askScope(): Promise<Scope> {
  const scope = (await ask("Config scope - [g]lobal or [r]epo? (g/r): ")).trim().toLowerCase() || "g";
  return scope.startsWith("r") ? "repo" : "global";
}

/** List detected MCP clients (flagging already-injected) and return the picks. */
async function chooseInjectionTargets(): Promise<ClientSpec[]> {
  const detected = hooks.detectedClients();
  if (detected.length === 0) {
    console.log(
      "\nNo MCP client configs detected (looked for: " +
        hooks
          .clientSpecs()
          .map((s) => s.label)
          .join(", ") +
        ").",
    );
    return [];
  }

  console.log("\nDetected MCP client config(s):");
  detected.forEach((spec, i) => {
    const marker = isInjected(spec) ? " [already injected]" : "";
    console.log(`  ${i + 1}. ${spec.label} [${spec.fmt}]${marker}: ${spec.path}`);
  });
  const raw = await ask("Inject db-conn-mcp into which? (e.g. 1,3 or 'all'; Enter to skip): ");
  const chosen = parseClientSelection(raw, detected.length).map((i) => detected[i]!);
  if (chosen.length === 0) {
    console.log("No clients selected.");
  }
  return chosen;
}

/** Read-merge-write a server entry into one client's config, in its own format. */
function injectIntoClient(spec: ClientSpec, command: string, args: string[]): void {
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(readFileSync(spec.path, "utf-8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const updated = injectEntry(existing, spec.fmt, "db-conn-mcp", command, args);
  writeFileSync(spec.path, JSON.stringify(updated, null, 2) + "\n", "utf-8");
  console.log(`  Updated ${spec.label} config.`);
}

/** Choose clients and inject the server (pointed at `path`) into each. */
async function injectClientsInteractive(path: string): Promise<void> {
  const chosen = await chooseInjectionTargets();
  const [command, args] = serverLaunch(path);
  for (const spec of chosen) {
    injectIntoClient(spec, command, args);
  }
}

/**
 * Prompt for one database, validate, gather injection, then commit.
 *
 * Transactional: nothing is written until the end, so cancelling saves nothing.
 * Returns true if a connection was added, false on a validation error.
 */
async function addConnectionInteractive(path: string): Promise<boolean> {
  const cfg = isFile(path) ? config.load(path) : emptyConfig();
  const name = (await ask("Connection name: ")).trim();
  const dsn = (await ask("DSN (e.g. postgresql://user:pass@host:5432/db): ")).trim();
  const mode = (await ask("Mode - [r]ead or [w]rite? (r/w): ")).trim().toLowerCase();
  const modeName = mode.startsWith("w") ? "write" : "read";

  try {
    ensureNewConnection(cfg, name, dsn);
  } catch (err) {
    console.log(`Could not add: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  const chosen = await chooseInjectionTargets();
  cfg.connections.push({ name, dsn, mode: modeName, yolo: false });
  config.save(cfg, path);
  // Echo only the name — never the DSN (Rule 6).
  console.log(`Registered '${name}' (${modeName}) -> ${path}`);
  const [command, args] = serverLaunch(path);
  for (const spec of chosen) {
    injectIntoClient(spec, command, args);
  }
  return true;
}

/** Print configured databases (no DSN) and per-client injection state. */
function printStatus(path: string): void {
  const cfg = config.load(path);
  console.log(`Config: ${path}`);
  console.log("Databases:");
  if (cfg.connections.length === 0) {
    console.log("  (none)");
  }
  for (const c of cfg.connections) {
    const view = publicView(c);
    console.log(`  - ${view.name}  (mode=${view.mode}, yolo=${view.yolo})`);
  }

  console.log("\nMCP clients:");
  const detected = hooks.detectedClients();
  if (detected.length === 0) {
    console.log("  (none detected)");
  }
  for (const spec of detected) {
    console.log(`  - ${spec.label}: ${isInjected(spec) ? "injected" : "not injected"}`);
  }
}

// ---- Command handlers --------------------------------------------------------

/**
 * Guided setup. First run registers a database; if already configured, shows status
 * and offers follow-up actions. Ctrl+C / EOF cancels cleanly (nothing saved).
 */
export async function runSetupWizard(configArg?: string | null): Promise<number> {
  try {
    const existing = existingConfig(configArg);
    if (existing !== null) {
      console.log("db-conn-mcp is already configured.\n");
      printStatus(existing);
      return await setupMenu(existing);
    }
    console.log("db-conn-mcp setup");
    const path = scopeToPath(await askScope());
    return (await addConnectionInteractive(path)) ? 0 : 1;
  } catch (err) {
    if (err instanceof PromptCancelled) {
      console.log("\nCancelled. Nothing was saved.");
      return 130;
    }
    throw err;
  } finally {
    closeInput();
  }
}

/** Offer follow-up actions when a config already exists. */
async function setupMenu(path: string): Promise<number> {
  for (;;) {
    const choice = (await ask("\nNext: [a]dd database, [c]lients, [q]uit? (a/c/q): "))
      .trim()
      .toLowerCase();
    if (choice.startsWith("a")) {
      await addConnectionInteractive(path);
    } else if (choice.startsWith("c")) {
      await injectClientsInteractive(path);
    } else {
      return 0;
    }
  }
}

/** Show configured databases and MCP client injection state. */
export function cmdStatus(configArg?: string | null): number {
  const path = existingConfig(configArg);
  if (path === null) {
    console.log("No configuration found. Run `db-conn-mcp setup` to create one.");
    return 1;
  }
  printStatus(path);
  return 0;
}

/** Add another database connection (creating the config if none exists yet). */
export async function cmdAdd(configArg?: string | null): Promise<number> {
  try {
    const path = existingConfig(configArg) ?? scopeToPath(await askScope());
    return (await addConnectionInteractive(path)) ? 0 : 1;
  } catch (err) {
    if (err instanceof PromptCancelled) {
      console.log("\nCancelled. Nothing was saved.");
      return 130;
    }
    throw err;
  } finally {
    closeInput();
  }
}

/** Inject db-conn-mcp into chosen MCP clients, or uninject with `remove=true`. */
export async function cmdClients(configArg?: string | null, remove = false): Promise<number> {
  try {
    if (remove) {
      return await uninjectInteractive();
    }
    const path = existingConfig(configArg);
    if (path === null) {
      console.log("No configuration found. Run `db-conn-mcp setup` first.");
      return 1;
    }
    await injectClientsInteractive(path);
    return 0;
  } catch (err) {
    if (err instanceof PromptCancelled) {
      console.log("\nCancelled.");
      return 130;
    }
    throw err;
  } finally {
    closeInput();
  }
}

/** List clients that currently have db-conn-mcp and remove it from the chosen ones. */
async function uninjectInteractive(): Promise<number> {
  const injected = hooks.detectedClients().filter((s) => isInjected(s));
  if (injected.length === 0) {
    console.log("db-conn-mcp is not injected into any detected MCP client.");
    return 0;
  }
  console.log("Clients with db-conn-mcp injected:");
  injected.forEach((spec, i) => {
    console.log(`  ${i + 1}. ${spec.label} [${spec.fmt}]: ${spec.path}`);
  });
  const raw = await ask("Remove db-conn-mcp from which? (e.g. 1,3 or 'all'; Enter to skip): ");
  const chosen = parseClientSelection(raw, injected.length).map((i) => injected[i]!);
  if (chosen.length === 0) {
    console.log("Nothing removed.");
    return 0;
  }
  for (const spec of chosen) {
    uninjectFromClient(spec);
  }
  return 0;
}

/** Remove the db-conn-mcp entry from one client's config, preserving the rest. */
function uninjectFromClient(spec: ClientSpec): void {
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(readFileSync(spec.path, "utf-8")) as Record<string, unknown>;
  } catch {
    return;
  }
  removeEntry(existing, spec.fmt, "db-conn-mcp");
  writeFileSync(spec.path, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  console.log(`  Removed from ${spec.label} config.`);
}

/**
 * Probe connectivity for one database (or all) and print a sanitized result.
 *
 * Exit code: 0 if every probed database is reachable, 2 if any is unreachable.
 */
export async function cmdCheck(configArg?: string | null, name?: string | null): Promise<number> {
  const path = existingConfig(configArg);
  if (path === null) {
    console.log("No configuration found. Run `db-conn-mcp setup` first.");
    return 1;
  }
  let results: Array<Record<string, unknown>>;
  try {
    results = await new hooks.Handlers(path).checkDatabase(name ?? null);
  } catch (err) {
    if (err instanceof config.ConfigError) {
      console.log(err.message);
      return 1;
    }
    throw err;
  }
  let allOk = true;
  for (const entry of results) {
    if (entry.status === "OK") {
      console.log(`  ${entry.database}: OK`);
    } else {
      allOk = false;
      console.log(`  ${entry.database}: ${entry.detail ?? entry.status}`);
    }
  }
  return allOk ? 0 : 2;
}

/** Remove a database connection by name. */
export function cmdRemove(configArg: string | null | undefined, name: string): number {
  const path = existingConfig(configArg);
  if (path === null) {
    console.log("No configuration found.");
    return 1;
  }
  const cfg = config.load(path);
  if (!cfg.connections.some((c) => c.name === name)) {
    const available = cfg.connections.map((c) => c.name).join(", ") || "(none)";
    console.log(`No connection named '${name}'. Available: ${available}.`);
    return 1;
  }
  cfg.connections = cfg.connections.filter((c) => c.name !== name);
  config.save(cfg, path);
  console.log(`Removed '${name}' from ${path}.`);
  return 0;
}

/** Delete the whole `connections.json` (remove ALL connections) for a fresh slate. */
export async function cmdReset(configArg?: string | null): Promise<number> {
  const path = existingConfig(configArg);
  if (path === null) {
    console.log("No configuration found — already fresh.");
    return 0;
  }
  let confirm: string;
  try {
    confirm = (await ask(`Delete ALL connections by removing ${path}? (y/N): `)).trim().toLowerCase();
  } catch (err) {
    if (err instanceof PromptCancelled) {
      console.log("\nCancelled. Nothing deleted.");
      return 130;
    }
    throw err;
  } finally {
    closeInput();
  }
  if (!confirm.startsWith("y")) {
    console.log("Cancelled. Nothing deleted.");
    return 0;
  }
  unlinkSync(path);
  console.log(`Removed all connections (deleted ${path}). Run \`db-conn-mcp setup\` to start fresh.`);
  return 0;
}

/** Enable/disable yolo (write-consent bypass) for one database, persisted. */
export function cmdYolo(configArg: string | null | undefined, name: string, state: string): number {
  const path = existingConfig(configArg);
  if (path === null) {
    console.log("No configuration found.");
    return 1;
  }
  const enabled = state === "on";
  let updated: Config;
  try {
    updated = config.setYolo(path, name, enabled);
  } catch (err) {
    if (err instanceof config.ConfigError) {
      console.log(err.message);
      return 1;
    }
    throw err;
  }
  console.log(`Set yolo=${enabled ? "on" : "off"} for '${name}' (persisted to ${path}).`);
  if (enabled && config.get(updated, name).mode !== "write") {
    console.log("Note: yolo only affects write-mode databases; this one is read-only.");
  }
  return 0;
}

/**
 * Overridable seams. Internal callers and the parser dispatch through this object so
 * tests can swap dependencies the way the Python suite monkeypatches module globals.
 */
export const hooks = {
  prompt: realPrompt as Prompt,
  clientSpecs,
  detectedClients,
  Handlers,
  runServer: run,
  runSetupWizard,
  cmdStatus,
  cmdAdd,
  cmdClients,
  cmdCheck,
  cmdRemove,
  cmdYolo,
  cmdReset,
};

// ---- Parser ------------------------------------------------------------------

/** Build the commander program: server flags plus the management subcommands. */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("db-conn-mcp")
    .description("A dead-simple, self-hosted MCP server for querying databases.")
    .version(`db-conn-mcp ${VERSION}`, "-v, --version", "Show the installed version and exit.")
    .option("--config <path>", "Explicit path to connections.json (overrides repo/global lookup).")
    .option(
      "--transport <transport>",
      "MCP transport to launch when no subcommand is given (stdio|http).",
      "stdio",
    )
    .enablePositionalOptions()
    .exitOverride();

  // `--config` is shared so it works both before and after a subcommand.
  const withConfig = (cmd: Command): Command =>
    cmd
      .exitOverride()
      .option("--config <path>", "Explicit path to connections.json (overrides repo/global).");
  const cfgOf = (command: Command): string | undefined =>
    command.optsWithGlobals().config as string | undefined;

  withConfig(
    program.command("setup").description("Guided setup; shows status if already configured."),
  ).action(async (_opts, command: Command) => {
    process.exitCode = await hooks.runSetupWizard(cfgOf(command));
  });

  withConfig(
    program.command("status").description("Show configured databases and MCP client injection state."),
  ).action((_opts, command: Command) => {
    process.exitCode = hooks.cmdStatus(cfgOf(command));
  });

  withConfig(program.command("add").description("Add another database connection.")).action(
    async (_opts, command: Command) => {
      process.exitCode = await hooks.cmdAdd(cfgOf(command));
    },
  );

  withConfig(
    program
      .command("clients")
      .description("Inject (or with --remove, uninject) db-conn-mcp into MCP clients.")
      .option("--remove", "Remove db-conn-mcp from clients instead of adding."),
  ).action(async (opts: { remove?: boolean }, command: Command) => {
    process.exitCode = await hooks.cmdClients(cfgOf(command), Boolean(opts.remove));
  });

  withConfig(
    program
      .command("check")
      .description("Probe connectivity for one database (or all); sanitized result.")
      .argument("[name]", "Database to check; omit to check all."),
  ).action(async (name: string | undefined, _opts, command: Command) => {
    process.exitCode = await hooks.cmdCheck(cfgOf(command), name ?? null);
  });

  withConfig(
    program
      .command("remove")
      .description("Remove a database connection by name.")
      .argument("<name>", "The connection name to remove."),
  ).action((name: string, _opts, command: Command) => {
    process.exitCode = hooks.cmdRemove(cfgOf(command), name);
  });

  withConfig(
    program
      .command("reset")
      .description("Remove ALL connections (delete connections.json) for a fresh slate."),
  ).action(async (_opts, command: Command) => {
    process.exitCode = await hooks.cmdReset(cfgOf(command));
  });

  withConfig(
    program
      .command("yolo")
      .description("Enable/disable yolo (write-consent bypass) for one database.")
      .argument("<name>", "The database name.")
      .addArgument(new Argument("<state>", "Turn yolo on or off.").choices(["on", "off"])),
  ).action((name: string, state: string, _opts, command: Command) => {
    process.exitCode = hooks.cmdYolo(cfgOf(command), name, state);
  });

  // No subcommand -> run the server.
  program.action(async (opts: { transport?: string; config?: string }) => {
    const transport = opts.transport === "http" ? "http" : "stdio";
    try {
      await hooks.runServer(transport, opts.config ?? null);
    } catch (err) {
      if (err instanceof config.ConfigError) {
        console.log(err.message);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  });

  return program;
}

/** CLI entry point. Returns the process exit code. */
export async function main(argv?: string[]): Promise<number> {
  process.exitCode = 0;
  const program = buildProgram();
  try {
    await program.parseAsync(argv, argv ? { from: "user" } : undefined);
  } catch (err) {
    if (err instanceof CommanderError) {
      // --version / --help write their output, then throw with exitCode 0.
      return err.exitCode;
    }
    throw err;
  }
  return Number(process.exitCode ?? 0);
}

// Execute when run directly (not when imported by tests). realpath both sides so a
// symlinked global/npx bin still resolves to this file.
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
