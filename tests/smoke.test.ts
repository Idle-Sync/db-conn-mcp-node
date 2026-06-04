/** Scaffolding smoke tests: the package imports and the contract is wired. */

import { describe, expect, it } from "vitest";

import { dialectFor, supportedSchemes } from "../src/dialects/registry.js";
import { publicView, type Connection } from "../src/models.js";
import { VERSION } from "../src/version.js";

describe("smoke", () => {
  it("version is present", () => {
    expect(VERSION).toBeTruthy();
  });

  it("public view hides the dsn", () => {
    const conn: Connection = {
      name: "prod",
      dsn: "postgresql://secret",
      mode: "read",
      yolo: false,
    };
    const view = publicView(conn);
    expect(view).toEqual({ name: "prod", mode: "read", yolo: false });
    expect("dsn" in view).toBe(false);
  });

  it("registry resolves postgres schemes", () => {
    expect(supportedSchemes()).toContain("postgresql");
    expect(dialectFor("postgresql://localhost/db").scheme).toBe("postgresql");
    expect(dialectFor("postgres://localhost/db").scheme).toBe("postgresql");
  });

  it("registry rejects an unknown scheme", () => {
    expect(() => dialectFor("mysql://localhost/db")).toThrow(/Unsupported DSN scheme/);
  });
});
