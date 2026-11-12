import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  LAUNCH_COMMAND_ENV,
  PACKAGE_NAME,
  UV_MISSING_MESSAGE,
  findUvx,
  launchCommand,
  packageVersion,
  run,
  uvxArguments,
} from "../lib/launcher.js";

const isWindows = process.platform === "win32";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "db-conn-mcp-launcher-"));
}

/** A fake `uvx` that records its arguments and launch variable, then exits 3. */
function fakeUvx(dir) {
  const record = join(dir, "record.json");
  const script = join(dir, "uvx");
  writeFileSync(
    script,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args: process.argv.slice(2),
  launch: process.env.${LAUNCH_COMMAND_ENV},
}));
process.exit(3);
`,
  );
  chmodSync(script, 0o755);
  return record;
}

test("the launch variable keeps the name the Python server reads", () => {
  assert.equal(LAUNCH_COMMAND_ENV, "DB_CONN_MCP_LAUNCH_COMMAND");
});

test("uvx runs PyPI's db-conn-mcp pinned to this version with the user's arguments", () => {
  assert.deepEqual(uvxArguments("0.8.2", ["setup", "--config", "c.json"]), [
    "--from",
    "db-conn-mcp==0.8.2",
    "db-conn-mcp",
    "setup",
    "--config",
    "c.json",
  ]);
});

test("the npm version is a real version number", () => {
  assert.match(packageVersion(), /^\d+\.\d+\.\d+$/);
});

test("on macOS and Linux the client runs npx by absolute path when it sits next to node", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "npx"), "");

  assert.deepEqual(launchCommand("0.8.2", "linux", join(dir, "node")), [
    join(dir, "npx"),
    "-y",
    `${PACKAGE_NAME}@0.8.2`,
  ]);
});

test("without npx next to node, the client runs npx from its PATH", () => {
  assert.deepEqual(launchCommand("0.8.2", "darwin", join(tempDir(), "node")), [
    "npx",
    "-y",
    `${PACKAGE_NAME}@0.8.2`,
  ]);
});

test("on Windows the client runs npx through cmd", () => {
  assert.deepEqual(launchCommand("0.8.2", "win32"), [
    "cmd",
    "/c",
    "npx",
    "-y",
    `${PACKAGE_NAME}@0.8.2`,
  ]);
});

test("uvx is found on PATH", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "uvx"), "");

  assert.equal(findUvx({ PATH: dir }, "linux", tempDir()), join(dir, "uvx"));
});

test("uvx is found where uv's installer puts it when PATH leaves it out", () => {
  const home = tempDir();
  const installed = join(home, ".local", "bin");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "uvx"), "");

  assert.equal(findUvx({ PATH: "" }, "linux", home), join(installed, "uvx"));
});

test("uvx.exe is the name looked for on Windows", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "uvx.exe"), "");

  assert.equal(findUvx({ Path: dir }, "win32", tempDir()), join(dir, "uvx.exe"));
});

test("no uvx anywhere is reported as missing", () => {
  assert.equal(findUvx({ PATH: tempDir() }, "linux", tempDir()), null);
});

test("without uv, run explains how to install it and exits 1", async () => {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => written.push(String(chunk));
  try {
    assert.equal(await run(["setup"], { PATH: tempDir() }, tempDir()), 1);
  } finally {
    process.stderr.write = original;
  }
  assert.equal(written.join(""), UV_MISSING_MESSAGE);
});

test(
  "run passes arguments to uvx, names npx as the launch command and returns uvx's exit code",
  { skip: isWindows },
  async () => {
    const dir = tempDir();
    const record = fakeUvx(dir);
    const env = { PATH: `${dir}:${process.env.PATH}` };

    const code = await run(["status", "--config", "c.json"], env, tempDir());

    assert.equal(code, 3);
    const seen = JSON.parse(readFileSync(record, "utf-8"));
    assert.deepEqual(seen.args, uvxArguments(packageVersion(), ["status", "--config", "c.json"]));
    assert.deepEqual(JSON.parse(seen.launch), launchCommand(packageVersion()));
  },
);

test("a launch command the user set is passed through unchanged", { skip: isWindows }, async () => {
  const dir = tempDir();
  const record = fakeUvx(dir);
  const mine = JSON.stringify(["/opt/bin/my-wrapper"]);
  const env = { PATH: `${dir}:${process.env.PATH}`, [LAUNCH_COMMAND_ENV]: mine };

  await run([], env, tempDir());

  assert.equal(JSON.parse(readFileSync(record, "utf-8")).launch, mine);
});
