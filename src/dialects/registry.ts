/**
 * Map a DSN scheme to its {@link Dialect}.
 *
 * Adding a dialect = implement the contract + add one entry here. No code above this
 * layer changes.
 */

import { Dialect } from "./base.js";
import { PostgresDialect, SCHEMES as POSTGRES_SCHEMES } from "./postgres.js";

/** Scheme -> Dialect instance. One entry per supported database. */
const REGISTRY = new Map<string, Dialect>();
for (const scheme of POSTGRES_SCHEMES) {
  REGISTRY.set(scheme, new PostgresDialect());
}

/** The scheme portion of a DSN (per RFC 3986), lowercased; `""` if absent. */
function schemeOf(dsn: string): string {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(dsn);
  return match ? match[1]!.toLowerCase() : "";
}

/** Return the sorted list of DSN schemes the registry can resolve. */
export function supportedSchemes(): string[] {
  return [...REGISTRY.keys()].sort();
}

/**
 * Return the dialect for `dsn`'s scheme.
 *
 * Throws `Error` (naming the supported schemes) on an unknown scheme.
 */
export function dialectFor(dsn: string): Dialect {
  const scheme = schemeOf(dsn);
  const dialect = REGISTRY.get(scheme);
  if (!dialect) {
    throw new Error(
      `Unsupported DSN scheme '${scheme}'. Supported: ${supportedSchemes().join(", ")}.`,
    );
  }
  return dialect;
}
