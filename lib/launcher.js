/**
 * npm entry point for db-conn-mcp: runs the Python server through `uvx`.
 *
 * The server itself lives on PyPI (https://pypi.org/project/db-conn-mcp/). This
 * script runs the PyPI release with the same version as this npm package, passing
 * every argument, stdin/stdout/stderr and the exit code straight through, so
 * `npx @idle-sync/db-conn-mcp <args>` behaves exactly like `db-conn-mcp <args>`.
 *
 * It also tells the server how it was launched (DB_CONN_MCP_LAUNCH_COMMAND), so
 * `setup` writes an `npx` entry into your MCP client instead of a path inside uv's
 * cache.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The npm package name, as clients will run it. */
export const PACKAGE_NAME = "@idle-sync/db-conn-mcp";

/** The variable the Python server reads to learn which command to inject. */
export const LAUNCH_COMMAND_ENV = "DB_CONN_MCP_LAUNCH_COMMAND";

/** Shown when uv is missing. */
export const UV_MISSING_MESSAGE = `db-conn-mcp needs uv, which was not found.

Install uv (it brings its own Python), then run this again:
  macOS / Linux:  curl -LsSf https://astral.sh/uv/install.sh | sh
  Windows:        powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  More options:   https://docs.astral.sh/uv/getting-started/installation/

Once uv is installed you can skip npm entirely:
  uvx db-conn-mcp setup
`;

/** This package's version. Without a prerelease suffix it is also the PyPI version it runs. */
export function packageVersion() {
  const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(readFileSync(manifest, "utf-8")).version;
}

/**
 * Find the `uvx` executable: on PATH first, then where uv's installer puts it
 * (MCP clients often start servers with a PATH that leaves those folders out).
 */
export function findUvx(env = process.env, platform = process.platform, home = homedir()) {
  const name = platform === "win32" ? "uvx.exe" : "uvx";
  const pathDirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const installDirs = [
    env.UV_INSTALL_DIR,
    env.XDG_BIN_HOME,
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
  ].filter(Boolean);
  for (const dir of [...pathDirs, ...installDirs]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** The command an MCP client should run to start this server through npm. */
export function launchCommand(version, platform = process.platform, nodePath = process.execPath) {
  const pkg = `${PACKAGE_NAME}@${version}`;
  if (platform === "win32") {
    // npx is a .cmd script on Windows, which clients can only start through cmd.
    return ["cmd", "/c", "npx", "-y", pkg];
  }
  // An absolute path, because clients often start servers with a minimal PATH.
  const npx = join(dirname(nodePath), "npx");
  return [existsSync(npx) ? npx : "npx", "-y", pkg];
}

/**
 * The PyPI version an npm version runs: the part before any prerelease suffix, so a
 * launcher-only prerelease such as 0.8.2-launcher.1 still runs db-conn-mcp 0.8.2.
 */
export function pypiVersion(version) {
  return version.split("-")[0];
}

/** The `uvx` arguments that run PyPI's db-conn-mcp for npm `version` with `args`. */
export function uvxArguments(version, args) {
  return ["--from", `db-conn-mcp==${pypiVersion(version)}`, "db-conn-mcp", ...args];
}

/** Run the server; resolves to the exit code this process should end with. */
export function run(args = process.argv.slice(2), env = process.env, home = homedir()) {
  const uvx = findUvx(env, process.platform, home);
  if (uvx === null) {
    process.stderr.write(UV_MISSING_MESSAGE);
    return Promise.resolve(1);
  }
  const version = packageVersion();
  const childEnv = { ...env };
  // A launch command the user set deliberately wins over ours.
  if (!childEnv[LAUNCH_COMMAND_ENV]) {
    childEnv[LAUNCH_COMMAND_ENV] = JSON.stringify(launchCommand(version));
  }
  const child = spawn(uvx, uvxArguments(version, args), { stdio: "inherit", env: childEnv });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  return new Promise((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`db-conn-mcp: could not start uvx (${error.message}).\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
