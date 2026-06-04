/** The write-gate truth table: mode (hard) -> yolo -> user_consent. */

import { describe, expect, it } from "vitest";

import type { Connection } from "../src/models.js";
import { authorizeWrite, WriteRejected } from "../src/safety.js";

function conn(mode: "read" | "write", yolo = false): Connection {
  return { name: "db", dsn: "postgresql://h/db", mode, yolo };
}

describe("safety: mode is the hard, unbypassable boundary", () => {
  it("rejects a read DB even with consent", () => {
    expect(() => authorizeWrite(conn("read"), true)).toThrow(/read/);
    expect(() => authorizeWrite(conn("read"), true)).toThrow(WriteRejected);
  });

  it("rejects a read DB even with yolo", () => {
    expect(() => authorizeWrite(conn("read", true), false)).toThrow(WriteRejected);
  });
});

describe("safety: yolo / consent only relax a write DB", () => {
  it("yolo allows a write without consent", () => {
    expect(authorizeWrite(conn("write", true), false)).toBeUndefined();
  });

  it("consent allows a write", () => {
    expect(authorizeWrite(conn("write"), true)).toBeUndefined();
  });

  it("write DB with no yolo and no consent is rejected with the instruction", () => {
    expect(() => authorizeWrite(conn("write"), false)).toThrow(/user_consent/);
  });
});
