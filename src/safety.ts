/**
 * The write-safety gate — a pure decision function, no I/O.
 *
 * Keeping this pure makes the security boundary trivially testable and unmissable.
 * Decision order (see ARCHITECTURE.md §5):
 *
 *     1. mode != "write"   -> REJECT  (hard, native; can never be bypassed)
 *     2. yolo is True      -> ALLOW
 *     3. user_consent True -> ALLOW
 *     4. otherwise         -> REJECT  (show SQL to user, re-call with consent)
 *
 * `yolo` and `user_consent` only relax the *prompt* on an already-`write` DB;
 * they can never make a `read` DB writable.
 */

import type { Connection } from "./models.js";

/** Returned to the agent when a write needs explicit consent (step 4). */
export const CONSENT_INSTRUCTION =
  "This database requires explicit consent for writes. First read the target " +
  "table and its schema, then show the user the exact SQL you intend to run and " +
  "ask for permission. Only call again with user_consent=true if they agree.";

/** Raised when a write must not proceed, carrying the precise next step. */
export class WriteRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteRejected";
  }
}

/** Allow the write (return) or throw {@link WriteRejected}. */
export function authorizeWrite(conn: Connection, userConsent: boolean): void {
  if (conn.mode !== "write") {
    throw new WriteRejected(
      `Database '${conn.name}' is read-only (mode=read). Writes are blocked at ` +
        "the database level and cannot be enabled by yolo or consent.",
    );
  }
  if (conn.yolo) {
    return;
  }
  if (userConsent) {
    return;
  }
  throw new WriteRejected(CONSENT_INSTRUCTION);
}
