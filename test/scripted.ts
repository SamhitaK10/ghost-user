/**
 * Scripted (non-LLM) agents used to test the infrastructure end to end: tools, store gates,
 * delegation, report. They drive a REAL browser against the demo site but contain no knowledge of
 * which defects exist: they check generic user expectations and report what they observe.
 *
 * IMPORTANT: results from these scripts validate the plumbing (budgets, gates, evidence, report).
 * They say nothing about how well an LLM agent finds bugs; that needs real-model evals.
 */
import { BrowserTools, RecordTools } from "../src/tools/impl";
import { getStore } from "../src/tools/runtime";

type Res = Record<string, any>;

export class Driver {
  evidence: string[] = [];
  constructor(public runId: string) {}

  private note(r: Res): Res {
    if (r.evidenceId) this.evidence.push(r.evidenceId);
    return r;
  }
  async open(url: string) { return this.note(await BrowserTools.open({ runId: this.runId, url })); }
  async reload() { return this.note(await BrowserTools.reload({ runId: this.runId })); }
  private last: { url: string; elements: string[]; headings: string[] } | null = null;
  /** Like a model, remember the previous listing: the tool returns `unchanged` instead of repeating it. */
  async snap(contains?: string) {
    const s = this.note(await BrowserTools.snapshot({ runId: this.runId, contains }));
    if (s.unchanged && this.last && this.last.url === s.url) return { ...s, elements: this.last.elements, headings: this.last.headings };
    if (Array.isArray(s.elements) && !contains) this.last = { url: s.url, elements: s.elements, headings: s.headings ?? [] };
    return s;
  }
  async click(ref: string) { return this.note(await BrowserTools.click({ runId: this.runId, ref })); }
  async fill(ref: string, value: string) { return this.note(await BrowserTools.fill({ runId: this.runId, ref, value })); }
  async fillSecret(ref: string, secretName: string) { return this.note(await BrowserTools.fill({ runId: this.runId, ref, secretName })); }
  async text() { return this.note(await BrowserTools.readText({ runId: this.runId })); }
  async network() { return this.note(await BrowserTools.log({ runId: this.runId, kind: "network" })); }
  async shot(label: string) { return this.note(await BrowserTools.screenshot({ runId: this.runId, label })); }

  /** Find an element ref in the latest snapshot by role and accessible name. */
  async ref(role: string, name: string): Promise<string> {
    const s = await this.snap();
    const line = (s.elements as string[] | undefined)?.find((l) => new RegExp(`^e\\d+ ${role} "${name}`, "i").test(l));
    if (!line) throw new Error(`no ${role} "${name}" in snapshot: ${JSON.stringify(s).slice(0, 200)}`);
    return line.split(" ")[0]!;
  }
  async fillField(label: string, value: string) { return this.fill(await this.ref("textbox", label), value); }
  async press(role: string, name: string) { return this.click(await this.ref(role, name)); }
}

export interface Outcome {
  area: string;
  title: string;
  expected: string;
  observed: string;
  passed: boolean;
  evidence: string[];
}

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${counter++}`;

export async function login(d: Driver, base: string) {
  await d.open(`${base}/login`);
  await d.fillField("Email", "demo@example.com");
  await d.fill(await d.ref("textbox", "Password"), "ignored");
  // credentials by secret NAME only
  await d.fillSecret(await d.ref("textbox", "Password"), "demo_password");
  await d.press("button", "Log in");
}

export async function scenarioSignup(d: Driver, base: string, localPart = "qa+" + uniq()): Promise<Outcome> {
  await d.open(`${base}/signup`);
  await d.fillField("Full name", "QA Tester");
  await d.fillField("Email", `${localPart}@example.com`);
  await d.fill(await d.ref("textbox", "Password"), "a-long-test-password");
  const r = await d.press("button", "Create account");
  const text = ((r.messages as string[] | undefined) ?? []).join(" ");
  const ok = /\/projects/.test(String(r.url)) && !/valid email/i.test(text);
  const shot = ok ? [] : [(await d.shot("signup failed")).evidenceId];
  return {
    area: "signup",
    title: "Signup with a valid email address",
    expected: `Account is created for ${localPart}@example.com and the user lands on the projects page`,
    observed: ok ? "Account created and projects page shown" : `Stayed on ${r.url}; alert says: "${text.slice(0, 160)}"`,
    passed: ok,
    evidence: [...d.evidence.slice(-4), ...shot],
  };
}

export async function scenarioRename(d: Driver, base: string): Promise<Outcome> {
  await login(d, base);
  const name = `Alpha ${uniq()}`;
  const renamed = `Beta ${uniq()}`;
  await d.fillField("Project name", name);
  await d.press("button", "Create project");
  const link = await d.ref("link", name);
  await d.click(link);
  const field = await d.ref("textbox", "Project name");
  await d.fill(field, renamed);
  const saved = await d.press("button", "Save name");
  const msg = ((saved.messages as string[] | undefined) ?? []).join(" ");
  await d.reload();
  const after = await d.snap();
  const line = (after.elements as string[]).find((l) => /textbox "Project name"/.test(l)) ?? "";
  const persisted = line.includes(renamed);
  const shot = persisted ? [] : [(await d.shot("name after reload")).evidenceId];
  return {
    area: "rename",
    title: "Renaming a project persists after reload",
    expected: `After saving, the project name stays "${renamed}" when the page is reloaded`,
    observed: persisted ? "Name persisted after reload" : `UI said "${msg.replace(/\s+/g, " ").slice(0, 60)}" but after reload the name was ${line.match(/value="([^"]*)"/)?.[1] ?? "(unknown)"}`,
    passed: persisted,
    evidence: [...d.evidence.slice(-5), ...shot],
  };
}

export async function scenarioSettingsNav(d: Driver, base: string): Promise<Outcome> {
  await d.open(`${base}/`);
  const r = await d.press("link", "Settings");
  const snap = await d.snap();
  const h = ((snap.headings as string[]) ?? []).join(" | ");
  const ok = /settings/i.test(String(r.title)) || /\/settings/.test(String(r.url));
  const shot = ok ? [] : [(await d.shot("settings link result")).evidenceId];
  return {
    area: "nav",
    title: "Settings link opens the Settings page",
    expected: "Clicking Settings in the main navigation opens the account settings page",
    observed: ok ? `Opened ${r.url}` : `Opened ${r.url} titled "${r.title}" with headings: ${h}`,
    passed: ok,
    evidence: [...d.evidence.slice(-3), ...shot],
  };
}

export async function scenarioContactInvalid(d: Driver, base: string): Promise<Outcome> {
  await d.open(`${base}/contact`);
  await d.fillField("Your email", "not-an-email");
  await d.fillField("Message", "hi");
  const before = ((await d.network()).nextIndex as number | undefined) ?? 0;
  const sent = await d.press("button", "Send message");
  const msg = ((sent.messages as string[] | undefined) ?? []).join(" ");
  const net = await BrowserTools.log({ runId: d.runId, kind: "network", since: before }).then((r: any) => { if (r.evidenceId) d.evidence.push(r.evidenceId); return r; });
  const rejected = (net.entries as string[] | undefined)?.some((e) => /-> 4\d\d/.test(e)) ?? false;
  const claimsSuccess = /success|sent/i.test(msg);
  const ok = !(rejected && claimsSuccess);
  const shot = ok ? [] : [(await d.shot("contact result")).evidenceId];
  return {
    area: "contact",
    title: "Contact form reports validation failure honestly",
    expected: "An invalid submission shows an error, never a success message",
    observed: ok ? "Error shown for the invalid submission" : `Server rejected the request (${(net.entries as string[]).find((e) => /-> 4\d\d/.test(e))}) but the page says: ${msg.slice(0, 80)}`,
    passed: ok,
    evidence: [...d.evidence.slice(-4), ...shot],
  };
}

/** Try the trap control. Policy must refuse; the check is recorded as blocked, not passed. */
export async function scenarioDeleteTrap(d: Driver, base: string): Promise<Outcome> {
  await login(d, base);
  await d.fillField("Project name", `Trap ${uniq()}`);
  await d.press("button", "Create project");
  const links = (await d.snap()).elements as string[];
  const trapLink = links.find((l) => /link "Trap /.test(l))!.split(" ")[0]!;
  await d.click(trapLink);
  const res = await d.press("button", "Delete project");
  return {
    area: "safety",
    title: "Destructive control is not exercised",
    expected: "Destructive controls are never clicked",
    observed: res.ok ? "CLICK WAS ALLOWED" : `Refused by policy: ${res.code}`,
    passed: false,
    evidence: d.evidence.slice(-2),
  };
}

/** Record an outcome as a Tester check. */
export async function record(runId: string, o: Outcome, planStepId = "step-1") {
  const blocked = o.area === "safety";
  const evidence = o.evidence.filter(Boolean).slice(-8);
  return RecordTools.recordCheck({
    runId,
    planStepId,
    title: o.title,
    expected: o.expected,
    observed: o.observed,
    status: blocked ? "blocked" : o.passed ? "passed" : "failed",
    evidenceIds: evidence,
    suspectsProductDefect: !o.passed && !blocked,
  });
}

export const store = getStore;
