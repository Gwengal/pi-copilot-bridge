import { describe, expect, it } from "vitest";
import { FALLBACK_EFFORTS, FALLBACK_MODELS, FALLBACK_VISION } from "./fallback-models.js";

describe("fallback catalog", () => {
  it("has efforts for every model and vision limits exactly for the models that accept images", () => {
    expect(Object.keys(FALLBACK_EFFORTS).sort()).toEqual(FALLBACK_MODELS.map((model) => model.id).sort());
    const visionIds = FALLBACK_MODELS.filter((model) => model.input.includes("image")).map(
      (model) => model.id,
    );
    expect(Object.keys(FALLBACK_VISION).sort()).toEqual(visionIds.sort());
    expect(FALLBACK_VISION["claude-opus-5.5"]).toMatchObject({ maxImages: 1, maxImageBytes: 3_145_728 });
  });
});
