/**
 * The doctor: driver errors -> sanitized {category, cause, fixes}.
 *
 * Critically: output must NEVER contain a host, user, or password substring.
 */

import { describe, expect, it } from "vitest";

import { explain } from "../src/diagnostics.js";

/** Build an error carrying a Postgres SQLSTATE (the reliable classification signal). */
function pgError(code: string, message = "boom"): Error {
  return Object.assign(new Error(message), { code });
}

/** Build a Node system error carrying an errno-style code. */
function sysError(code: string, message = "boom"): Error {
  return Object.assign(new Error(message), { code });
}

// Distinctive credential *values* that would only appear if the original error message
// were echoed. (Generic English words like "user" are excluded — the canned advice
// legitimately says "username".)
const SECRET_DSN_BITS = ["SUPERSECRET", "dbadmin", "myhost.example.com", "5432"];

describe("diagnostics.explain classification", () => {
  it("invalid password (28P01) -> AUTH_FAILED", () => {
    expect(explain(pgError("28P01", "password authentication failed")).category).toBe(
      "AUTH_FAILED",
    );
  });

  it("invalid catalog (3D000) -> DB_NOT_FOUND", () => {
    expect(explain(pgError("3D000", 'database "x" does not exist')).category).toBe("DB_NOT_FOUND");
  });

  it("connection refused (ECONNREFUSED) -> HOST_UNREACHABLE", () => {
    expect(explain(sysError("ECONNREFUSED", "connect ECONNREFUSED")).category).toBe(
      "HOST_UNREACHABLE",
    );
  });

  it("timeout (ETIMEDOUT) -> HOST_UNREACHABLE", () => {
    expect(explain(sysError("ETIMEDOUT", "timed out")).category).toBe("HOST_UNREACHABLE");
  });

  it("DNS failure (ENOTFOUND) -> DNS_FAILURE", () => {
    expect(explain(sysError("ENOTFOUND", "getaddrinfo ENOTFOUND")).category).toBe("DNS_FAILURE");
  });

  it("DNS failure via message marker -> DNS_FAILURE", () => {
    expect(explain(new Error("Name or service not known")).category).toBe("DNS_FAILURE");
  });

  it("unknown falls through, still pointing at the checklist", () => {
    const result = explain(new Error("something weird"));
    expect(result.category).toBe("UNKNOWN");
    const blob = (result.cause + " " + result.fixes.join(" ")).toLowerCase();
    expect(blob).toContain("troubleshoot_connection");
  });

  it("shape is exactly {category, cause, fixes}", () => {
    const result = explain(new Error("x"));
    expect(Object.keys(result).sort()).toEqual(["category", "cause", "fixes"]);
    expect(Array.isArray(result.fixes)).toBe(true);
  });
});

describe("diagnostics.explain never leaks connection details", () => {
  const cases = [
    pgError("28P01", "auth failed for 'dbadmin' at myhost.example.com:5432"),
    sysError("ECONNREFUSED", "refused connecting to myhost.example.com:5432 as dbadmin"),
    new Error("could not translate host name myhost.example.com to address"),
  ];
  for (const err of cases) {
    it(`sanitizes: ${err.message.slice(0, 30)}...`, () => {
      const result = explain(err);
      const blob = (result.cause + " " + result.fixes.join(" ")).toLowerCase();
      for (const secret of SECRET_DSN_BITS) {
        expect(blob).not.toContain(secret.toLowerCase());
      }
    });
  }
});
