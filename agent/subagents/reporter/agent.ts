import { defineAgent } from "eve";
import { modelFor } from "../../../src/mock/model";

export default defineAgent({
  description: "Turns the stored run facts into the final QA report: executive summary and grouping of findings. Has no browser access.",
  model: modelFor("reporter"),
  reasoning: "low",
  modelContextWindowTokens: 200_000,
  tool: false,
  defaultTools: false,
  build: { externalDependencies: ["playwright", "playwright-core"] },
});
