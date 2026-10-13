import { describe, expect, it } from "vitest";
import { createRedactor, loadSecrets, redactDeep, secretNames } from "../src/core/redact";

describe("secrets", () => {
  it("loads a JSON map and exposes names only", () => {
    const s = loadSecrets({ GHOST_USER_SECRETS: JSON.stringify({ demo_password: "hunter2hunter2", api_token: "tok-123456" }) });
    expect(secretNames(s)).toEqual(["api_token", "demo_password"]);
  });
  it("rejects malformed configuration", () => {
    expect(() => loadSecrets({ GHOST_USER_SECRETS: "nope" })).toThrow();
    expect(() => loadSecrets({ GHOST_USER_SECRETS: "[]" })).toThrow();
    expect(() => loadSecrets({ GHOST_USER_SECRETS: '{"Bad Name":"x"}' })).toThrow();
    expect(() => loadSecrets({ GHOST_USER_SECRETS: '{"ok":""}' })).toThrow();
  });
  it("redacts secret values, bearer tokens and credential query params", () => {
    const r = createRedactor({ pw: "s3cr3t-value" });
    expect(r("typed s3cr3t-value into field")).toBe("typed [REDACTED:pw] into field");
    expect(r("Authorization: Bearer abcdefghijklmnop1234")).toContain("Bearer [REDACTED]");
    expect(r("GET /x?token=abc123&y=1")).toBe("GET /x?token=[REDACTED]&y=1");
  });
  it("redacts deeply and masks sensitive keys regardless of value", () => {
    const r = createRedactor({ pw: "s3cr3t-value" });
    const out = redactDeep({ a: ["s3cr3t-value"], password: "anything", nested: { note: "x s3cr3t-value y" } }, r);
    expect(JSON.stringify(out)).not.toContain("s3cr3t-value");
    expect(out.password).toBe("[REDACTED]");
  });
});
