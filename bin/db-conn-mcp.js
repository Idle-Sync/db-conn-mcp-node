#!/usr/bin/env node
// npm entry point: run PyPI's db-conn-mcp through uvx. See lib/launcher.js.
import { run } from "../lib/launcher.js";

process.exitCode = await run();
