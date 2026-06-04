/**
 * The doctor: classify driver/connection errors into sanitized cause + fix.
 *
 * {@link explain} receives ONLY an error — never a `Connection` or DSN — so no
 * host, user, or password can ever leak into a tool result or log (Rule 6).
 *
 * The sanitation guarantee is structural: the `cause`/`fixes` returned are **fixed,
 * canned strings per category**. The original error's message (which *might* contain
 * a host or user) is only inspected for pattern-matching and is never copied into output.
 */

export type Category =
  | "AUTH_FAILED"
  | "HOST_UNREACHABLE"
  | "DB_NOT_FOUND"
  | "DNS_FAILURE"
  | "SSL_REQUIRED"
  | "POOL_EXHAUSTED"
  | "UNKNOWN";

export interface Diagnostic {
  category: Category;
  cause: string;
  fixes: string[];
}

/** Canned, sanitized advice per category. No host/user/password ever appears here. */
const ADVICE: Record<Category, { cause: string; fixes: string[] }> = {
  AUTH_FAILED: {
    cause: "Authentication failed — wrong username/password, or the role does not exist.",
    fixes: [
      "Verify the username and password in your DSN.",
      "Confirm the role exists and may log in (pg_hba.conf / GRANT).",
    ],
  },
  HOST_UNREACHABLE: {
    cause: "The database is not accepting connections (refused or timed out).",
    fixes: [
      "Check the database is running and the host/port are correct.",
      "Check firewalls / security groups between you and the server.",
      "In Docker, `localhost` inside a container is NOT the database container — " +
        "use the service name or host gateway.",
    ],
  },
  DB_NOT_FOUND: {
    cause: "The named database does not exist on the server.",
    fixes: [
      "Check the database name for spelling and case.",
      "Create the database if it has not been created yet.",
    ],
  },
  DNS_FAILURE: {
    cause: "The hostname could not be resolved to an address.",
    fixes: [
      "Check the host portion of the DSN for typos.",
      "Confirm DNS/VPN/network access to the host is available.",
    ],
  },
  SSL_REQUIRED: {
    cause: "The server requires an SSL/TLS connection.",
    fixes: ["Add an appropriate SSL mode to the DSN, e.g. `?sslmode=require`."],
  },
  POOL_EXHAUSTED: {
    cause: "The server's connection limit has been reached.",
    fixes: ["Close idle sessions, or raise the server's `max_connections`."],
  },
  UNKNOWN: {
    cause: "Unrecognized connection error.",
    fixes: ["Open the `troubleshoot_connection` prompt for the full gotchas checklist."],
  },
};

// DNS resolution failures surface as system errors / messages with these markers.
const DNS_MARKERS = [
  "name or service not known",
  "could not translate host name",
  "nodename nor servname",
  "getaddrinfo failed",
  "temporary failure in name resolution",
  "name does not resolve",
];

/** SQLSTATE codes node-postgres attaches to server errors (the reliable signal). */
const SQLSTATE: Record<string, Category> = {
  "28P01": "AUTH_FAILED", // invalid_password
  "28000": "AUTH_FAILED", // invalid_authorization_specification
  "3D000": "DB_NOT_FOUND", // invalid_catalog_name
  "53300": "POOL_EXHAUSTED", // too_many_connections
};

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Map an error to a category using its code and message *markers only*. */
function classify(error: unknown): Category {
  const code = errorCode(error);

  // Postgres server errors carry a reliable SQLSTATE — match it first.
  if (code && code in SQLSTATE) {
    return SQLSTATE[code]!;
  }

  // Node system (socket) errors — the connection never reached the server.
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT") {
    return "HOST_UNREACHABLE";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "DNS_FAILURE";
  }

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (DNS_MARKERS.some((marker) => message.includes(marker))) {
    return "DNS_FAILURE";
  }
  if (message.includes("ssl")) {
    return "SSL_REQUIRED";
  }
  if (message.includes("too many") || message.includes("remaining connection slots")) {
    return "POOL_EXHAUSTED";
  }
  if (
    message.includes("password authentication failed") ||
    (message.includes("role") && message.includes("exist"))
  ) {
    return "AUTH_FAILED";
  }
  if (message.includes("does not exist") && message.includes("database")) {
    return "DB_NOT_FOUND";
  }
  if (
    message.includes("connection refused") ||
    message.includes("timed out") ||
    message.includes("timeout")
  ) {
    return "HOST_UNREACHABLE";
  }

  return "UNKNOWN";
}

/**
 * Map a driver error to `{category, cause, fixes[]}` (sanitized strings).
 *
 * Output contains only canned advice — no host/user/password substrings.
 */
export function explain(error: unknown): Diagnostic {
  const category = classify(error);
  const advice = ADVICE[category];
  return { category, cause: advice.cause, fixes: [...advice.fixes] };
}
