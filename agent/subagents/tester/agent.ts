import { defineAgent } from "eve";
import { modelFor } from "../../../src/mock/model";

export default defineAgent({
  description: "Runs user workflows against the site with a browser, checks expected vs observed behaviour, and records passed/failed/blocked checks with evidence.",
  model: modelFor("tester"),
  reasoning: "low",
  modelContextWindowTokens: 200_000,
  tool: false,
  defaultTools: false,
  build: { externalDependencies: ["playwright", "playwright-core"] },
});
