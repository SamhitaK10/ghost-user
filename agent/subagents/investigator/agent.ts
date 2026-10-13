import { defineAgent } from "eve";
import { modelFor } from "../../../src/mock/model";

export default defineAgent({
  description: "Re-examines suspected failures: reproduces them independently, rules out test-environment causes, and records confirmed / dismissed / inconclusive verdicts with evidence.",
  model: modelFor("investigator"),
  reasoning: "low",
  modelContextWindowTokens: 200_000,
  tool: false,
  defaultTools: false,
  build: { externalDependencies: ["playwright", "playwright-core"] },
});
