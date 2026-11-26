import type { Tool as PiTool, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Tool as SdkTool, ToolInvocation } from "@microsoft/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import { HeldToolCalls, IMAGE_OMITTED, toHeldToolResult } from "./tools.js";

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

describe("toHeldToolResult", () => {
  it("joins text blocks and replaces images with a note", () => {
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [
        { type: "text", text: "line 1" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "line 2" },
      ],
      isError: false,
      timestamp: 0,
    };
    expect(toHeldToolResult(message)).toEqual({ text: `line 1\n${IMAGE_OMITTED}\nline 2`, isError: false });
  });
});
