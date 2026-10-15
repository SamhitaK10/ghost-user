import { describe, expect, it } from "vitest";
import { geminiModel, DEFAULT_GEMINI_MODEL } from "../src/mock/model";

describe("gemini provider selection", () => {
  it("requires a key and never echoes one", () => {
    expect(() => geminiModel(undefined, {})).toThrow(/GEMINI_API_KEY/);
  });
  it("builds a google model with the default or a given id (no network)", () => {
    const m = geminiModel(undefined, { GEMINI_API_KEY: "test-key-not-real" }) as { provider: string; modelId: string };
    expect(m.modelId).toBe(DEFAULT_GEMINI_MODEL);
    expect(m.provider).toMatch(/google/);
    const n = geminiModel("google/gemini-2.5-flash", { GOOGLE_GENERATIVE_AI_API_KEY: "x" }) as { modelId: string };
    expect(n.modelId).toBe("gemini-2.5-flash");
  });
  it("rejects malformed ids", () => {
    expect(() => geminiModel("a/b", { GEMINI_API_KEY: "x" })).toThrow(/Gemini model ID/);
  });
});
