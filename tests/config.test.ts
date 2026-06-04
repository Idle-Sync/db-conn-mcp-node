/** Tests for config resolution, validation, lookup, and atomic persistence. */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as config from "../src/config.js";
import { ConfigError } from "../src/config.js";
import type { Config } from "../src/models.js";

function freshTmp(): string {
  return mkdtempSync(join(tmpdir(), "dbconn-cfg-"));
}

function writeJson(path: string, payload: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload), "utf-8");
  return path;
}

const VALID = {
  connections: [
    { name: "prod", dsn: "postgresql://u:p@h/prod", mode: "read" },
    { name: "dev", dsn: "postgres://u:p@h/dev", mode: "write", yolo: true },
  ],
};

let savedCwd: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedCwd = process.cwd();
  savedHome = process.env.HOME;
});

afterEach(() => {
  process.chdir(savedCwd);
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
});

describe("resolution order", () => {
  it("explicit path wins", () => {
    const explicit = writeJson(join(freshTmp(), "custom.json"), VALID);
    expect(config.resolvePath(explicit)).toBe(explicit);
  });

  it("explicit missing path errors", () => {
    expect(() => config.resolvePath(join(freshTmp(), "nope.json"))).toThrow(ConfigError);
  });

  it("prefers repo over global", () => {
    const tmp = freshTmp();
    process.chdir(tmp);
    process.env.HOME = join(tmp, "home");
    const repo = writeJson(join(tmp, "connections.json"), VALID);
    writeJson(join(tmp, "home", ".db-conn-mcp", "connections.json"), VALID);
    expect(config.resolvePath()).toBe(repo);
  });

  it("falls back to global", () => {
    const tmp = freshTmp();
    process.chdir(tmp);
    process.env.HOME = join(tmp, "home");
    const glob = writeJson(join(tmp, "home", ".db-conn-mcp", "connections.json"), VALID);
    expect(config.resolvePath()).toBe(glob);
  });

  it("none found errors with setup guidance", () => {
    const tmp = freshTmp();
    process.chdir(tmp);
    process.env.HOME = join(tmp, "empty-home");
    expect(() => config.resolvePath()).toThrow(/setup/);
  });
});

describe("load + validation", () => {
  it("loads a valid config", () => {
    const path = writeJson(join(freshTmp(), "c.json"), VALID);
    const cfg = config.load(path);
    expect(cfg.connections.map((c) => c.name)).toEqual(["prod", "dev"]);
    expect(cfg.connections[1]!.yolo).toBe(true);
  });

  it("rejects duplicate names", () => {
    const payload = {
      connections: [
        { name: "dup", dsn: "postgresql://h/a", mode: "read" },
        { name: "dup", dsn: "postgresql://h/b", mode: "read" },
      ],
    };
    const path = writeJson(join(freshTmp(), "c.json"), payload);
    expect(() => config.load(path)).toThrow(/dup/);
  });

  it("rejects an unknown scheme", () => {
    const payload = { connections: [{ name: "x", dsn: "mysql://h/a", mode: "read" }] };
    const path = writeJson(join(freshTmp(), "c.json"), payload);
    expect(() => config.load(path)).toThrow(/scheme/);
  });

  it("rejects a bad mode", () => {
    const payload = { connections: [{ name: "x", dsn: "postgresql://h/a", mode: "admin" }] };
    const path = writeJson(join(freshTmp(), "c.json"), payload);
    expect(() => config.load(path)).toThrow(ConfigError);
  });

  it("rejects malformed JSON", () => {
    const path = join(freshTmp(), "c.json");
    writeFileSync(path, "{not json", "utf-8");
    expect(() => config.load(path)).toThrow(ConfigError);
  });

  it("never leaks a dsn in a config error", () => {
    const secret = "postgresql://user:SUPERSECRET@host/db";
    const payload = {
      connections: [
        { name: "dup", dsn: secret, mode: "read" },
        { name: "dup", dsn: secret, mode: "read" },
      ],
    };
    const path = writeJson(join(freshTmp(), "c.json"), payload);
    try {
      config.load(path);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain("SUPERSECRET");
    }
  });
});

describe("lookup", () => {
  const cfg: Config = {
    connections: [{ name: "prod", dsn: "postgresql://h/p", mode: "read", yolo: false }],
  };

  it("gets by name", () => {
    expect(config.get(cfg, "prod").name).toBe("prod");
  });

  it("unknown name lists available", () => {
    expect(() => config.get(cfg, "missing")).toThrow(/prod/);
  });
});

describe("save + setYolo", () => {
  it("round-trips through save/load", () => {
    const path = join(freshTmp(), "c.json");
    const cfg: Config = {
      connections: [{ name: "dev", dsn: "postgresql://h/d", mode: "write", yolo: false }],
    };
    config.save(cfg, path);
    expect(config.load(path).connections[0]!.name).toBe("dev");
  });

  it("setYolo persists and survives reload", () => {
    const path = writeJson(join(freshTmp(), "c.json"), VALID);
    const updated = config.setYolo(path, "prod", true);
    expect(config.get(updated, "prod").yolo).toBe(true);
    expect(config.get(config.load(path), "prod").yolo).toBe(true);
  });

  it("setYolo on an unknown db errors", () => {
    const path = writeJson(join(freshTmp(), "c.json"), VALID);
    expect(() => config.setYolo(path, "ghost", true)).toThrow(/ghost/);
  });
});
