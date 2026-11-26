import {
  createAssistantMessageEventStream,
  isContextOverflow,
  type Api,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { SessionEvent } from "@microsoft/copilot-sdk";
import { describe, expect, it } from "vitest";
import { CONTEXT_OVERFLOW_CODE, parseToolArguments, PiTurnWriter } from "./translate.js";

const model: Model<Api> = {
  id: "gpt-test",
  name: "GPT Test",
  api: "copilot-bridge",
  provider: "copilot-bridge",
  baseUrl: "",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: true,
  contextWindow: 100_000,
  maxTokens: 8_000,
};

/** Builds an SDK event; only `type`, `data` and `agentId` matter to the writer. */
function sdk(type: string, data: object, extra: object = {}): SessionEvent {
  return { type, data, id: "e", parentId: null, timestamp: "", ...extra } as unknown as SessionEvent;
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function writerWithStream() {
  const stream = createAssistantMessageEventStream();
  const ended: unknown[] = [];
  const writer = new PiTurnWriter(model, stream, (message) => ended.push(message));
  return { stream, writer, ended };
}

describe("PiTurnWriter", () => {
  it("streams text deltas, including multi-byte Unicode, into one balanced text block", async () => {
    const { stream, writer, ended } = writerWithStream();
    writer.start();
    writer.apply(sdk("assistant.message_delta", { messageId: "m1", deltaContent: "Grüße " }));
    writer.apply(sdk("assistant.message_delta", { messageId: "m1", deltaContent: "🌍👩‍💻" }));
    writer.apply(sdk("assistant.message", { messageId: "m1", content: "Grüße 🌍👩‍💻" }));
    writer.apply(sdk("session.idle", {}));

    const events = await collect(stream);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(writer.message.content).toEqual([{ type: "text", text: "Grüße 🌍👩‍💻" }]);
    expect(writer.message.stopReason).toBe("stop");
    expect(ended).toHaveLength(1);
  });

  it("emits a complete message that was not streamed", async () => {
    const { stream, writer } = writerWithStream();
    writer.apply(sdk("assistant.message", { messageId: "m1", content: "whole" }));
    writer.apply(sdk("session.idle", {}));
    const events = await collect(stream);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
  });

  it("puts reasoning in a thinking block before the text", async () => {
    const { stream, writer } = writerWithStream();
    writer.apply(sdk("assistant.reasoning_delta", { reasoningId: "r1", deltaContent: "think" }));
    writer.apply(sdk("assistant.reasoning", { reasoningId: "r1", content: "think" }));
    writer.apply(sdk("assistant.reasoning", { reasoningId: "r2", content: "unstreamed" }));
    writer.apply(sdk("assistant.message_delta", { messageId: "m1", deltaContent: "answer" }));
    writer.apply(sdk("assistant.message", { messageId: "m1", content: "answer" }));
    writer.apply(sdk("session.idle", {}));

    const events = await collect(stream);
    expect(writer.message.content).toEqual([
      { type: "thinking", thinking: "think" },
      { type: "thinking", thinking: "unstreamed" },
      { type: "text", text: "answer" },
    ]);
    const starts = events.filter((event) => event.type.endsWith("_start")).length;
    const ends = events.filter((event) => event.type.endsWith("_end")).length;
    expect(starts).toBe(ends);
  });

  it("ends with toolUse and parsed arguments when the model requests tools", async () => {
    const { stream, writer } = writerWithStream();
    writer.apply(
      sdk("assistant.message", {
        messageId: "m1",
        content: "",
        toolRequests: [
          { toolCallId: "c1", name: "read", arguments: { path: "a.ts" } },
          { toolCallId: "c2", name: "grep", arguments: '{"pattern":"x"}' },
        ],
      }),
    );
    const events = await collect(stream);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
    expect(writer.message.content).toEqual([
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
      { type: "toolCall", id: "c2", name: "grep", arguments: { pattern: "x" } },
    ]);
    expect(writer.toolCallIds()).toEqual(["c1", "c2"]);
  });

  it("counts cached prompt tokens once: the SDK's inputTokens already includes them", () => {
    const { writer } = writerWithStream();
    // Numbers from a real session.usage_record: 4 fresh input + 30879 cache read + 139 cache write.
    writer.apply(
      sdk("assistant.usage", {
        model: "claude-haiku-5.5",
        inputTokens: 31022,
        outputTokens: 47,
        cacheReadTokens: 30879,
        cacheWriteTokens: 139,
      }),
    );
    expect(writer.message.usage).toMatchObject({
      input: 4,
      cacheRead: 30879,
      cacheWrite: 139,
      totalTokens: 31022 + 47,
    });
  });

  it("sums usage with zero cost and reports length when the model ran out of tokens", async () => {
    const { stream, writer } = writerWithStream();
    writer.apply(
      sdk("assistant.usage", {
        model: "gpt-test",
        inputTokens: 155,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheWriteTokens: 5,
        reasoningTokens: 7,
        finishReason: "length",
      }),
    );
    writer.apply(sdk("session.idle", {}));
    const events = await collect(stream);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "length" });
    expect(writer.message.usage).toEqual({
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 5,
      reasoning: 7,
      totalTokens: 175,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  it("turns session.error into exactly one error event and ignores later events", async () => {
    const { stream, writer, ended } = writerWithStream();
    writer.apply(sdk("assistant.message_delta", { messageId: "m1", deltaContent: "par" }));
    writer.apply(sdk("session.error", { errorType: "quota", message: "Quota exceeded" }));
    writer.apply(sdk("assistant.message_delta", { messageId: "m1", deltaContent: "tial" }));
    writer.apply(sdk("session.idle", {}));

    const events = await collect(stream);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "error",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
    expect(writer.message.errorMessage).toBe("Quota exceeded");
    expect(ended).toHaveLength(1);
  });

  it("names context overflows so Pi compacts and retries", () => {
    const { writer } = writerWithStream();
    writer.apply(sdk("session.error", { errorType: "context_limit", message: "Prompt is 210000 tokens" }));
    expect(writer.message.errorMessage).toBe(`${CONTEXT_OVERFLOW_CODE}: Prompt is 210000 tokens`);
    expect(isContextOverflow(writer.message)).toBe(true);
  });

  it("reports an aborted idle as aborted", async () => {
    const { stream, writer } = writerWithStream();
    writer.apply(sdk("session.idle", { aborted: true }));
    const events = await collect(stream);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
  });

  it("fails without start when setup failed", async () => {
    const { stream, writer } = writerWithStream();
    writer.fail("error", "not logged in");
    const events = await collect(stream);
    expect(events.map((event) => event.type)).toEqual(["error"]);
  });

  it("ignores sub-agent events", async () => {
    const { stream, writer } = writerWithStream();
    writer.apply(sdk("assistant.message_delta", { messageId: "m1", deltaContent: "sub" }, { agentId: "a1" }));
    writer.apply(sdk("session.idle", {}));
    await collect(stream);
    expect(writer.message.content).toEqual([]);
  });
});

describe("parseToolArguments", () => {
  it("accepts objects and JSON object strings", () => {
    expect(parseToolArguments({ a: 1 })).toEqual({ arguments: { a: 1 } });
    expect(parseToolArguments('{"a":1}')).toEqual({ arguments: { a: 1 } });
    expect(parseToolArguments(undefined)).toEqual({ arguments: {} });
  });

  it("reports invalid JSON and non-objects", () => {
    for (const raw of ["{oops", [1, 2]]) {
      const parsed = parseToolArguments(raw);
      expect(parsed.arguments).toEqual({});
      expect(parsed.argumentsError).toContain("not");
    }
  });
});
