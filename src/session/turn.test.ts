import {
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import type {
  CopilotClient,
  CreateSessionOptions,
  MessageOptions,
  SessionEvent,
  ToolInvocation,
} from "@microsoft/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import { CopilotAuthError, type CopilotRuntime } from "../sdk/runtime.js";
import { createStreamSimple, DEBUG_ENV, type TurnDependencies } from "./turn.js";

function testModel(id = "gpt-test"): Model<Api> {
  return {
    id,
    name: id,
    api: "copilot-bridge",
    provider: "copilot-bridge",
    baseUrl: "",
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 100_000,
    maxTokens: 8_000,
  };
}

const readTool: Tool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

/** Stands in for a CopilotSession: tests push SDK events and inspect what the bridge did. */
class FakeSession {
  readonly sent: MessageOptions[] = [];
  readonly abort = vi.fn(() => Promise.resolve());
  readonly disconnect = vi.fn(() => Promise.resolve());
  readonly rpc = { model: { switchTo: vi.fn(() => Promise.resolve({})) } };
  /** When set, `send` resolves only after this promise does. */
  sendGate: Promise<void> | undefined;

  constructor(
    readonly options: CreateSessionOptions,
    readonly sessionId: string,
  ) {}

  async send(options: MessageOptions): Promise<string> {
    this.sent.push(options);
    await this.sendGate;
    return `user-${this.sent.length}`;
  }

  emit(type: string, data: object): void {
    const event = { type, data, id: "e", parentId: null, timestamp: "" } as unknown as SessionEvent;
    this.options.events?.onEvent?.(event);
  }

  /** Invokes a registered tool handler the way the runtime does after `external_tool.requested`. */
  callTool(name: string, toolCallId: string, signal?: AbortSignal): Promise<unknown> {
    const tool = this.options.tools?.definitions?.find((definition) => definition.name === name);
    const invocation: ToolInvocation = { sessionId: "s", toolCallId, toolName: name, arguments: {}, signal };
    return Promise.resolve(tool?.handler?.({}, invocation));
  }

  /** Emits a complete text reply followed by idle. */
  reply(text: string, messageId = "m1"): void {
    this.emit("assistant.message_delta", { messageId, deltaContent: text });
    this.emit("assistant.usage", { model: "gpt-test", inputTokens: 10, outputTokens: 2 });
    this.emit("assistant.message", { messageId, content: text });
    this.emit("session.idle", {});
  }

  requestTools(ids: string[], messageId = "m1"): void {
    const toolRequests = ids.map((toolCallId) => ({
      toolCallId,
      name: "read",
      arguments: { path: `${toolCallId}.ts` },
    }));
    this.emit("assistant.message", { messageId, content: "", toolRequests });
  }
}

function setup(overrides: Partial<TurnDependencies> = {}) {
  const sessions: FakeSession[] = [];
  const client = {
    createSession: vi.fn((options: CreateSessionOptions) => {
      const session = new FakeSession(options, `sdk-${sessions.length + 1}`);
      sessions.push(session);
      return Promise.resolve(session);
    }),
    deleteSession: vi.fn(() => Promise.resolve()),
  };
  const runtime: CopilotRuntime = {
    client: () => Promise.resolve(client as unknown as CopilotClient),
    stop: () => Promise.resolve(),
  };
  const bridge = createStreamSimple({
    runtime,
    supportedEfforts: () => ["low", "medium", "high"],
    ...overrides,
  });
  return { bridge, client, sessions };
}

function context(messages: Message[], tools: Tool[] = [readTool]) {
  return normalizeContext({ systemPrompt: "You are Pi.", tools, messages });
}

function user(text: string): Message {
  return { role: "user", content: text, timestamp: 0 };
}

function toolResult(toolCallId: string, text: string, isError = false): Message {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError,
    timestamp: 0,
  };
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Lets the bridge's async setup (client, createSession, send) run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const options: SimpleStreamOptions = { sessionId: "pi-1" };

/** Runs a first turn that ends with a plain reply and returns Pi's resulting history. */
async function firstTextTurn(harness: ReturnType<typeof setup>, prompt = "hi", reply = "hello") {
  const history = [user(prompt)];
  const stream = harness.bridge.streamSimple(testModel(), context(history), options);
  await settle();
  harness.sessions.at(-1)?.reply(reply);
  const message = await stream.result();
  return [...history, message];
}

describe("streamSimple: text turns", () => {
  it("creates the session with Pi in control and streams a text reply", async () => {
    const harness = setup();
    const onResponse = vi.fn();
    const stream = harness.bridge.streamSimple(testModel(), context([user("hi")]), {
      ...options,
      reasoning: "high",
      onResponse,
    });
    await settle();
    const [session] = harness.sessions;
    if (!session) throw new Error("no session");

    expect(session.options).toMatchObject({
      model: "gpt-test",
      clientName: "pi-copilot-bridge",
      inference: { reasoningEffort: "high", contextTier: "default" },
      tools: { availableTools: ["read"] },
      systemMessage: { mode: "replace", content: "You are Pi." },
      instructions: { skipCustomInstructions: true },
      state: { infiniteSessions: { enabled: false } },
      mcp: { disabledServers: ["github-mcp-server"] },
      events: { streaming: true },
    });
    const onRequest = session.options.permissions?.onRequest as (() => unknown) | undefined;
    expect(onRequest?.()).toEqual({ kind: "reject" });
    expect(session.sent).toEqual([{ prompt: "hi" }]);
    expect(onResponse).toHaveBeenCalledWith({ status: 200, headers: {} }, expect.anything());

    session.reply("Hällo 🌍");
    const events = await collect(stream);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    const message = await stream.result();
    expect(message).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Hällo 🌍" }] });
    expect(message.usage).toMatchObject({ input: 10, output: 2, totalTokens: 12 });
  });

  it("streams reasoning as thinking", async () => {
    const harness = setup();
    const stream = harness.bridge.streamSimple(testModel(), context([user("why?")]), options);
    await settle();
    const session = harness.sessions[0];
    session?.emit("assistant.reasoning_delta", { reasoningId: "r1", deltaContent: "Let me think" });
    session?.reply("Because.");
    const message = await stream.result();
    expect(message.content).toEqual([
      { type: "thinking", thinking: "Let me think" },
      { type: "text", text: "Because." },
    ]);
  });

  it("sends a follow-up prompt into the same session", async () => {
    const harness = setup();
    const history = await firstTextTurn(harness);

    const stream = harness.bridge.streamSimple(testModel(), context([...history, user("more")]), options);
    await settle();
    harness.sessions[0]?.reply("sure");
    await stream.result();

    expect(harness.sessions).toHaveLength(1);
    expect(harness.sessions[0]?.sent).toEqual([{ prompt: "hi" }, { prompt: "more" }]);
  });

  it("uses a payload returned by onPayload", async () => {
    const harness = setup();
    const onPayload = vi.fn(() => ({ prompt: "rewritten" }));
    harness.bridge.streamSimple(testModel(), context([user("hi")]), { ...options, onPayload });
    await settle();
    expect(onPayload).toHaveBeenCalledWith({ prompt: "hi" }, expect.anything());
    expect(harness.sessions[0]?.sent).toEqual([{ prompt: "rewritten" }]);
  });

  it("awaits onProviderStreamEvent with every raw SDK event", async () => {
    const harness = setup();
    const seen: string[] = [];
    const onProviderStreamEvent = vi.fn((event: unknown) => {
      seen.push((event as SessionEvent).type);
    });
    const stream = harness.bridge.streamSimple(testModel(), context([user("hi")]), {
      ...options,
      onProviderStreamEvent,
    });
    await settle();
    harness.sessions[0]?.reply("ok");
    await stream.result();
    expect(seen).toEqual(["assistant.message_delta", "assistant.usage", "assistant.message", "session.idle"]);
  });
});

describe("streamSimple: held tool calls", () => {
  it("ends Pi's message with toolUse and continues the same SDK turn with the result", async () => {
    const harness = setup();
    const history: Message[] = [user("read a")];
    const first = harness.bridge.streamSimple(testModel(), context(history), options);
    await settle();
    const session = harness.sessions[0];
    if (!session) throw new Error("no session");
    session.requestTools(["c1"]);
    const toolUse = await first.result();
    expect(toolUse.stopReason).toBe("toolUse");
    expect(toolUse.content).toEqual([
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "c1.ts" } },
    ]);

    const handlerResult = session.callTool("read", "c1");
    const second = harness.bridge.streamSimple(
      testModel(),
      context([...history, toolUse, toolResult("c1", "contents")]),
      options,
    );
    await expect(handlerResult).resolves.toBe("contents");
    session.reply("a says hi", "m2");
    const final = await second.result();

    expect(final).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "a says hi" }] });
    expect(session.sent).toHaveLength(1);
    expect(harness.sessions).toHaveLength(1);
  });

  it("delivers parallel results, also before the runtime invoked a handler", async () => {
    const harness = setup();
    const history: Message[] = [user("read a and b")];
    const first = harness.bridge.streamSimple(testModel(), context(history), options);
    await settle();
    const session = harness.sessions[0];
    if (!session) throw new Error("no session");
    session.requestTools(["c1", "c2"]);
    const toolUse = await first.result();

    const early = session.callTool("read", "c1");
    const second = harness.bridge.streamSimple(
      testModel(),
      context([...history, toolUse, toolResult("c1", "A"), toolResult("c2", "B")]),
      options,
    );
    await settle();
    const late = session.callTool("read", "c2"); // invoked after Pi already delivered c2's result
    await expect(early).resolves.toBe("A");
    await expect(late).resolves.toBe("B");

    session.reply("both read", "m2");
    await second.result();
    expect(session.sent).toHaveLength(1);
  });

  it("hands Pi's tool errors to the runtime as failures", async () => {
    const harness = setup();
    const history: Message[] = [user("read missing")];
    const first = harness.bridge.streamSimple(testModel(), context(history), options);
    await settle();
    const session = harness.sessions[0];
    if (!session) throw new Error("no session");
    session.requestTools(["c1"]);
    const toolUse = await first.result();

    const handlerResult = session.callTool("read", "c1");
    harness.bridge.streamSimple(
      testModel(),
      context([...history, toolUse, toolResult("c1", "ENOENT", true)]),
      options,
    );
    await expect(handlerResult).resolves.toMatchObject({ resultType: "failure", textResultForLlm: "ENOENT" });
  });
});

describe("streamSimple: images in tool results", () => {
  const screenshot: Message = {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "read",
    content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    isError: false,
    timestamp: 0,
  };

  async function handlerResultFor(model: Model<Api>, overrides: Partial<TurnDependencies> = {}) {
    const harness = setup(overrides);
    const history: Message[] = [user("look")];
    const first = harness.bridge.streamSimple(model, context(history), options);
    await settle();
    const session = harness.sessions[0];
    session.requestTools(["c1"]);
    const toolUse = await first.result();
    const handlerResult = session.callTool("read", "c1");
    harness.bridge.streamSimple(model, context([...history, toolUse, screenshot]), options);
    return handlerResult;
  }

  it("forwards them to a vision model within its limits", async () => {
    const result = await handlerResultFor(testModel(), {
      visionLimits: () => ({ supportedMediaTypes: ["image/png"], maxImages: 5 }),
    });
    expect(result).toMatchObject({
      resultType: "success",
      binaryResultsForLlm: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
  });

  it("replaces them with a note for a model without vision", async () => {
    const textOnly = { ...testModel(), input: ["text"] as Model<Api>["input"] };
    await expect(handlerResultFor(textOnly)).resolves.toBe("[image omitted]");
  });
});

describe("streamSimple: abort", () => {
  it("aborts mid-turn: SDK abort, aborted result, later events ignored", async () => {
    const harness = setup();
    const controller = new AbortController();
    const stream = harness.bridge.streamSimple(testModel(), context([user("long story")]), {
      ...options,
      signal: controller.signal,
    });
    await settle();
    const session = harness.sessions[0];
    session?.emit("assistant.message_delta", { messageId: "m1", deltaContent: "Once" });
    await settle();
    controller.abort();
    session?.emit("assistant.message_delta", { messageId: "m1", deltaContent: " upon" });

    const events = await collect(stream);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(session?.abort).toHaveBeenCalledOnce();
    const message = await stream.result();
    expect(message.content).toEqual([{ type: "text", text: "Once" }]);
  });

  it("aborts mid-tool: an already aborted call fails the held handlers and aborts the SDK turn", async () => {
    const harness = setup();
    const history: Message[] = [user("read a")];
    const first = harness.bridge.streamSimple(testModel(), context(history), options);
    await settle();
    const session = harness.sessions[0];
    if (!session) throw new Error("no session");
    session.requestTools(["c1"]);
    const toolUse = await first.result();
    const handlerResult = session.callTool("read", "c1");

    const controller = new AbortController();
    controller.abort();
    const second = harness.bridge.streamSimple(
      testModel(),
      context([...history, toolUse, toolResult("c1", "Operation aborted", true)]),
      { ...options, signal: controller.signal },
    );

    expect((await second.result()).stopReason).toBe("aborted");
    await expect(handlerResult).resolves.toMatchObject({ resultType: "failure" });
    expect(session.abort).toHaveBeenCalledOnce();
  });

  it("aborts while the continued SDK turn runs", async () => {
    const harness = setup();
    const history: Message[] = [user("read a")];
    const first = harness.bridge.streamSimple(testModel(), context(history), options);
    await settle();
    const session = harness.sessions[0];
    if (!session) throw new Error("no session");
    session.requestTools(["c1"]);
    const toolUse = await first.result();

    const controller = new AbortController();
    const second = harness.bridge.streamSimple(
      testModel(),
      context([...history, toolUse, toolResult("c1", "x")]),
      {
        ...options,
        signal: controller.signal,
      },
    );
    await settle();
    controller.abort();
    expect((await second.result()).stopReason).toBe("aborted");
    expect(session.abort).toHaveBeenCalledOnce();
  });
});

describe("streamSimple: errors", () => {
  it("ends with the SDK's error message and rebuilds on the next turn", async () => {
    const harness = setup();
    const history: Message[] = [user("hi")];
    const stream = harness.bridge.streamSimple(testModel(), context(history), options);
    await settle();
    harness.sessions[0]?.emit("session.error", { errorType: "query", message: "Bad request" });
    const failed = await stream.result();
    expect(failed).toMatchObject({ stopReason: "error", errorMessage: "Bad request" });

    harness.bridge.streamSimple(testModel(), context(history), options);
    await settle();
    expect(harness.sessions).toHaveLength(2);
    expect(harness.sessions[0]?.disconnect).toHaveBeenCalled();
    expect(harness.sessions[1]?.sent).toEqual([{ prompt: "hi" }]);
  });

  it("fails without start when the runtime is not logged in", async () => {
    const runtime: CopilotRuntime = {
      client: () => Promise.reject(new CopilotAuthError("Run `copilot` and `/login`.")),
      stop: () => Promise.resolve(),
    };
    const { streamSimple } = createStreamSimple({ runtime, supportedEfforts: () => undefined });
    const stream = streamSimple(testModel(), context([user("hi")]), options);
    const events = await collect(stream);
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect((await stream.result()).errorMessage).toBe("Run `copilot` and `/login`.");
  });
});

describe("streamSimple: session sync", () => {
  it("rebuilds after a forked history with the transcript and the new message in one send", async () => {
    const harness = setup();
    await firstTextTurn(harness, "hi", "hello");

    const forked: Message[] = [
      user("hi, but edited"),
      assistantMessage("other answer"),
      user("new question"),
    ];
    harness.bridge.streamSimple(testModel(), context(forked), options);
    await settle();

    expect(harness.sessions).toHaveLength(2);
    expect(harness.sessions[0]?.disconnect).toHaveBeenCalled();
    const [sent] = harness.sessions[1]?.sent ?? [];
    expect(harness.sessions[1]?.sent).toHaveLength(1);
    expect(sent?.prompt).toContain("<conversation_history>");
    expect(sent?.prompt).toContain("hi, but edited");
    expect(sent?.prompt).toContain("other answer");
    expect(sent?.prompt.endsWith("new question")).toBe(true);
  });

  it("rebuilds when Pi's tool set changed", async () => {
    const harness = setup();
    const history = await firstTextTurn(harness);
    const grep: Tool = { name: "grep", description: "Search", parameters: { type: "object" } };
    harness.bridge.streamSimple(
      testModel(),
      context([...history, user("search")], [readTool, grep]),
      options,
    );
    await settle();
    expect(harness.sessions).toHaveLength(2);
    expect(harness.sessions[1]?.options.tools?.availableTools).toEqual(["read", "grep"]);
  });

  it("switches the model in place between turns", async () => {
    const harness = setup();
    const history = await firstTextTurn(harness);
    harness.bridge.streamSimple(testModel("claude-test"), context([...history, user("more")]), {
      ...options,
      reasoning: "low",
    });
    await settle();
    expect(harness.sessions).toHaveLength(1);
    expect(harness.sessions[0]?.rpc.model.switchTo).toHaveBeenCalledWith({
      modelId: "claude-test",
      reasoningEffort: "low",
      contextTier: "default",
    });
    expect(harness.sessions[0]?.sent.at(-1)).toEqual({ prompt: "more" });
  });

  it("rebuilds when the runtime refuses the model switch", async () => {
    const harness = setup();
    const history = await firstTextTurn(harness);
    harness.sessions[0]?.rpc.model.switchTo.mockRejectedValueOnce(new Error("unknown model"));
    harness.bridge.streamSimple(testModel("claude-test"), context([...history, user("more")]), options);
    await settle();
    expect(harness.sessions).toHaveLength(2);
    expect(harness.sessions[1]?.options.model).toBe("claude-test");
    expect(harness.sessions[1]?.sent[0]?.prompt).toContain("<conversation_history>");
  });

  it("serves one-off summary requests from a throwaway session", async () => {
    const harness = setup();
    const history = await firstTextTurn(harness);
    const summary = harness.bridge.streamSimple(testModel(), context([user("Summarize.")], []), {
      ...options,
      cacheRetention: "none",
    });
    await settle();
    harness.sessions[1]?.reply("summary");
    await summary.result();
    await settle();
    expect(harness.sessions[1]?.disconnect).toHaveBeenCalled();
    expect(harness.client.deleteSession).toHaveBeenCalledWith("sdk-2");
    expect(harness.sessions[0]?.disconnect).not.toHaveBeenCalled();

    harness.bridge.streamSimple(testModel(), context([...history, user("more")]), options);
    await settle();
    expect(harness.sessions[0]?.sent.at(-1)).toEqual({ prompt: "more" });
  });

  it("keeps Pi sessions apart and disposes all of them", async () => {
    const harness = setup();
    harness.bridge.streamSimple(testModel(), context([user("a")]), { sessionId: "pi-a" });
    harness.bridge.streamSimple(testModel(), context([user("b")]), { sessionId: "pi-b" });
    await settle();
    expect(harness.sessions).toHaveLength(2);
    await harness.bridge.disposeAll();
    for (const session of harness.sessions) expect(session.disconnect).toHaveBeenCalled();
    // The bridge never resumes SDK sessions, so it deletes their stored history.
    expect(harness.client.deleteSession.mock.calls).toEqual([["sdk-1"], ["sdk-2"]]);
  });
});

/** A finished assistant message as Pi would store it, for building edited histories. */
function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "copilot-bridge",
    provider: "copilot-bridge",
    model: "gpt-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

/** Runs a first turn that ends with tool calls; returns the session and Pi's history so far. */
async function firstToolTurn(harness: ReturnType<typeof setup>, ids = ["c1"]) {
  const history: Message[] = [user("read a")];
  const stream = harness.bridge.streamSimple(testModel(), context(history), options);
  await settle();
  const session = harness.sessions.at(-1)!;
  session.requestTools(ids);
  const toolUse = await stream.result();
  return { session, history: [...history, toolUse] };
}

describe("streamSimple: held turn lost", () => {
  it("rebuilds instead of waiting forever when the runtime cancelled a held call", async () => {
    const harness = setup();
    const { session, history } = await firstToolTurn(harness);
    const runtimeGivesUp = new AbortController();
    const handler = session.callTool("read", "c1", runtimeGivesUp.signal);
    runtimeGivesUp.abort();
    await handler;

    const next = harness.bridge.streamSimple(
      testModel(),
      context([...history, toolResult("c1", "contents")]),
      options,
    );
    await settle();
    expect(harness.sessions).toHaveLength(2);
    expect(harness.sessions[1]?.sent[0]?.prompt).toContain("contents");
    harness.sessions[1]?.reply("done");
    expect((await next.result()).stopReason).toBe("stop");
  });

  it("rebuilds when the held SDK turn went idle while Pi ran the tools", async () => {
    const harness = setup();
    const { session, history } = await firstToolTurn(harness);
    session.emit("session.idle", {});
    await settle();
    harness.bridge.streamSimple(testModel(), context([...history, toolResult("c1", "x")]), options);
    await settle();
    expect(harness.sessions).toHaveLength(2);
  });

  it("delivers steering after tool results into the running turn, before the results", async () => {
    const harness = setup();
    const { session, history } = await firstToolTurn(harness);
    const order: string[] = [];
    const handler = session.callTool("read", "c1").then(() => order.push("result"));
    const send = session.send.bind(session);
    session.send = (message: MessageOptions) => {
      order.push("steering");
      return send(message);
    };
    const next = harness.bridge.streamSimple(
      testModel(),
      context([...history, toolResult("c1", "x"), user("also check b")]),
      options,
    );
    await handler;
    expect(session.sent.at(-1)).toEqual({ prompt: "also check b", mode: "immediate" });
    expect(order).toEqual(["steering", "result"]);
    session.reply("checked both", "m2");
    await next.result();
    expect(harness.sessions).toHaveLength(1);
  });
});

describe("streamSimple: request isolation", () => {
  it("fails a second concurrent request on the same Pi session and keeps the first", async () => {
    const harness = setup();
    const first = harness.bridge.streamSimple(testModel(), context([user("hi")]), options);
    const second = harness.bridge.streamSimple(testModel(), context([user("hi")]), options);
    expect(await second.result()).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringMatching(/still running/) as unknown,
    });
    await settle();
    harness.sessions[0]?.reply("hello");
    expect((await first.result()).stopReason).toBe("stop");
    expect(harness.sessions).toHaveLength(1);
  });

  it("serves requests without a session id from separate throwaway sessions", async () => {
    const harness = setup();
    const a = harness.bridge.streamSimple(testModel(), context([user("a")]));
    const b = harness.bridge.streamSimple(testModel(), context([user("b")]));
    await settle();
    expect(harness.sessions).toHaveLength(2);
    harness.sessions[0]?.reply("A");
    harness.sessions[1]?.reply("B");
    await Promise.all([a.result(), b.result()]);
    await settle();
    expect(harness.client.deleteSession).toHaveBeenCalledTimes(2);
  });

  it("answers cache-warming replays without sending anything", async () => {
    const harness = setup();
    const stream = harness.bridge.streamSimple(testModel(), context([user("hi")]), {
      ...options,
      maxTokens: 1,
      disableContinuation: true,
    });
    expect((await stream.result()).stopReason).toBe("error");
    await settle();
    expect(harness.client.createSession).not.toHaveBeenCalled();
  });

  it("aborts again when Pi aborted while the prompt was being sent", async () => {
    const harness = setup();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    harness.client.createSession.mockImplementationOnce((sessionOptions: CreateSessionOptions) => {
      const session = new FakeSession(sessionOptions, "sdk-1");
      session.sendGate = gate;
      harness.sessions.push(session);
      return Promise.resolve(session);
    });
    const controller = new AbortController();
    const stream = harness.bridge.streamSimple(testModel(), context([user("hi")]), {
      ...options,
      signal: controller.signal,
    });
    await settle();
    controller.abort();
    expect((await stream.result()).stopReason).toBe("aborted");
    const abortsBefore = harness.sessions[0]?.abort.mock.calls.length ?? 0;
    open();
    await settle();
    expect(harness.sessions[0]?.abort.mock.calls.length).toBe(abortsBefore + 1);
  });
});

describe("streamSimple: errors and rebuilds", () => {
  it("keeps the session after a transient error and resends the prompt on retry", async () => {
    const harness = setup();
    const history = await firstTextTurn(harness);
    const prompt = [...history, user("more")];
    const failing = harness.bridge.streamSimple(testModel(), context(prompt), options);
    await settle();
    harness.sessions[0]?.emit("session.error", { errorType: "rate_limit", message: "Rate limited" });
    expect((await failing.result()).stopReason).toBe("error");

    const retry = harness.bridge.streamSimple(testModel(), context(prompt), options);
    await settle();
    harness.sessions[0]?.reply("sure", "m2");
    await retry.result();
    expect(harness.sessions).toHaveLength(1);
    expect(harness.sessions[0]?.sent).toEqual([{ prompt: "hi" }, { prompt: "more" }, { prompt: "more" }]);
  });

  it("counts every new SDK session and logs the reason without content when debugging", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubEnv(DEBUG_ENV, "1");
    try {
      const harness = setup();
      await firstTextTurn(harness, "secret prompt");
      harness.bridge.streamSimple(testModel(), context([user("edited secret"), user("next")]), options);
      await settle();
      expect(harness.bridge.rebuildCount()).toBe(2);
      const lines = write.mock.calls.map(([line]) => String(line));
      expect(lines).toEqual([
        "[pi-copilot-bridge] new SDK session #1: no-session\n",
        "[pi-copilot-bridge] new SDK session #2: history-diverged\n",
      ]);
    } finally {
      vi.unstubAllEnvs();
      write.mockRestore();
    }
  });
});

describe("streamSimple: spend", () => {
  it("sums credits of all SDK sessions that served a Pi session, one-off summaries included", async () => {
    const onUsage = vi.fn();
    const harness = setup({ onUsage });
    const history = await firstTextTurn(harness);
    harness.sessions[0]?.emit("session.usage_checkpoint", { totalNanoAiu: 10 });
    harness.sessions[0]?.emit("session.usage_checkpoint", { totalNanoAiu: 14 });

    const summary = harness.bridge.streamSimple(testModel(), context([user("Summarize.")], []), {
      ...options,
      cacheRetention: "none",
    });
    await settle();
    harness.sessions[1]?.emit("session.usage_checkpoint", { totalNanoAiu: 5 });
    harness.sessions[1]?.reply("summary");
    await summary.result();

    const rewritten = [user("rewritten"), ...history.slice(1), user("x")];
    harness.bridge.streamSimple(testModel(), context(rewritten), options);
    await settle();
    harness.sessions[2]?.emit("session.usage_checkpoint", { totalNanoAiu: 3 });

    expect(onUsage.mock.calls.map(([usage]) => usage as unknown)).toEqual([
      { piSessionKey: "pi-1", nanoAiu: 10 },
      { piSessionKey: "pi-1", nanoAiu: 14 },
      { piSessionKey: "pi-1", nanoAiu: 19 },
      { piSessionKey: "pi-1", nanoAiu: 22 },
    ]);
  });
});
