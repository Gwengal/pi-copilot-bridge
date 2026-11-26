import type { Model } from "@microsoft/copilot-sdk";
import { describe, expect, it } from "vitest";
import { supportedEffortsById, toPiModels } from "./models.js";

const haiku: Model = {
  id: "claude-haiku-5.5",
  name: "Claude Haiku 5.5",
  capabilities: {
    supports: { vision: true },
    limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
  },
  billing: { tokenPrices: { inputPrice: 10, outputPrice: 50 } },
  supportedReasoningEfforts: ["low", "medium", "high"],
};

const luna: Model = {
  id: "gpt-6-luna",
  name: "GPT-6 Luna",
  capabilities: { supports: {}, limits: { max_context_window_tokens: 400_000, max_output_tokens: 128_000 } },
  supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
};

const auto: Model = {
  id: "auto",
  name: "Auto",
  capabilities: { supports: { vision: true }, limits: { max_context_window_tokens: 0 } },
  billing: {},
};

const mai: Model = {
  id: "mai-code-2",
  name: "MAI Code 2",
  capabilities: { limits: { max_context_window_tokens: 128_000, max_output_tokens: 8_000 } },
  billing: { tokenPrices: { inputPrice: 4, outputPrice: 20 }, promo: { discountPercent: 50 } },
};

const disabled: Model = {
  id: "old-model",
  name: "Old",
  capabilities: {},
  policy: { state: "disabled" },
};

describe("toPiModels", () => {
  const models = toPiModels([haiku, luna, auto, mai, disabled]);
  const byId = (id: string) => models.find((m) => m.id === id);

  it("skips models disabled by policy and keeps ids unchanged", () => {
    expect(models.map((m) => m.id)).toEqual(["claude-haiku-5.5", "gpt-6-luna", "auto", "mai-code-2"]);
  });

  it("adds a price hint to the name", () => {
    expect(byId("claude-haiku-5.5")?.name).toBe("Claude Haiku 5.5 · 10/50 cr");
    expect(byId("mai-code-2")?.name).toBe("MAI Code 2 · 4/20 cr · -50%");
    expect(byId("auto")?.name).toBe("Auto");
    expect(byId("gpt-6-luna")?.name).toBe("GPT-6 Luna");
  });

  it("maps limits with fallbacks", () => {
    expect(byId("claude-haiku-5.5")).toMatchObject({ contextWindow: 200_000, maxTokens: 64_000 });
    expect(byId("auto")).toMatchObject({ contextWindow: 128_000, maxTokens: 16_384 });
  });

  it("uses the default price tier's prompt budget as context window, not the long-context maximum", () => {
    const opus: Model = {
      id: "claude-opus-5.5",
      name: "Claude Opus 5.5",
      capabilities: { limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 64_000 } },
      billing: {
        tokenPrices: {
          inputPrice: 50,
          outputPrice: 250,
          maxPromptTokens: 200_000,
          longContext: { inputPrice: 100, outputPrice: 375, maxPromptTokens: 1_000_000 },
        },
      },
    };
    const tiny: Model = {
      id: "tiny",
      name: "Tiny",
      capabilities: { limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 64_000 } },
      billing: { tokenPrices: { maxPromptTokens: 32_000 } },
    };
    const [mappedOpus, mappedTiny] = toPiModels([opus, tiny]);
    expect(mappedOpus).toMatchObject({ contextWindow: 200_000, maxTokens: 64_000 });
    expect(mappedTiny).toMatchObject({ contextWindow: 32_000, maxTokens: 32_000 });
  });

  it("derives reasoning and input types", () => {
    expect(byId("claude-haiku-5.5")).toMatchObject({ reasoning: true, input: ["text", "image"] });
    expect(byId("mai-code-2")).toMatchObject({ reasoning: false, input: ["text"] });
  });

  it("reports zero dollar cost", () => {
    expect(byId("claude-haiku-5.5")?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("supportedEffortsById", () => {
  it("maps ids to listed efforts, empty when absent", () => {
    const map = supportedEffortsById([luna, auto]);
    expect(map.get("gpt-6-luna")).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(map.get("auto")).toEqual([]);
  });
});
