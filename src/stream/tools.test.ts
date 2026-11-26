import type { Tool as PiTool, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Tool as SdkTool, ToolInvocation } from "@microsoft/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import { HeldToolCalls, IMAGE_OMITTED, toHeldToolResults } from "./tools.js";

const readTool: PiTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

function invoke(tool: SdkTool, toolCallId: string, signal?: AbortSignal): Promise<unknown> {
  const invocation: ToolInvocation = {
    sessionId: "s",
    toolCallId,
    toolName: tool.name,
    arguments: {},
    signal,
  };
  return Promise.resolve(tool.handler?.({}, invocation));
}

function setup() {
  const held = new HeldToolCalls();
  const [tool] = held.createTools([readTool]);
  if (!tool) throw new Error("no tool");
  return { held, tool };
}

describe("HeldToolCalls.createTools", () => {
  it("declares Pi's schema, skips permission prompts and overrides same-named built-ins", () => {
    const { tool } = setup();
    expect(tool).toMatchObject({
      name: "read",
      description: "Read a file",
      parameters: readTool.parameters,
      skipPermission: true,
      overridesBuiltInTool: true,
    });
  });
});

describe("HeldToolCalls handlers", () => {
  it("wait until Pi resolves the call", async () => {
    const { held, tool } = setup();
    const result = invoke(tool, "call-1");
    await Promise.resolve();
    expect(held.pendingIds()).toEqual(["call-1"]);

    held.resolve("call-1", { text: "file contents", isError: false });
    await expect(result).resolves.toBe("file contents");
    expect(held.pendingIds()).toEqual([]);
  });

  it("return a result Pi delivered before the runtime invoked the handler", async () => {
    const { held, tool } = setup();
    held.resolve("call-1", { text: "early", isError: false });
    await expect(invoke(tool, "call-1")).resolves.toBe("early");
  });

  it("report Pi's tool errors as failures", async () => {
    const { held, tool } = setup();
    const result = invoke(tool, "call-1");
    held.resolve("call-1", { text: "ENOENT", isError: true });
    await expect(result).resolves.toEqual({
      textResultForLlm: "ENOENT",
      resultType: "failure",
      error: "ENOENT",
    });
  });

  it("fail every waiting call on abortAll", async () => {
    const { held, tool } = setup();
    const first = invoke(tool, "call-1");
    const second = invoke(tool, "call-2");
    held.abortAll("Aborted");
    await expect(first).resolves.toMatchObject({ resultType: "failure", textResultForLlm: "Aborted" });
    await expect(second).resolves.toMatchObject({ resultType: "failure" });
    expect(held.pendingIds()).toEqual([]);
  });

  it("stop waiting when the runtime cancels the call", async () => {
    const { held, tool } = setup();
    const controller = new AbortController();
    const result = invoke(tool, "call-1", controller.signal);
    controller.abort();
    await expect(result).resolves.toMatchObject({ resultType: "failure" });
    expect(held.pendingIds()).toEqual([]);
  });

  it("report a runtime cancellation to the owner, but not a normal settle", async () => {
    const cancelled: string[] = [];
    const held = new HeldToolCalls((id) => cancelled.push(id));
    const [tool] = held.createTools([readTool]);
    if (!tool) throw new Error("no tool");
    const settled = new AbortController();
    const removeListener = vi.spyOn(settled.signal, "removeEventListener");
    const first = invoke(tool, "call-1", settled.signal);
    held.resolve("call-1", { text: "ok", isError: false });
    await first;
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    settled.abort();

    const runtimeGivesUp = new AbortController();
    const second = invoke(tool, "call-2", runtimeGivesUp.signal);
    runtimeGivesUp.abort();
    await second;
    expect(cancelled).toEqual(["call-2"]);
  });

  it("forget early results once the turn ended", async () => {
    const { held, tool } = setup();
    held.resolve("call-1", { text: "early", isError: false });
    held.forgetEarly();
    const result = invoke(tool, "call-1");
    await Promise.resolve();
    expect(held.pendingIds()).toEqual(["call-1"]);
    held.abortAll("done");
    await result;
  });
});

describe("toHeldToolResults", () => {
  const png = (data = "AAAA") => ({ type: "image" as const, data, mimeType: "image/png" });
  const result = (content: ToolResultMessage["content"], toolCallId = "call-1"): ToolResultMessage => ({
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content,
    isError: false,
    timestamp: 0,
  });

  it("replaces images with a note for a model without vision", () => {
    const message = result([{ type: "text", text: "line 1" }, png(), { type: "text", text: "line 2" }]);
    expect(toHeldToolResults([message], undefined)).toEqual([
      { text: `line 1\n${IMAGE_OMITTED}\nline 2`, isError: false },
    ]);
  });

  it("forwards images as binary results to a vision model", () => {
    const [held] = toHeldToolResults([result([{ type: "text", text: "shot" }, png()])], {});
    expect(held).toEqual({
      text: "shot\n[image attached]",
      isError: false,
      images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
  });

  it("notes unsupported types and oversized images instead of forwarding them", () => {
    const gif = { type: "image" as const, data: "AAAA", mimeType: "image/gif" };
    const big = png("A".repeat(8)); // 6 bytes
    const [held] = toHeldToolResults([result([gif, big])], {
      supportedMediaTypes: ["image/png", "image/jpeg"],
      maxImageBytes: 5,
    });
    expect(held?.images).toBeUndefined();
    expect(held?.text).toBe(
      "[image omitted: image/gif is not supported by this model]\n" +
        "[image omitted: 6 bytes exceed the model's limit of 5 bytes]",
    );
  });

  it("caps images across all results of one batch", () => {
    const held = toHeldToolResults([result([png(), png()], "a"), result([png()], "b")], { maxImages: 2 });
    expect(held.map((entry) => entry.images?.length ?? 0)).toEqual([2, 0]);
    expect(held[1]?.text).toBe("[image omitted: limit of 2 images per request reached]");
  });
});

describe("HeldToolCalls with images", () => {
  it("returns a success object with binary results to the SDK", async () => {
    const calls = new HeldToolCalls();
    const [tool] = calls.createTools([readTool]);
    const pending = invoke(tool, "call-1");
    calls.resolve("call-1", {
      text: "[image attached]",
      isError: false,
      images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
    await expect(pending).resolves.toEqual({
      textResultForLlm: "[image attached]",
      resultType: "success",
      binaryResultsForLlm: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
  });
});
