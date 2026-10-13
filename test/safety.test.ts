import { describe, expect, it } from "vitest";
import { checkClickTarget, checkFillTarget, checkTargetUrl, isRequestAllowed, parseAllowedOrigins } from "../src/core/safety";

const allowed = ["http://127.0.0.1:4173"];

describe("origin allowlist", () => {
  it("parses env, ignoring malformed and non-http entries", () => {
    expect(parseAllowedOrigins({ GHOST_USER_ALLOWED_ORIGINS: "http://a.test, nonsense, ftp://x.test ,https://b.test/path" })).toEqual([
      "http://a.test",
      "https://b.test",
    ]);
    expect(parseAllowedOrigins({})).toEqual([]);
  });
  it("authorises nothing by default", () => {
    expect(checkTargetUrl("http://127.0.0.1:4173/", [])).toMatchObject({ ok: false, code: "UNAUTHORIZED_ORIGIN" });
  });
  it("accepts an allowed origin and refuses others, including look-alike ports and hosts", () => {
    expect(checkTargetUrl("http://127.0.0.1:4173/x", allowed).ok).toBe(true);
    expect(checkTargetUrl("http://127.0.0.1:4174/", allowed).ok).toBe(false);
    expect(checkTargetUrl("http://127.0.0.1.evil.test:4173/", allowed).ok).toBe(false);
  });
  it("blocks bad schemes, embedded credentials and cloud metadata even if allowlisted", () => {
    expect(checkTargetUrl("file:///etc/passwd", allowed)).toMatchObject({ code: "FORBIDDEN_SCHEME" });
    expect(checkTargetUrl("http://user:pw@127.0.0.1:4173/", allowed)).toMatchObject({ code: "URL_HAS_CREDENTIALS" });
    expect(checkTargetUrl("http://169.254.169.254/latest", ["http://169.254.169.254"])).toMatchObject({ code: "FORBIDDEN_HOST" });
    expect(checkTargetUrl("not a url", allowed)).toMatchObject({ code: "INVALID_URL" });
  });
  it("filters in-browser requests: off-origin sub-resources and DELETE are blocked", () => {
    expect(isRequestAllowed("http://127.0.0.1:4173/api/x", "POST", allowed).ok).toBe(true);
    expect(isRequestAllowed("https://tracker.example/p.gif", "GET", allowed).ok).toBe(false);
    expect(isRequestAllowed("http://127.0.0.1:4173/api/x", "DELETE", allowed)).toMatchObject({ code: "BLOCKED_BY_POLICY" });
    expect(isRequestAllowed("data:text/plain,hi", "GET", allowed).ok).toBe(true);
  });
});

describe("action policy", () => {
  const el = (name: string, extra = {}) => ({ tag: "button", role: "button", name, ...extra });
  it.each(["Delete account", "Remove project", "Cancel my subscription", "Close account"])("blocks destructive control: %s", (n) => {
    expect(checkClickTarget(el(n))).toMatchObject({ ok: false, code: "BLOCKED_BY_POLICY" });
  });
  it.each(["Pay now", "Buy now", "Place order", "Checkout", "Subscribe", "Donate"])("blocks transactional control: %s", (n) => {
    expect(checkClickTarget(el(n))).toMatchObject({ ok: false, code: "BLOCKED_BY_POLICY" });
  });
  it("blocks a submit whose form action is destructive", () => {
    expect(checkClickTarget(el("Submit", { formAction: "POST /account/delete" })).ok).toBe(false);
  });
  it.each(["Log in", "Sign up", "Save", "Rename", "Send message", "Settings"])("allows ordinary control: %s", (n) => {
    expect(checkClickTarget(el(n)).ok).toBe(true);
  });
  it("blocks file inputs and payment fields", () => {
    expect(checkClickTarget(el("Upload", { type: "file" })).ok).toBe(false);
    expect(checkFillTarget({ tag: "input", role: "textbox", name: "Card number" }).ok).toBe(false);
    expect(checkFillTarget({ tag: "input", role: "textbox", name: "Number", autocomplete: "cc-number" }).ok).toBe(false);
    expect(checkFillTarget({ tag: "input", role: "textbox", name: "CVV" }).ok).toBe(false);
    expect(checkFillTarget({ tag: "input", role: "textbox", name: "Email" }).ok).toBe(true);
  });
});
