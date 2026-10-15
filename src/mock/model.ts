import { mockModel } from "eve/evals";
import { anthropic } from "eve/models/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { openai } from "eve/models/openai";
import { modelId } from "../core/config";
import * as scripts from "./scripts";

type Role = "orchestrator" | "explorer" | "tester" | "investigator" | "reporter";

/**
 * Model selection.
 *  - GHOST_USER_MOCK=1          deterministic scripts (evals only)
 *  - GHOST_USER_PROVIDER=anthropic  direct Anthropic API (ANTHROPIC_API_KEY); GHOST_USER_MODEL = native model id (optional)
 *  - GHOST_USER_PROVIDER=openai     direct OpenAI API (OPENAI_API_KEY)
 *  - GHOST_USER_PROVIDER=gemini     direct Google Gemini API (GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY); GHOST_USER_MODEL optional
 *  - default                        Vercel AI Gateway id from GHOST_USER_MODEL (needs gateway credentials)
 */
export function modelFor(role: Role) {
  if (process.env.GHOST_USER_MOCK === "1") {
    return mockModel({ modelId: `ghost-user-${role}-script`, provider: "ghost-user-mock", respond: scripts[`${role}Script` as const] });
  }
  const native = process.env.GHOST_USER_MODEL || undefined;
  switch (process.env.GHOST_USER_PROVIDER) {
    case "anthropic":
      return anthropic(native);
    case "openai":
      return openai(native);
    case "gemini":
      return geminiModel(native);
    default:
      return modelId();
  }
}

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

/** Direct Gemini model via the AI SDK Google provider. Fails fast, without echoing any key, if no key is set. */
export function geminiModel(native?: string, env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    throw new Error("GHOST_USER_PROVIDER=gemini needs GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) in the environment.");
  }
  const id = (native ?? DEFAULT_GEMINI_MODEL).trim().replace(/^google\//u, "");
  if (!id || id.includes("/")) throw new Error("Expected a Gemini model ID such as gemini-3.5-flash.");
  return createGoogleGenerativeAI({ apiKey })(id);
}
