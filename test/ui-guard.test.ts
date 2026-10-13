import { describe, expect, it } from "vitest";
import { isAllowedRequest } from "../ui/guard";

describe("UI request guard", () => {
  const ok = { host: "127.0.0.1:4200" };
  it("allows local GETs and same-origin POSTs", () => {
    expect(isAllowedRequest(ok, "GET", 4200)).toBe(true);
    expect(isAllowedRequest({ ...ok, origin: "http://127.0.0.1:4200" }, "POST", 4200)).toBe(true);
    expect(isAllowedRequest({ host: "localhost:4200", origin: "http://localhost:4200" }, "POST", 4200)).toBe(true);
  });
  it("blocks DNS rebinding (foreign Host) and cross-site or origin-less POSTs", () => {
    expect(isAllowedRequest({ host: "evil.test:4200" }, "GET", 4200)).toBe(false);
    expect(isAllowedRequest({ ...ok, origin: "https://evil.test" }, "POST", 4200)).toBe(false);
    expect(isAllowedRequest(ok, "POST", 4200)).toBe(false);
    expect(isAllowedRequest({ ...ok, origin: "null" }, "POST", 4200)).toBe(false);
  });
});
