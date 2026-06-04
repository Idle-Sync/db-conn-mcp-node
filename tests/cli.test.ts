/**
 * Tests for the CLI: argument dispatch and the wizard's pure helpers.
 *
 * The interactive prompt loop's decision logic lives in pure, tested helpers; the
 * wizard's transactional behavior (commit-at-end, graceful Ctrl+C) is tested by driving
 * it with a scripted prompt. Dependencies the Python suite monkeypatches are swapped
 * here through the exported {@link hooks} seam.
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as cli from "../src/cli.js";
import { hooks, PromptCancelled, type ClientSpec, type Prompt } from "../src/cli.js";
import * as config from "../src/config.js";
import { VERSION } from "../src/version.js";

const CTRL_C = Symbol("ctrl-c");

/** A scripted prompt: yields each answer; a CTRL_C sentinel / exhaustion cancels. */
function scriptedInput(answers: Array<string | symbol>): Prompt {
  let i = 0;
  return async () => {
    if (i >= answers.length) {
      throw new PromptCancelled();
    }
    const value = answers[i++];
    if (typeof value === "symbol") {
      throw new PromptCancelled();
    }
    return value;
  };
}

function freshTmp(prefix = "dbconn-cli-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", orig);
  }
}

const ORIGINAL_HOOKS = { ...hooks };
let savedCwd: string;
let savedHome: string | undefined;
let logLines: string[];

beforeEach(() => {
  savedCwd = process.cwd();
  savedHome = process.env.HOME;
  // Isolate the global config at an empty temp HOME so tests never touch the real one.
  process.env.HOME = freshTmp("dbconn-home-");
  logLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(savedCwd);
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
  Object.assign(hooks, ORIGINAL_HOOKS);
});

// ---- argument parsing & dispatch ---------------------------------------------

describe("dispatch", () => {
  it("defaults to the stdio transport", async () => {
    const seen: unknown[] = [];
    hooks.runServer = async (...args: unknown[]) => {
      seen.push(...args);
    };
    expect(await cli.main([])).toBe(0);
    expect(seen).toEqual(["stdio", null]);
  });

  it("--version prints the version and exits 0", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    expect(await cli.main(["--version"])).toBe(0);
    expect(out.join("")).toContain(VERSION);
  });

  it("launches the server with transport + config", async () => {
    const seen: unknown[] = [];
    hooks.runServer = async (...args: unknown[]) => {
      seen.push(...args);
    };
    expect(await cli.main(["--transport", "http", "--config", "/tmp/c.json"])).toBe(0);
    expect(seen).toEqual(["http", "/tmp/c.json"]);
  });

  it("dispatches setup", async () => {
    let ran = false;
    hooks.runSetupWizard = async () => {
      ran = true;
      return 0;
    };
    expect(await cli.main(["setup"])).toBe(0);
    expect(ran).toBe(true);
  });

  it("exposes the management subcommands", () => {
    const names = cli.buildProgram().commands.map((c) => c.name());
    for (const name of ["setup", "status", "add", "clients", "check", "remove", "reset", "yolo"]) {
      expect(names).toContain(name);
    }
  });

  it("accepts --config before and after the subcommand", async () => {
    const seen: Array<string | undefined> = [];
    hooks.cmdStatus = (configArg?: string | null) => {
      seen.push(configArg ?? undefined);
      return 0;
    };
    await cli.main(["status", "--config", "x.json"]);
    await cli.main(["--config", "x.json", "status"]);
    expect(seen).toEqual(["x.json", "x.json"]);
  });

  it("dispatches management commands with their args", async () => {
    const seen: Record<string, unknown> = {};
    hooks.cmdStatus = (configArg?: string | null) => {
      seen.status = configArg;
      return 0;
    };
    hooks.cmdRemove = (_c, name: string) => {
      seen.remove = name;
      return 0;
    };
    hooks.cmdYolo = (_c, name: string, state: string) => {
      seen.yolo = [name, state];
      return 0;
    };
    expect(await cli.main(["--config", "c.json", "status"])).toBe(0);
    expect(await cli.main(["remove", "db1"])).toBe(0);
    expect(await cli.main(["yolo", "db1", "off"])).toBe(0);
    expect(seen).toEqual({ status: "c.json", remove: "db1", yolo: ["db1", "off"] });
  });

  it("dispatches clients --remove and check", async () => {
    const seen: Record<string, unknown> = {};
    hooks.cmdClients = async (_c, remove = false) => {
      seen.clients = remove;
      return 0;
    };
    hooks.cmdCheck = async (_c, name?: string | null) => {
      seen.check = name;
      return 0;
    };
    expect(await cli.main(["clients", "--remove"])).toBe(0);
    expect(await cli.main(["check", "db1"])).toBe(0);
    expect(seen).toEqual({ clients: true, check: "db1" });
  });

  it("exposes reset", () => {
    expect(cli.buildProgram().commands.map((c) => c.name())).toContain("reset");
  });
});

// ---- registerDatabase (pure, writes config) ---------------------------------

describe("registerDatabase", () => {
  it("writes a repo config", () => {
    process.chdir(freshTmp());
    const path = cli.registerDatabase("repo", "dev", "postgresql://u:p@h/dev", "write");
    expect(path).toBe(config.repoConfigPath());
    const written = JSON.parse(readFileSync(path, "utf-8")) as {
      connections: Array<Record<string, unknown>>;
    };
    expect(written.connections[0]!.name).toBe("dev");
    expect(written.connections[0]!.mode).toBe("write");
  });

  it("appends to an existing config", () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "a", "postgresql://h/a", "read");
    cli.registerDatabase("repo", "b", "postgresql://h/b", "read");
    const cfg = config.load(config.repoConfigPath());
    expect(cfg.connections.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("rejects an unknown scheme", () => {
    process.chdir(freshTmp());
    expect(() => cli.registerDatabase("repo", "x", "mysql://h/x", "read")).toThrow(/scheme/i);
  });

  it("rejects a duplicate name", () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "dup", "postgresql://h/a", "read");
    expect(() => cli.registerDatabase("repo", "dup", "postgresql://h/b", "read")).toThrow(/dup/);
  });

  it("rejects a duplicate dsn, naming the existing entry", () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "first", "postgresql://u:p@h/db", "read");
    expect(() => cli.registerDatabase("repo", "second", "postgresql://u:p@h/db", "write")).toThrow(
      /first/,
    );
  });

  it("duplicate-dsn error is sanitized", () => {
    process.chdir(freshTmp());
    const secret = "postgresql://u:SUPERSECRET@h/db";
    cli.registerDatabase("repo", "first", secret, "read");
    try {
      cli.registerDatabase("repo", "second", secret, "read");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("SUPERSECRET");
    }
  });
});

// ---- server launch + format-aware injection ---------------------------------

describe("serverLaunch", () => {
  it("prefers the installed script's absolute path", () => {
    const bindir = freshTmp("dbconn-bin-");
    const exe = join(bindir, "db-conn-mcp");
    writeFileSync(exe, "#!/bin/sh\n", "utf-8");
    chmodSync(exe, 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = bindir;
    try {
      const cfgPath = join(freshTmp(), "connections.json");
      const [command, args] = cli.serverLaunch(cfgPath);
      expect(command).toBe(exe);
      expect(args).toEqual(["--config", cfgPath]);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("falls back to the node interpreter when no script is found", () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const cfgPath = join(freshTmp(), "connections.json");
      const [command, args] = cli.serverLaunch(cfgPath);
      expect(command).toBe(process.execPath);
      expect(args[0]).toContain("cli");
      expect(args).toContain("--config");
      expect(args).toContain(cfgPath);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("injectEntry", () => {
  it("mcpServers format", () => {
    const out = cli.injectEntry({}, "mcpServers", "db-conn-mcp", "db-conn-mcp", ["--config", "x"]);
    expect((out.mcpServers as Record<string, unknown>)["db-conn-mcp"]).toEqual({
      command: "db-conn-mcp",
      args: ["--config", "x"],
    });
  });

  it("preserves existing entries", () => {
    const existing = { mcpServers: { other: { command: "y" } } };
    const out = cli.injectEntry(existing, "mcpServers", "db-conn-mcp", "db-conn-mcp", []);
    expect("other" in (out.mcpServers as object)).toBe(true);
    expect("db-conn-mcp" in (out.mcpServers as object)).toBe(true);
  });

  it("vscode format uses servers + type", () => {
    const out = cli.injectEntry({}, "vscode", "db-conn-mcp", "db-conn-mcp", ["--config", "x"]);
    expect((out.servers as Record<string, unknown>)["db-conn-mcp"]).toEqual({
      type: "stdio",
      command: "db-conn-mcp",
      args: ["--config", "x"],
    });
  });

  it("zed format uses context_servers + nested command", () => {
    const out = cli.injectEntry({}, "zed", "db-conn-mcp", "db-conn-mcp", ["--config", "x"]);
    expect((out.context_servers as Record<string, unknown>)["db-conn-mcp"]).toEqual({
      source: "custom",
      command: { path: "db-conn-mcp", args: ["--config", "x"] },
    });
  });
});

// ---- OS-aware client discovery ----------------------------------------------

describe("client specs", () => {
  it("claude path on windows", () => {
    process.env.APPDATA = "C:\\Users\\me\\AppData\\Roaming";
    withPlatform("win32", () => {
      const paths = cli.agentConfigPaths();
      expect(basename(paths.claude!)).toBe("claude_desktop_config.json");
      expect(paths.claude).toContain("Claude");
    });
  });

  it("cursor path present (linux)", () => {
    withPlatform("linux", () => {
      expect(basename(cli.agentConfigPaths().cursor!)).toBe("mcp.json");
    });
  });

  it("agy path present (linux)", () => {
    withPlatform("linux", () => {
      const paths = cli.agentConfigPaths();
      expect(basename(paths.agy!)).toBe("mcp_config.json");
      expect(paths.agy).toContain(".gemini");
    });
  });

  it("covers the expected clients", () => {
    withPlatform("linux", () => {
      const keys = new Set(cli.clientSpecs().map((s) => s.key));
      for (const key of [
        "claude",
        "cursor",
        "agy",
        "windsurf",
        "claude-code",
        "cline",
        "vscode",
        "zed",
      ]) {
        expect(keys.has(key)).toBe(true);
      }
    });
  });

  it("formats and paths", () => {
    withPlatform("linux", () => {
      const byKey = Object.fromEntries(cli.clientSpecs().map((s) => [s.key, s]));
      expect(byKey.vscode!.fmt).toBe("vscode");
      expect(basename(byKey.vscode!.path)).toBe("mcp.json");
      expect(byKey.zed!.fmt).toBe("zed");
      expect(basename(byKey.zed!.path)).toBe("settings.json");
      expect(byKey.windsurf!.fmt).toBe("mcpServers");
      expect(byKey.windsurf!.path).toContain(".codeium");
      expect(basename(byKey["claude-code"]!.path)).toBe(".claude.json");
      expect(basename(byKey.cline!.path)).toBe("cline_mcp_settings.json");
    });
  });

  it("detectedClients only returns existing files", () => {
    const tmp = freshTmp();
    const present: ClientSpec = {
      key: "a",
      label: "A",
      path: join(tmp, "a.json"),
      fmt: "mcpServers",
    };
    const missing: ClientSpec = {
      key: "b",
      label: "B",
      path: join(tmp, "b.json"),
      fmt: "mcpServers",
    };
    writeFileSync(present.path, "{}", "utf-8");
    hooks.clientSpecs = () => [present, missing];
    expect(cli.detectedClients().map((s) => s.key)).toEqual(["a"]);
  });
});

// ---- client selection parsing ------------------------------------------------

describe("parseClientSelection", () => {
  it("empty is none", () => {
    expect(cli.parseClientSelection("", 3)).toEqual([]);
    expect(cli.parseClientSelection("   ", 3)).toEqual([]);
  });
  it("the all keyword", () => {
    expect(cli.parseClientSelection("all", 3)).toEqual([0, 1, 2]);
    expect(cli.parseClientSelection("ALL", 2)).toEqual([0, 1]);
  });
  it("comma and space separated", () => {
    expect(cli.parseClientSelection("1,3", 3)).toEqual([0, 2]);
    expect(cli.parseClientSelection("1 3", 3)).toEqual([0, 2]);
    expect(cli.parseClientSelection("2", 3)).toEqual([1]);
  });
  it("dedups and sorts", () => {
    expect(cli.parseClientSelection("3,1,1", 3)).toEqual([0, 2]);
  });
  it("ignores out-of-range and garbage", () => {
    expect(cli.parseClientSelection("1, x, 9", 3)).toEqual([0]);
    expect(cli.parseClientSelection("0", 3)).toEqual([]);
  });
  it("scales to N clients", () => {
    expect(cli.parseClientSelection("all", 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(cli.parseClientSelection("2,5,8", 8)).toEqual([1, 4, 7]);
    expect(cli.parseClientSelection("8", 8)).toEqual([7]);
    expect(cli.parseClientSelection("9", 8)).toEqual([]);
    expect(cli.parseClientSelection("all", 0)).toEqual([]);
  });
});

// ---- wizard: transactional behavior & graceful Ctrl+C -----------------------

describe("setup wizard", () => {
  it("completes and saves", async () => {
    process.chdir(freshTmp());
    hooks.detectedClients = () => [];
    hooks.prompt = scriptedInput(["r", "mydb", "postgresql://h/db", "r"]);
    expect(await cli.runSetupWizard()).toBe(0);
    expect(config.load(config.repoConfigPath()).connections[0]!.name).toBe("mydb");
  });

  it("Ctrl+C at start saves nothing", async () => {
    process.chdir(freshTmp());
    hooks.prompt = scriptedInput([CTRL_C]);
    expect(await cli.runSetupWizard()).toBe(130);
    expect(() => config.load(config.repoConfigPath())).toThrow();
  });

  it("Ctrl+C after db prompts saves nothing and leaves clients untouched", async () => {
    const tmp = freshTmp();
    process.chdir(tmp);
    const clientCfg = join(tmp, "claude.json");
    writeFileSync(clientCfg, "{}", "utf-8");
    const fake: ClientSpec = {
      key: "claude",
      label: "Claude Desktop",
      path: clientCfg,
      fmt: "mcpServers",
    };
    hooks.detectedClients = () => [fake];
    hooks.prompt = scriptedInput(["r", "mydb", "postgresql://h/db", "r", CTRL_C]);
    expect(await cli.runSetupWizard()).toBe(130);
    expect(() => config.load(config.repoConfigPath())).toThrow();
    expect(readFileSync(clientCfg, "utf-8")).toBe("{}");
  });

  it("existing config shows status and the menu", async () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "mydb", "postgresql://h/a", "read");
    hooks.detectedClients = () => [];
    hooks.prompt = scriptedInput(["q"]);
    expect(await cli.runSetupWizard(config.repoConfigPath())).toBe(0);
    expect(logLines.join("\n")).toContain("mydb");
  });
});

// ---- management commands -----------------------------------------------------

describe("isInjected", () => {
  it("detects presence per container key", () => {
    const f = join(freshTmp(), "c.json");
    const spec: ClientSpec = { key: "x", label: "X", path: f, fmt: "mcpServers" };
    writeFileSync(f, JSON.stringify({ mcpServers: { "db-conn-mcp": {} } }), "utf-8");
    expect(cli.isInjected(spec)).toBe(true);
    writeFileSync(f, JSON.stringify({ mcpServers: { other: {} } }), "utf-8");
    expect(cli.isInjected(spec)).toBe(false);
    const vs: ClientSpec = { key: "v", label: "V", path: f, fmt: "vscode" };
    writeFileSync(f, JSON.stringify({ servers: { "db-conn-mcp": {} } }), "utf-8");
    expect(cli.isInjected(vs)).toBe(true);
    const missing: ClientSpec = {
      key: "m",
      label: "M",
      path: join(freshTmp(), "nope.json"),
      fmt: "mcpServers",
    };
    expect(cli.isInjected(missing)).toBe(false);
  });
});

describe("cmdStatus", () => {
  it("lists dbs without the dsn", () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "a", "postgresql://u:SECRET@h/a", "read");
    hooks.detectedClients = () => [];
    expect(cli.cmdStatus(config.repoConfigPath())).toBe(0);
    const out = logLines.join("\n");
    expect(out).toContain("a");
    expect(out).not.toContain("SECRET");
  });

  it("no config returns 1", () => {
    expect(cli.cmdStatus(join(freshTmp(), "nope.json"))).toBe(1);
  });
});

describe("cmdAdd", () => {
  it("appends", async () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "a", "postgresql://h/a", "read");
    hooks.detectedClients = () => [];
    hooks.prompt = scriptedInput(["b", "postgresql://h/b", "r"]);
    expect(await cli.cmdAdd(config.repoConfigPath())).toBe(0);
    expect(config.load(config.repoConfigPath()).connections.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("duplicate name returns 1", async () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "mydb", "postgresql://h/a", "read");
    hooks.detectedClients = () => [];
    hooks.prompt = scriptedInput(["mydb", "postgresql://h/b", "r"]);
    expect(await cli.cmdAdd(config.repoConfigPath())).toBe(1);
    expect(config.load(config.repoConfigPath()).connections.map((c) => c.name)).toEqual(["mydb"]);
  });
});

describe("cmdRemove", () => {
  it("removes a named connection", () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "a", "postgresql://h/a", "read");
    cli.registerDatabase("repo", "b", "postgresql://h/b", "read");
    expect(cli.cmdRemove(config.repoConfigPath(), "a")).toBe(0);
    expect(config.load(config.repoConfigPath()).connections.map((c) => c.name)).toEqual(["b"]);
  });

  it("unknown returns 1", () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "a", "postgresql://h/a", "read");
    expect(cli.cmdRemove(config.repoConfigPath(), "ghost")).toBe(1);
    expect(config.load(config.repoConfigPath()).connections.map((c) => c.name)).toEqual(["a"]);
  });
});

describe("cmdYolo", () => {
  it("toggles on and off", () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "a", "postgresql://h/a", "write");
    const p = config.repoConfigPath();
    expect(cli.cmdYolo(p, "a", "on")).toBe(0);
    expect(config.get(config.load(p), "a").yolo).toBe(true);
    expect(cli.cmdYolo(p, "a", "off")).toBe(0);
    expect(config.get(config.load(p), "a").yolo).toBe(false);
  });

  it("unknown returns 1", () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "a", "postgresql://h/a", "write");
    expect(cli.cmdYolo(config.repoConfigPath(), "ghost", "on")).toBe(1);
  });
});

describe("cmdClients inject/uninject", () => {
  it("injects the selected client", async () => {
    const tmp = freshTmp();
    process.chdir(tmp);
    cli.registerDatabase("repo", "a", "postgresql://h/a", "read");
    const clientCfg = join(tmp, "claude.json");
    writeFileSync(clientCfg, "{}", "utf-8");
    const fake: ClientSpec = {
      key: "claude",
      label: "Claude Desktop",
      path: clientCfg,
      fmt: "mcpServers",
    };
    hooks.detectedClients = () => [fake];
    hooks.prompt = scriptedInput(["1"]);
    expect(await cli.cmdClients(config.repoConfigPath())).toBe(0);
    const data = JSON.parse(readFileSync(clientCfg, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect("db-conn-mcp" in data.mcpServers).toBe(true);
  });

  it("remove_entry is pure and preserves siblings", () => {
    const out = cli.removeEntry(
      { mcpServers: { "db-conn-mcp": {}, other: {} } },
      "mcpServers",
      "db-conn-mcp",
    );
    expect("db-conn-mcp" in (out.mcpServers as object)).toBe(false);
    expect("other" in (out.mcpServers as object)).toBe(true);
    expect(cli.removeEntry({}, "mcpServers", "db-conn-mcp")).toEqual({});
  });

  it("--remove uninjects, keeping siblings", async () => {
    const tmp = freshTmp();
    const clientCfg = join(tmp, "claude.json");
    writeFileSync(
      clientCfg,
      JSON.stringify({ mcpServers: { "db-conn-mcp": { command: "x" }, keep: {} } }),
      "utf-8",
    );
    const fake: ClientSpec = {
      key: "claude",
      label: "Claude Desktop",
      path: clientCfg,
      fmt: "mcpServers",
    };
    hooks.detectedClients = () => [fake];
    hooks.prompt = scriptedInput(["1"]);
    expect(await cli.cmdClients(undefined, true)).toBe(0);
    const data = JSON.parse(readFileSync(clientCfg, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect("db-conn-mcp" in data.mcpServers).toBe(false);
    expect("keep" in data.mcpServers).toBe(true);
  });

  it("--remove is a clean no-op when nothing injected", async () => {
    const tmp = freshTmp();
    const clientCfg = join(tmp, "claude.json");
    writeFileSync(clientCfg, "{}", "utf-8");
    const fake: ClientSpec = {
      key: "claude",
      label: "Claude Desktop",
      path: clientCfg,
      fmt: "mcpServers",
    };
    hooks.detectedClients = () => [fake];
    expect(await cli.cmdClients(undefined, true)).toBe(0);
  });
});

// ---- check (doctor) ----------------------------------------------------------

describe("cmdCheck", () => {
  it("all OK returns 0", async () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "a", "postgresql://h/a", "read");
    hooks.Handlers = class {
      constructor(_path: string) {}
      async checkDatabase() {
        return [{ database: "a", status: "OK" }];
      }
    } as unknown as typeof hooks.Handlers;
    expect(await cli.cmdCheck(config.repoConfigPath(), null)).toBe(0);
    const out = logLines.join("\n");
    expect(out).toContain("a");
    expect(out).toContain("OK");
  });

  it("unreachable returns 2", async () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "a", "postgresql://h/a", "read");
    hooks.Handlers = class {
      constructor(_path: string) {}
      async checkDatabase() {
        return [{ database: "a", status: "UNREACHABLE", detail: "[AUTH_FAILED] ..." }];
      }
    } as unknown as typeof hooks.Handlers;
    expect(await cli.cmdCheck(config.repoConfigPath(), null)).toBe(2);
  });

  it("no config returns 1", async () => {
    expect(await cli.cmdCheck(join(freshTmp(), "nope.json"), null)).toBe(1);
  });
});

// ---- reset (delete the whole config) ----------------------------------------

describe("cmdReset", () => {
  it("deletes on confirm", async () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "a", "postgresql://h/a", "read");
    const p = config.repoConfigPath();
    hooks.prompt = scriptedInput(["y"]);
    expect(await cli.cmdReset(p)).toBe(0);
    expect(() => config.load(p)).toThrow();
  });

  it("keeps the file on decline", async () => {
    process.chdir(freshTmp());
    cli.registerDatabase("repo", "a", "postgresql://h/a", "read");
    const p = config.repoConfigPath();
    hooks.prompt = scriptedInput(["n"]);
    expect(await cli.cmdReset(p)).toBe(0);
    expect(config.load(p).connections[0]!.name).toBe("a");
  });

  it("no config is already fresh", async () => {
    expect(await cli.cmdReset(join(freshTmp(), "nope.json"))).toBe(0);
  });
});
