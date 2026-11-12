# @idle-sync/db-conn-mcp

The npm launcher for **[db-conn-mcp](https://github.com/Idle-Sync/db-conn-mcp)**, a dead-simple, self-hosted MCP server for safely querying your databases with AI agents.

> **Recommended: use uv directly, not this package.**
>
> ```bash
> uvx db-conn-mcp setup        # run without installing
> uv tool install db-conn-mcp  # or install the db-conn-mcp command
> ```
>
> [uv](https://docs.astral.sh/uv/getting-started/installation/) downloads its own Python, so you don't need Python installed first. This npm package only runs that same command for you, so it needs uv anyway and adds Node to every launch.

Use this package only when your setup can start MCP servers with `npx` and nothing else.

## Usage

```bash
npx @idle-sync/db-conn-mcp setup
```

Every argument is passed straight through: `npx @idle-sync/db-conn-mcp <args>` behaves exactly like `db-conn-mcp <args>`. See the [main README](https://github.com/Idle-Sync/db-conn-mcp#readme) for the commands, the 23 tools, the configuration file and the write-safety model.

`setup` writes an `npx -y @idle-sync/db-conn-mcp@<version>` entry into your MCP client, so the client keeps launching through npm.

## How it works

- This package's version is the db-conn-mcp version it runs: `@idle-sync/db-conn-mcp@0.8.2` runs `uvx --from db-conn-mcp==0.8.2 db-conn-mcp`. uv downloads that release from PyPI once and reuses it after that.
- Input, output and the exit code pass through unchanged, so MCP clients talk to the Python server directly.
- It looks for `uvx` on your `PATH`, then in `~/.local/bin` and `~/.cargo/bin`, where uv's installer puts it. Without uv it prints how to install it and exits with code 1.
- It sets `DB_CONN_MCP_LAUNCH_COMMAND` so `setup` knows to write the `npx` command into your client. If you set that variable yourself, your value wins.

## Requirements

- [uv](https://docs.astral.sh/uv/getting-started/installation/)
- Node.js 18 or newer, for `npx`

## Upgrading

Run setup again with the newer version, so your client's entry points at it:

```bash
npx @idle-sync/db-conn-mcp@latest setup
```

## Versions before 0.8.2

Version 0.3.0 was a separate TypeScript port with fewer tools and weaker write safety (no dry-run-first gate, no prompt-injection guard). It is deprecated. From 0.8.2 on, this package runs the Python server, so npm and PyPI users get the same server.

## License

MIT
