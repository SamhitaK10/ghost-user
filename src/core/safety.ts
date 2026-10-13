/**
 * Safety policy. Pure functions so every rule is unit-testable.
 *
 * Principles:
 *  - Only origins the operator explicitly authorised (GHOST_USER_ALLOWED_ORIGINS) may be tested.
 *  - Cloud metadata and non-http(s) targets are always refused.
 *  - Destructive / transactional UI actions and payment-field input are refused by policy.
 *  - These checks run in tool code. The model cannot talk its way past them.
 */

type Env = Record<string, string | undefined>;

export type PolicyResult = { ok: true } | { ok: false; code: PolicyCode; reason: string };

export type PolicyCode =
  | "UNAUTHORIZED_ORIGIN"
  | "INVALID_URL"
  | "FORBIDDEN_SCHEME"
  | "FORBIDDEN_HOST"
  | "URL_HAS_CREDENTIALS"
  | "BLOCKED_BY_POLICY";

const ALWAYS_BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "100.100.100.200",
  "[fd00:ec2::254]",
]);

export function parseAllowedOrigins(env: Env = process.env): string[] {
  const raw = env.GHOST_USER_ALLOWED_ORIGINS ?? "";
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      if (u.protocol === "http:" || u.protocol === "https:") out.push(u.origin);
    } catch {
      // ignore malformed entries; they authorise nothing
    }
  }
  return [...new Set(out)];
}

export function checkTargetUrl(rawUrl: string, allowedOrigins: readonly string[]): PolicyResult {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, code: "INVALID_URL", reason: "The URL could not be parsed." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, code: "FORBIDDEN_SCHEME", reason: `Scheme ${u.protocol} is not allowed.` };
  }
  if (u.username || u.password) {
    return { ok: false, code: "URL_HAS_CREDENTIALS", reason: "URLs must not embed credentials." };
  }
  if (ALWAYS_BLOCKED_HOSTS.has(u.hostname.toLowerCase())) {
    return { ok: false, code: "FORBIDDEN_HOST", reason: "Cloud metadata endpoints are always blocked." };
  }
  if (!allowedOrigins.includes(u.origin)) {
    return {
      ok: false,
      code: "UNAUTHORIZED_ORIGIN",
      reason: `Origin ${u.origin} is not in GHOST_USER_ALLOWED_ORIGINS. Ghost User only tests sites the operator has authorised.`,
    };
  }
  return { ok: true };
}

/** Used for in-browser request interception (redirects, sub-resources, XHR/fetch). */
export function isRequestAllowed(rawUrl: string, method: string, allowedOrigins: readonly string[]): PolicyResult {
  if (rawUrl.startsWith("about:") || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
    return { ok: true };
  }
  const target = checkTargetUrl(rawUrl, allowedOrigins);
  if (!target.ok) return target;
  if (method.toUpperCase() === "DELETE") {
    return { ok: false, code: "BLOCKED_BY_POLICY", reason: "HTTP DELETE requests are blocked (destructive)." };
  }
  return { ok: true };
}

const DESTRUCTIVE =
  /\b(delete|remove|destroy|erase|wipe|terminate|deactivate|close (my )?account|cancel (my |your )?(subscription|account|plan)|drop (table|database)|reset (all|everything|data)|purge)\b/i;
const TRANSACTIONAL =
  /\b(pay|pay now|payment|purchase|buy|buy now|checkout|check out|place (your |my )?order|confirm (order|payment|purchase)|subscribe|upgrade (plan|now)|donate|send money|transfer|withdraw|top[- ]?up|add to cart)\b/i;

export interface ElementDescriptor {
  tag: string;
  role: string;
  name: string;
  type?: string;
  autocomplete?: string;
  inputName?: string;
  href?: string;
  /** Text of the enclosing form's submit controls, if the element submits a form. */
  formAction?: string;
}

/** Decide whether clicking an element is permitted. */
export function checkClickTarget(el: ElementDescriptor): PolicyResult {
  const haystack = `${el.name} ${el.formAction ?? ""}`.trim();
  if (DESTRUCTIVE.test(haystack)) {
    return {
      ok: false,
      code: "BLOCKED_BY_POLICY",
      reason: `Clicking "${truncate(el.name, 60)}" looks destructive. Destructive actions are blocked; report this step as blocked.`,
    };
  }
  if (TRANSACTIONAL.test(haystack)) {
    return {
      ok: false,
      code: "BLOCKED_BY_POLICY",
      reason: `Clicking "${truncate(el.name, 60)}" looks like a real transaction. Transactions are blocked; report this step as blocked.`,
    };
  }
  if (el.type === "file") {
    return { ok: false, code: "BLOCKED_BY_POLICY", reason: "File uploads are blocked." };
  }
  return { ok: true };
}

const PAYMENT_AUTOCOMPLETE = /^(cc-|transaction-)/i;
const PAYMENT_NAME = /(card[\s_-]*(number|num|no)|cc[\s_-]*(num|number)|cvv|cvc|security[\s_-]*code|iban|routing[\s_-]*number|account[\s_-]*number|ssn|social[\s_-]*security)/i;

/** Decide whether typing into a field is permitted. */
export function checkFillTarget(el: ElementDescriptor): PolicyResult {
  if (
    (el.autocomplete && PAYMENT_AUTOCOMPLETE.test(el.autocomplete)) ||
    PAYMENT_NAME.test(el.name) ||
    (el.inputName && PAYMENT_NAME.test(el.inputName))
  ) {
    return {
      ok: false,
      code: "BLOCKED_BY_POLICY",
      reason: "Entering payment or government-identifier data is blocked.",
    };
  }
  if (el.type === "file") {
    return { ok: false, code: "BLOCKED_BY_POLICY", reason: "File uploads are blocked." };
  }
  return { ok: true };
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}
