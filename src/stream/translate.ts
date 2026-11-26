import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  JsonObject,
  Model,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import type { SessionEvent } from "@microsoft/copilot-sdk";

type EventOf<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;
type ToolRequest = NonNullable<EventOf<"assistant.message">["data"]["toolRequests"]>[number];

/** Stop reasons that end a Pi stream successfully. */
export type DoneReason = "stop" | "length" | "toolUse";

/** Stop reasons that end a Pi stream with an error event. */
export type FailReason = "error" | "aborted";

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Creates the pending assistant message Pi's stream contract starts from. */
export function createAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

/** Parses SDK tool arguments into the JSON object Pi requires, reporting anything else. */
export function parseToolArguments(raw: unknown): Pick<ToolCall, "arguments" | "argumentsError"> {
  let value: unknown = raw ?? {};
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return { arguments: {}, argumentsError: `Tool arguments are not valid JSON: ${raw as string}` };
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { arguments: value as JsonObject };
  }
  return { arguments: {}, argumentsError: `Tool arguments are not a JSON object: ${JSON.stringify(raw)}` };
}

/** Pi compacts and retries when an error message names this code (see Pi's custom-provider docs). */
export const CONTEXT_OVERFLOW_CODE = "context_length_exceeded";

/** Pi's error message for an SDK error; context overflows carry {@link CONTEXT_OVERFLOW_CODE}. */
export function errorMessageOf(error: EventOf<"session.error">["data"]): string {
  return error.errorType === "context_limit" ? `${CONTEXT_OVERFLOW_CODE}: ${error.message}` : error.message;
}

interface OpenBlock {
  kind: "text" | "thinking";
  /** SDK messageId or reasoningId the block belongs to. */
  sdkId: string;
  index: number;
}

/**
 * Writes one Pi assistant message from SDK session events.
 *
 * One instance serves one `streamSimple` call. It keeps Pi's stream contract: `start` before any
 * content, balanced start/end events per block, and exactly one terminal `done` or `error`.
 * Text streams from `assistant.message_delta`, thinking from `assistant.reasoning_delta`; the
 * complete `assistant.message`/`assistant.reasoning` events only fill in what was not streamed.
 * Tool requests end the message with `toolUse`, `session.idle` ends it with `stop` or `length`.
 */
export class PiTurnWriter {
  /** The message as Pi sees it; also the `partial` of every event. */
  readonly message: AssistantMessage;
  private started = false;
  private ended = false;
  private open: OpenBlock | undefined;
  /** SDK ids that already produced a block, so their complete event is not emitted twice. */
  private readonly streamedIds = new Set<string>();
  private lastFinishReason: string | undefined;

  /**
   * @param onEnd Called once, after the terminal event was pushed.
   */
  constructor(
    model: Model<Api>,
    private readonly stream: AssistantMessageEventStream,
    private readonly onEnd: (message: AssistantMessage) => void = () => undefined,
  ) {
    this.message = createAssistantMessage(model);
  }

  /** Whether the terminal event was already pushed. */
  get finished(): boolean {
    return this.ended;
  }

  /** Emits `start` once; called when request setup succeeded and before the first content event. */
  start(): void {
    if (this.started || this.ended) return;
    this.started = true;
    this.stream.push({ type: "start", partial: this.message });
  }

  /** Applies one SDK event. Events from sub-agents and events after the end are ignored. */
  apply(event: SessionEvent): void {
    if (this.ended || event.agentId) return;
    switch (event.type) {
      case "assistant.message_delta":
        this.appendText(event.data.messageId, event.data.deltaContent);
        break;
      case "assistant.reasoning_delta":
        this.appendThinking(event.data.reasoningId, event.data.deltaContent);
        break;
      case "assistant.reasoning":
        this.completeThinking(event.data.reasoningId, event.data.content);
        break;
      case "assistant.message":
        this.completeMessage(event.data);
        break;
      case "assistant.usage":
        this.addUsage(event.data);
        break;
      case "session.error":
        this.fail("error", errorMessageOf(event.data));
        break;
      case "session.idle":
        if (event.data.aborted) this.fail("aborted", "Request was aborted");
        else this.finish(this.lastFinishReason === "length" ? "length" : "stop");
        break;
    }
  }

  /** Closes open blocks and ends the stream with `done`. */
  finish(reason: DoneReason): void {
    if (this.ended) return;
    this.start();
    this.closeOpenBlock();
    this.message.stopReason = reason;
    this.end({ type: "done", reason, message: this.message });
  }

  /** Ends the stream with `error`; usable before `start` when setup failed. */
  fail(reason: FailReason, errorMessage: string): void {
    if (this.ended) return;
    if (this.started) this.closeOpenBlock();
    this.message.stopReason = reason;
    this.message.errorMessage = errorMessage;
    this.end({ type: "error", reason, error: this.message });
  }

  /** Ids of the tool calls this message requested. */
  toolCallIds(): string[] {
    return this.message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
  }

  private end(event: Parameters<AssistantMessageEventStream["push"]>[0]): void {
    this.ended = true;
    this.stream.push(event);
    this.stream.end();
    this.onEnd(this.message);
  }

  private appendText(sdkId: string, delta: string): void {
    if (!delta) return;
    const index = this.openBlock("text", sdkId);
    const block = this.message.content[index] as { type: "text"; text: string };
    block.text += delta;
    this.stream.push({ type: "text_delta", contentIndex: index, delta, partial: this.message });
  }

  private appendThinking(sdkId: string, delta: string): void {
    if (!delta) return;
    const index = this.openBlock("thinking", sdkId);
    const block = this.message.content[index] as { type: "thinking"; thinking: string };
    block.thinking += delta;
    this.stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.message });
  }

  private completeThinking(reasoningId: string, content: string): void {
    if (!this.streamedIds.has(reasoningId)) this.appendThinking(reasoningId, content);
    if (this.open?.sdkId === reasoningId) this.closeOpenBlock();
  }

  private completeMessage(data: EventOf<"assistant.message">["data"]): void {
    if (!this.streamedIds.has(data.messageId)) this.appendText(data.messageId, data.content);
    this.closeOpenBlock();
    const requests = data.toolRequests ?? [];
    for (const request of requests) this.addToolCall(request);
    if (requests.length > 0) this.finish("toolUse");
  }

  private addToolCall(request: ToolRequest): void {
    this.start();
    const toolCall: ToolCall = {
      type: "toolCall",
      id: request.toolCallId,
      name: request.name,
      ...parseToolArguments(request.arguments),
    };
    const index = this.message.content.push(toolCall) - 1;
    this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.message });
    const delta = JSON.stringify(toolCall.arguments);
    this.stream.push({ type: "toolcall_delta", contentIndex: index, delta, partial: this.message });
    this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: this.message });
  }

  private addUsage(data: EventOf<"assistant.usage">["data"]): void {
    const usage = this.message.usage;
    const cacheRead = data.cacheReadTokens ?? 0;
    const cacheWrite = data.cacheWriteTokens ?? 0;
    // The runtime's inputTokens is the whole prompt, cache reads and writes included (seen in
    // session.usage_record: 30883 = 4 input + 30879 cache write). Pi counts them separately.
    usage.input += Math.max(0, (data.inputTokens ?? 0) - cacheRead - cacheWrite);
    usage.output += data.outputTokens ?? 0;
    usage.cacheRead += cacheRead;
    usage.cacheWrite += cacheWrite;
    if (data.reasoningTokens !== undefined) usage.reasoning = (usage.reasoning ?? 0) + data.reasoningTokens;
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    // Cost stays 0: Copilot bills AI credits, which onUsage reports separately.
    this.lastFinishReason = data.finishReason;
  }

  /** Returns the index of the open block for `sdkId`, starting a new block if needed. */
  private openBlock(kind: OpenBlock["kind"], sdkId: string): number {
    if (this.open?.kind === kind && this.open.sdkId === sdkId) return this.open.index;
    this.start();
    this.closeOpenBlock();
    const index =
      this.message.content.push(
        kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
      ) - 1;
    this.open = { kind, sdkId, index };
    this.streamedIds.add(sdkId);
    this.stream.push({
      type: kind === "text" ? "text_start" : "thinking_start",
      contentIndex: index,
      partial: this.message,
    });
    return index;
  }

  private closeOpenBlock(): void {
    if (!this.open) return;
    const { index } = this.open;
    const block = this.message.content[index];
    this.open = undefined;
    if (block?.type === "text") {
      this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.message });
    } else if (block?.type === "thinking") {
      this.stream.push({
        type: "thinking_end",
        contentIndex: index,
        content: block.thinking,
        partial: this.message,
      });
    }
  }
}
