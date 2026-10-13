import { defineAgent } from "eve";
import { modelFor } from "../src/mock/model";
import { loadModelLimits } from "../src/core/config";

const limits = loadModelLimits();

/**
 * Ghost User orchestrator. It delegates to four declared subagents through the `delegate`
 * workflow tool only (the built-in `agent` copy tool is disabled), so every delegation passes
 * the budget, retry and routing checks in code.
 */
export default defineAgent({
  description: "Autonomous website QA orchestrator: explore, test, investigate, report.",
  model: modelFor("orchestrator"),
  reasoning: "low",
  modelContextWindowTokens: 200_000,
  tool: false,
  defaultTools: false,
  limits: {
    ...(limits.maxInputTokensPerSession ? { maxInputTokensPerSession: limits.maxInputTokensPerSession } : {}),
    ...(limits.maxTokenCostUsdPerSession ? { maxTokenCostUsdPerSession: limits.maxTokenCostUsdPerSession } : {}),
    maxOutputTokensPerSession: 60_000,
  },
  build: { externalDependencies: ["playwright", "playwright-core"] },
});
