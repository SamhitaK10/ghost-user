import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { COLLECT_SCRIPT, LIVE_MESSAGES_SCRIPT, MUTATION_COUNT_SCRIPT, resolveScript } from "./pagescripts";
import { createRedactor, type Redactor, type Secrets } from "./redact";
import {
  checkClickTarget,
  checkFillTarget,
  checkTargetUrl,
  isRequestAllowed,
  truncate,
  type ElementDescriptor,
} from "./safety";

/* -------------------------------------------------------------------------------------------
 * Browser sessions. One Chromium process per Node process; one isolated BrowserContext per run
 * (separate cookies/storage). The registry lives on globalThis because eve may load authored
 * tool modules more than once; a module-level singleton would then leak browsers.
 * ----------------------------------------------------------------------------------------- */

export interface ElementRef {
  ref: string;
  selector: string;
  fingerprint: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  autocomplete?: string;
  inputName?: string;
  href?: string;
  formAction?: string;
  disabled: boolean;
  line: string;
}

export interface Snapshot {
  snapshotId: string;
  navCount: number;
  mutations: number;
  url: string;
  title: string;
  headings: string[];
  refs: Map<string, ElementRef>;
  all: ElementRef[];
  takenInTask: string | null;
}

interface LogEntry {
  n: number;
  text: string;
}

export interface RunBrowser {
  runId: string;
  context: BrowserContext;
  page: Page;
  allowedOrigins: string[];
  secrets: Secrets;
  redact: Redactor;
  console: LogEntry[];
  network: LogEntry[];
  navCount: number;
  snapSeq: number;
  logSeq: number;
  snapshot: Snapshot | null;
  lastStatus: number | null;
}

interface Registry {
  browser: Promise<Browser> | null;
  runs: Map<string, RunBrowser>;
}

const KEY = Symbol.for("ghost-user.browser-registry");
function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  let r = g[KEY];
  if (!r) {
    r = { browser: null, runs: new Map() };
    g[KEY] = r;
  }
  return r;
}

async function launch(): Promise<Browser> {
  const needsNoSandbox = process.env.GHOST_USER_NO_SANDBOX === "1" || (typeof process.getuid === "function" && process.getuid() === 0);
  return chromium.launch({
    headless: process.env.GHOST_USER_HEADED !== "1",
    executablePath: process.env.GHOST_USER_CHROMIUM_PATH || undefined,
    args: needsNoSandbox ? ["--no-sandbox"] : [],
  });
}

const LOG_CAP = 100;
const MUTATION_INIT = `(() => {
  if (window.__guMut !== undefined) return;
  window.__guMut = 0;
  const attrs = ['disabled','hidden','href','aria-hidden','aria-expanded','aria-disabled','open'];
  const start = () => new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'childList' || m.type === 'attributes') { window.__guMut++; break; }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: attrs });
  start();
})();`;

function pushLog(rb: RunBrowser, list: LogEntry[], text: string): void {
  rb.logSeq += 1;
  list.push({ n: rb.logSeq, text: truncate(rb.redact(text), 240) });
  if (list.length > LOG_CAP) list.shift();
}

function attachPage(rb: RunBrowser, page: Page): void {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(15000);
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") pushLog(rb, rb.console, `${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => pushLog(rb, rb.console, `pageerror: ${e.message}`));
  page.on("dialog", (d) => {
    pushLog(rb, rb.console, `dialog(${d.type()}): ${d.message()}`);
    // Alerts are acknowledged; confirms/prompts are dismissed so a dialog can never authorise a destructive action.
    void (d.type() === "alert" ? d.accept() : d.dismiss()).catch(() => undefined);
  });
  page.on("requestfailed", (r) => {
    const failure = r.failure()?.errorText ?? "failed";
    pushLog(rb, rb.network, `${r.method()} ${r.url()} -> ${failure}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) pushLog(rb, rb.network, `${r.request().method()} ${r.url()} -> ${r.status()}`);
  });
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) {
      rb.navCount += 1;
      rb.snapshot = null;
    }
  });
}

export async function getRunBrowser(runId: string, allowedOrigins: string[], secrets: Secrets = {}): Promise<RunBrowser> {
  const reg = registry();
  const existing = reg.runs.get(runId);
  if (existing) return existing;
  reg.browser ??= launch();
  const browser = await reg.browser;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: false,
    serviceWorkers: "block",
    locale: "en-US",
  });
  await context.addInitScript(MUTATION_INIT);
  const page = await context.newPage();
  const rb: RunBrowser = {
    runId,
    context,
    page,
    allowedOrigins,
    secrets,
    redact: createRedactor(secrets),
    console: [],
    network: [],
    navCount: 0,
    snapSeq: 0,
    logSeq: 0,
    snapshot: null,
    lastStatus: null,
  };
  await context.route("**/*", (route, request) => {
    const verdict = isRequestAllowed(request.url(), request.method(), rb.allowedOrigins);
    if (!verdict.ok) {
      pushLog(rb, rb.network, `BLOCKED ${request.method()} ${request.url()} (${verdict.code})`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  context.on("page", (p) => {
    // Popups/new tabs: follow the newest page so the agent is never "lost".
    rb.page = p;
    rb.snapshot = null;
    attachPage(rb, p);
  });
  attachPage(rb, page);
  reg.runs.set(runId, rb);
  return rb;
}

export async function closeRunBrowser(runId: string): Promise<void> {
  const reg = registry();
  const rb = reg.runs.get(runId);
  if (!rb) return;
  reg.runs.delete(runId);
  await rb.context.close().catch(() => undefined);
}

export async function closeAllBrowsers(): Promise<void> {
  const reg = registry();
  // oxlint-disable-next-line no-useless-spread -- copy the keys: closeRunBrowser mutates the map while we iterate.
  for (const id of [...reg.runs.keys()]) await closeRunBrowser(id);
  if (reg.browser) {
    const b = await reg.browser.catch(() => null);
    reg.browser = null;
    await b?.close().catch(() => undefined);
  }
}

export function activeRunBrowsers(): string[] {
  return [...registry().runs.keys()];
}

/* ------------------------------------ results ----------------------------------------- */

export type BrowserFailure = { ok: false; code: string; reason: string };
export type After = { url: string; title: string; urlChanged: boolean; messages: string[] };

function fail(code: string, reason: string): BrowserFailure {
  return { ok: false, code, reason: truncate(reason, 300) };
}

function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return truncate(msg.split("\n").find((l) => l.trim().length > 0) ?? msg, 200);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => undefined);
  await page.waitForTimeout(60);
}

async function liveMessages(rb: RunBrowser): Promise<string[]> {
  try {
    const msgs = await rb.page.evaluate<string[]>(LIVE_MESSAGES_SCRIPT);
    return msgs.map((m) => truncate(rb.redact(m), 200));
  } catch {
    return [];
  }
}

async function after(rb: RunBrowser, beforeUrl: string): Promise<After> {
  const url = rb.page.url();
  const title = await rb.page.title().catch(() => "");
  return { url, title: truncate(title, 80), urlChanged: url !== beforeUrl, messages: await liveMessages(rb) };
}

/* ------------------------------------ navigation -------------------------------------- */

export async function open(rb: RunBrowser, url: string): Promise<({ ok: true; status: number | null } & After) | BrowserFailure> {
  const policy = checkTargetUrl(url, rb.allowedOrigins);
  if (!policy.ok) return fail(policy.code, policy.reason);
  const before = rb.page.url();
  try {
    const res = await rb.page.goto(url, { waitUntil: "domcontentloaded" });
    await settle(rb.page);
    rb.lastStatus = res?.status() ?? null;
    return { ok: true, status: rb.lastStatus, ...(await after(rb, before)) };
  } catch (e) {
    const msg = firstLine(e);
    if (msg.includes("ERR_BLOCKED_BY_CLIENT")) return fail("NAVIGATION_BLOCKED", "Navigation was blocked by the origin policy.");
    if (/timeout/i.test(msg)) return fail("NAVIGATION_TIMEOUT", `Page did not load in time: ${msg}`);
    return fail("NAVIGATION_FAILED", msg);
  }
}

export async function reload(rb: RunBrowser): Promise<({ ok: true; status: number | null } & After) | BrowserFailure> {
  const before = rb.page.url();
  try {
    const res = await rb.page.reload({ waitUntil: "domcontentloaded" });
    await settle(rb.page);
    rb.lastStatus = res?.status() ?? null;
    return { ok: true, status: rb.lastStatus, ...(await after(rb, before)) };
  } catch (e) {
    return fail("NAVIGATION_FAILED", firstLine(e));
  }
}

export async function currentUrl(rb: RunBrowser): Promise<{ url: string; title: string; status: number | null }> {
  return { url: rb.page.url(), title: truncate(await rb.page.title().catch(() => ""), 80), status: rb.lastStatus };
}

/* ------------------------------------ snapshot ---------------------------------------- */

interface RawEl {
  selector: string;
  fingerprint: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  autocomplete?: string;
  inputName?: string;
  href?: string;
  formAction?: string;
  disabled: boolean;
  required: boolean;
  value?: string;
  checked?: boolean;
  hasPassword?: boolean;
}

function renderLine(ref: string, e: RawEl): string {
  const bits = [`${ref} ${e.role}`, `"${e.name}"`];
  if (e.href) bits.push(`-> ${truncate(e.href, 60)}`);
  if (e.hasPassword !== undefined) bits.push(e.hasPassword ? "(filled)" : "(empty)");
  else if (e.value !== undefined && e.role !== "button") bits.push(`value="${truncate(e.value, 30)}"`);
  if (e.checked !== undefined) bits.push(e.checked ? "[checked]" : "[unchecked]");
  if (e.required) bits.push("[required]");
  if (e.disabled) bits.push("[disabled]");
  return bits.join(" ");
}

export type SnapshotScope = "all" | "forms" | "nav";

export interface SnapshotResult {
  snapshotId: string;
  url: string;
  title: string;
  headings: string[];
  elements: string[];
  total: number;
  shown: number;
  truncated: boolean;
  unchanged?: boolean;
  cached?: boolean;
  note?: string;
}

const MAX_SNAPSHOT_CHARS = 5000;

export async function snapshot(
  rb: RunBrowser,
  opts: { taskId: string | null; scope?: SnapshotScope; maxElements?: number; contains?: string },
): Promise<SnapshotResult | BrowserFailure> {
  const scope = opts.scope ?? "all";
  const max = Math.min(Math.max(opts.maxElements ?? 60, 5), 120);
  try {
    const mutations = await rb.page.evaluate<number>(MUTATION_COUNT_SCRIPT);
    const prior = rb.snapshot;
    let snap: Snapshot;
    let unchanged = false;
    let cached = false;
    if (prior && prior.navCount === rb.navCount && prior.mutations === mutations && prior.url === rb.page.url()) {
      snap = prior;
      if (prior.takenInTask === opts.taskId) unchanged = true;
      else cached = true;
    } else {
      const raw = await rb.page.evaluate<{ els: RawEl[]; headings: string[]; mutations: number }>(COLLECT_SCRIPT);
      const refs = new Map<string, ElementRef>();
      const all: ElementRef[] = raw.els.map((e, i) => {
        const ref = `e${i + 1}`;
        const entry: ElementRef = {
          ref,
          selector: e.selector,
          fingerprint: e.fingerprint,
          role: e.role,
          name: e.name,
          tag: e.tag,
          type: e.type,
          autocomplete: e.autocomplete,
          inputName: e.inputName,
          href: e.href,
          formAction: e.formAction,
          disabled: e.disabled,
          line: renderLine(ref, e),
        };
        refs.set(ref, entry);
        return entry;
      });
      rb.snapSeq += 1;
      snap = {
        snapshotId: `snap-${rb.snapSeq}`,
        navCount: rb.navCount,
        mutations: raw.mutations,
        url: rb.page.url(),
        title: await rb.page.title().catch(() => ""),
        headings: raw.headings.map((h) => rb.redact(h)),
        refs,
        all,
        takenInTask: opts.taskId,
      };
      rb.snapshot = snap;
    }

    if (unchanged) {
      return {
        snapshotId: snap.snapshotId,
        url: snap.url,
        title: truncate(snap.title, 80),
        headings: [],
        elements: [],
        total: snap.all.length,
        shown: 0,
        truncated: false,
        unchanged: true,
        note: "Page unchanged since your last snapshot; its element refs are still valid.",
      };
    }

    let list = snap.all;
    if (scope === "forms") list = list.filter((e) => e.role === "textbox" || e.role === "combobox" || e.role === "checkbox" || e.role === "radio" || e.role === "button");
    if (scope === "nav") list = list.filter((e) => e.role === "link" || e.role === "tab" || e.role === "menuitem");
    if (opts.contains) {
      const needle = opts.contains.toLowerCase();
      list = list.filter((e) => e.name.toLowerCase().includes(needle));
    }
    let shown = list.slice(0, max);
    let elements = shown.map((e) => rb.redact(e.line));
    let truncated = list.length > shown.length;
    while (JSON.stringify(elements).length > MAX_SNAPSHOT_CHARS && elements.length > 5) {
      elements = elements.slice(0, Math.floor(elements.length * 0.8));
      shown = shown.slice(0, elements.length);
      truncated = true;
    }
    return {
      snapshotId: snap.snapshotId,
      url: snap.url,
      title: truncate(snap.title, 80),
      headings: snap.headings,
      elements,
      total: list.length,
      shown: elements.length,
      truncated,
      cached: cached || undefined,
      note: truncated ? "Truncated. Narrow with scope or contains to see specific elements." : undefined,
    };
  } catch (e) {
    return fail("SNAPSHOT_FAILED", firstLine(e));
  }
}

/* ------------------------------------ interaction ------------------------------------- */

async function resolve(rb: RunBrowser, ref: string): Promise<{ ok: true; loc: Locator; el: ElementRef } | BrowserFailure> {
  const snap = rb.snapshot;
  if (!snap) return fail("NO_SNAPSHOT", "No valid snapshot for this page. Call browser_snapshot first.");
  const el = snap.refs.get(ref);
  if (!el) return fail("UNKNOWN_REF", `Unknown ref ${ref}. Use refs from the latest snapshot (${snap.snapshotId}).`);
  const loc = rb.page.locator(el.selector);
  const probe = await rb.page.evaluate<{ count: number; tag?: string; name?: string }>(resolveScript(el.selector)).catch((): { count: number; tag?: string; name?: string } => ({ count: -1 }));
  if (probe.count === 0) return fail("STALE_REF", `${ref} is no longer on the page. Call browser_snapshot again.`);
  if (probe.count > 1) return fail("AMBIGUOUS_TARGET", `${ref} now matches ${probe.count} elements. Call browser_snapshot again.`);
  if (probe.count < 0) return fail("STALE_REF", `${ref} could not be located. Call browser_snapshot again.`);
  const fp = { tag: probe.tag, name: probe.name };
  const [tag, , name] = el.fingerprint.split("|");
  if (fp.tag !== tag || fp.name !== name) return fail("STALE_REF", `${ref} changed since the snapshot. Call browser_snapshot again.`);
  return { ok: true, loc, el };
}

function descriptor(el: ElementRef): ElementDescriptor {
  return {
    tag: el.tag,
    role: el.role,
    name: el.name,
    type: el.type,
    autocomplete: el.autocomplete,
    inputName: el.inputName,
    href: el.href,
    formAction: el.formAction,
  };
}

export async function click(rb: RunBrowser, ref: string, opts: { navigationalOnly?: boolean } = {}): Promise<({ ok: true; clicked: string } & After) | BrowserFailure> {
  const r = await resolve(rb, ref);
  if (!r.ok) return r;
  if (opts.navigationalOnly && !(r.el.role === "link" || r.el.role === "tab" || r.el.role === "menuitem")) {
    return fail("BLOCKED_BY_POLICY", "This role is read-only: it may only follow links, not click buttons or controls.");
  }
  const policy = checkClickTarget(descriptor(r.el));
  if (!policy.ok) return fail(policy.code, policy.reason);
  if (r.el.disabled) return fail("ELEMENT_DISABLED", `${ref} is disabled.`);
  const before = rb.page.url();
  try {
    await r.loc.click({ timeout: 5000 });
  } catch (e) {
    return fail("ELEMENT_NOT_ACTIONABLE", firstLine(e));
  }
  await settle(rb.page);
  return { ok: true, clicked: truncate(`${r.el.role} "${r.el.name}"`, 100), ...(await after(rb, before)) };
}

export async function fill(
  rb: RunBrowser,
  ref: string,
  input: { value?: string; secretName?: string },
): Promise<({ ok: true; filled: string; echoed?: string } & After) | BrowserFailure> {
  if ((input.value === undefined) === (input.secretName === undefined)) {
    return fail("INVALID_INPUT", "Provide exactly one of value or secretName.");
  }
  let text: string;
  let isSecret = false;
  if (input.secretName !== undefined) {
    const v = rb.secrets[input.secretName];
    if (v === undefined) {
      return fail("UNKNOWN_SECRET", `Unknown secret "${input.secretName}". Available: ${Object.keys(rb.secrets).join(", ") || "none"}.`);
    }
    text = v;
    isSecret = true;
  } else {
    text = input.value!;
  }
  if (text.length > 2000) return fail("INVALID_INPUT", "Value is too long (max 2000 characters).");
  const r = await resolve(rb, ref);
  if (!r.ok) return r;
  const policy = checkFillTarget(descriptor(r.el));
  if (!policy.ok) return fail(policy.code, policy.reason);
  if (r.el.disabled) return fail("ELEMENT_DISABLED", `${ref} is disabled.`);
  const before = rb.page.url();
  try {
    if (r.el.tag === "select") await r.loc.selectOption({ label: text }).catch(() => r.loc.selectOption(text));
    else await r.loc.fill(text, { timeout: 5000 });
  } catch (e) {
    return fail("ELEMENT_NOT_ACTIONABLE", firstLine(e));
  }
  const hide = isSecret || r.el.type === "password";
  return {
    ok: true,
    filled: truncate(`${r.el.role} "${r.el.name}"`, 100),
    echoed: hide ? undefined : truncate(rb.redact(text), 40),
    ...(await after(rb, before)),
  };
}

const KEYS = new Set(["Enter", "Tab", "Escape"]);
export async function press(rb: RunBrowser, key: string): Promise<({ ok: true } & After) | BrowserFailure> {
  if (!KEYS.has(key)) return fail("INVALID_INPUT", "Only Enter, Tab and Escape are allowed.");
  const before = rb.page.url();
  try {
    await rb.page.keyboard.press(key);
  } catch (e) {
    return fail("ACTION_FAILED", firstLine(e));
  }
  await settle(rb.page);
  return { ok: true, ...(await after(rb, before)) };
}

/* ------------------------------------ observation ------------------------------------- */

export async function readText(rb: RunBrowser, opts: { ref?: string; maxChars?: number }): Promise<{ ok: true; text: string; totalChars: number; truncated: boolean } | BrowserFailure> {
  const max = Math.min(Math.max(opts.maxChars ?? 1500, 100), 4000);
  let raw: string;
  try {
    if (opts.ref) {
      const r = await resolve(rb, opts.ref);
      if (!r.ok) return r;
      raw = await r.loc.innerText({ timeout: 3000 });
    } else {
      raw = await rb.page.locator("body").innerText({ timeout: 3000 });
    }
  } catch (e) {
    return fail("READ_FAILED", firstLine(e));
  }
  const text = rb.redact(raw.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim());
  return { ok: true, text: truncate(text, max), totalChars: text.length, truncated: text.length > max };
}

export async function fullBodyText(rb: RunBrowser): Promise<string> {
  const raw = await rb.page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  return rb.redact(raw).slice(0, 50_000);
}

export function readLog(rb: RunBrowser, kind: "console" | "network", since: number, limit: number): { entries: string[]; nextIndex: number; total: number } {
  const list = kind === "console" ? rb.console : rb.network;
  const fresh = list.filter((e) => e.n > since);
  const entries = fresh.slice(-Math.min(Math.max(limit, 1), 30)).map((e) => e.text);
  return { entries, nextIndex: list.length ? list[list.length - 1]!.n : since, total: fresh.length };
}

export async function screenshotJpeg(rb: RunBrowser): Promise<Buffer> {
  return rb.page.screenshot({
    type: "jpeg",
    quality: 60,
    fullPage: false,
    // Never capture password fields, even though the value is hidden by the browser already.
    mask: [rb.page.locator("input[type=password]")],
    animations: "disabled",
  });
}
