import { mockModel } from "eve/evals";
import { anthropic } from "eve/models/anthropic";
import { openai } from "eve/models/openai";
import { modelId } from "../core/config";
import * as scripts from "./scripts";

type Role = "orchestrator" | "explorer" | "tester" | "investigator" | "reporter";

/**
 * Model selection.
 *  - GHOST_USER_MOCK=1          deterministic scripts (evals only)
 *  - GHOST_USER_PROVIDER=anthropic  direct Anthropic API (ANTHROPIC_API_KEY); GHOST_USER_MODEL = native model id (optional)
 *  - GHOST_USER_PROVIDER=openai     direct OpenAI API (OPENAI_API_KEY)
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
    default:
      return modelId();
  }
}
