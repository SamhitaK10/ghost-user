/**
 * Credential handling.
 *
 * Secrets live only in the server environment (GHOST_USER_SECRETS, a JSON map of
 * name -> value). The model refers to a secret by *name* when filling a field; the value is
 * resolved inside tool code and never enters model context, logs, evidence or reports.
 */

type Env = Record<string, string | undefined>;

export type Secrets = Record<string, string>;

const SECRET_NAME = /^[a-z][a-z0-9_]{0,40}$/;

export function loadSecrets(env: Env = process.env): Secrets {
  const raw = env.GHOST_USER_SECRETS;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GHOST_USER_SECRETS must be a JSON object of name -> value.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("GHOST_USER_SECRETS must be a JSON object of name -> value.");
  }
  const out: Secrets = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!SECRET_NAME.test(name)) {
      throw new Error(`Invalid secret name "${name}". Use lowercase letters, digits and underscores.`);
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Secret "${name}" must be a non-empty string.`);
    }
    out[name] = value;
  }
  return out;
}

export function secretNames(secrets: Secrets): string[] {
  return Object.keys(secrets).sort();
}

export type Redactor = (text: string) => string;

const SENSITIVE_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|session)/i;

export function createRedactor(secrets: Secrets): Redactor {
  // Longest first so a secret that contains another is replaced whole.
  const entries = Object.entries(secrets)
    .filter(([, v]) => v.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  return (text: string) => {
    let out = text;
    for (const [name, value] of entries) {
      if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
    }
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1[REDACTED]");
    out = out.replace(
      /([?&](?:password|pass|token|access_token|api_key|apikey|secret|key|session)=)[^&\s"']+/gi,
      "$1[REDACTED]",
    );
    return out;
  };
}

/** Deep-redact any JSON-serialisable value. Sensitive-looking keys are masked regardless of value. */
export function redactDeep<T>(value: T, redact: Redactor): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") return key && SENSITIVE_KEY.test(key) && v.length > 0 ? "[REDACTED]" : redact(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    return v;
  };
  return walk(value) as T;
}
