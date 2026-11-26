import { describe, expect, it } from "vitest";
import { resolveReasoningEffort } from "./effort.js";

const FULL = ["none", "low", "medium", "high", "xhigh", "max"];

describe("resolveReasoningEffort", () => {
  it("returns undefined when the model lists no efforts or no level is given", () => {
    expect(resolveReasoningEffort(undefined, "high")).toBeUndefined();
    expect(resolveReasoningEffort([], "high")).toBeUndefined();
    expect(resolveReasoningEffort(FULL, undefined)).toBeUndefined();
  });

  it("passes through supported values", () => {
    expect(resolveReasoningEffort(FULL, "medium")).toBe("medium");
    expect(resolveReasoningEffort(FULL, "max")).toBe("max");
  });

  it("maps off to none and minimal to low", () => {
    expect(resolveReasoningEffort(FULL, "off")).toBe("none");
    expect(resolveReasoningEffort(FULL, "minimal")).toBe("low");
  });

  it("sends nothing for off when the model cannot switch reasoning off", () => {
    expect(resolveReasoningEffort(["low", "medium", "high"], "off")).toBeUndefined();
  });

  it("clamps down to the strongest supported value at or below the request", () => {
    expect(resolveReasoningEffort(["low", "medium", "high"], "max")).toBe("high");
    expect(resolveReasoningEffort(["low", "high"], "medium")).toBe("low");
  });

  it("falls back to the lowest supported reasoning value when all are stronger", () => {
    expect(resolveReasoningEffort(["medium", "high"], "minimal")).toBe("medium");
    expect(resolveReasoningEffort(["none", "high"], "low")).toBe("high");
  });

  it("ignores unknown levels", () => {
    expect(resolveReasoningEffort(FULL, "turbo")).toBeUndefined();
  });
});
