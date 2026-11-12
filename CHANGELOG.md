# Changelog

All notable changes to `@idle-sync/db-conn-mcp` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Every release
that alters observable behaviour carries a **Breaking / Behaviour changes** section — read
that first when upgrading.

## [Unreleased]

### Added

- Releases publish from GitHub Actions on a `vX.Y.Z` tag through npm trusted publishing,
  with provenance, so each version on npm links to the commit and workflow that built it.

## [0.8.2] — 2026-11-12

### Changed

- The package is now a small launcher for the Python server. `npx @idle-sync/db-conn-mcp <args>`
  runs `uvx --from db-conn-mcp==0.8.2 db-conn-mcp <args>`, so you get the same server,
  tools and safety as the PyPI release. The TypeScript port is gone.

### Breaking / Behaviour changes

- **You now need [uv](https://docs.astral.sh/uv/getting-started/installation/).** Without
  it the launcher prints how to install it and exits with code 1.
- **Writes are safer.** Commits are rejected unless the identical statement was dry-run
  first, and row values reach your agent inside an untrusted-data fence. 0.3.0 had neither.
- **Results have a new shape.** Every tool answers one JSON object whose first key is
  `meta`; list tools keep their list under a named key (`tables`, `columns`, `rows`, ...).
- **23 tools instead of 10**, with the same names for the 10 that existed.
- Your `connections.json` works unchanged.
- Re-run `npx @idle-sync/db-conn-mcp@latest setup` so your MCP client's entry uses the new
  launcher.

## [0.3.0] — 2026-06-09

TypeScript port of db-conn-mcp with 10 tools. Deprecated in favour of 0.8.2.

[Unreleased]: https://github.com/Idle-Sync/db-conn-mcp-node/compare/v0.8.2...HEAD
[0.8.2]: https://github.com/Idle-Sync/db-conn-mcp-node/releases/tag/v0.8.2
