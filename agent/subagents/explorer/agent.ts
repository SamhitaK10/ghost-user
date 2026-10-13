import { defineAgent } from "eve";
import { modelFor } from "../../../src/mock/model";

export default defineAgent({
  description: "Maps the target site: pages, navigation, forms and key actions. Read-only exploration; returns a compact navigation map and proposed test paths.",
  model: modelFor("explorer"),
  reasoning: "low",
  modelContextWindowTokens: 200_000,
  tool: false,
  defaultTools: false,
  build: { externalDependencies: ["playwright", "playwright-core"] },
});
