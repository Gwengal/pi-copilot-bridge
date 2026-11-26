import { createHash } from "node:crypto";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

/** What the SDK session has seen, as recorded by the bridge after each Pi turn. */
export interface SessionRecord {
  /** Digests of the conversation messages the SDK session holds, in order. */
  readonly digests: readonly string[];
  /** Tool calls the SDK turn is holding open, waiting for Pi's results. */
  readonly awaitingToolCallIds: readonly string[];
  /** Digest of the system prompt and tools the session was created with. */
  readonly setupDigest: string;
  /** The last prompt failed with a transient error (rate limit, quota, network); Pi may retry it. */
  readonly lastTurnFailed?: boolean;
}

/** A user prompt for `session.send`: text plus images to attach. */
export interface Prompt {
  text: string;
  images: ImageContent[];
}

/**
 * How to bring the SDK session in line with Pi's context.
 *
 * - `continue-tools`: the held SDK turn gets these tool results, plus any user messages Pi queued
 *   after them (steering), which go into the running turn; no new prompt is started.
 * - `send`: the session already holds everything but this one new user prompt.
 * - `retry`: Pi resends the prompt whose turn failed transiently; send it again to the same session.
 * - `rebuild`: start a fresh session; the prompt carries the earlier transcript.
 */
export type SyncDecision =
  | { kind: "continue-tools"; results: ToolResultMessage[]; steering: Prompt[] }
  | { kind: "send"; prompt: Prompt }
  | { kind: "retry"; prompt: Prompt }
  | { kind: "rebuild"; prompt: Prompt; reason: RebuildReason };

/** Why {@link decideSync} rebuilds; a short label for diagnostics, never message content. */
export type RebuildReason = "no-session" | "tool-results-mismatch" | "setup-changed" | "history-diverged";

type ConversationMessage = UserMessage | AssistantMessage | ToolResultMessage;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function textOf(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

/**
 * Conversation messages that matter for matching. System messages are handled by the setup
 * digest, and failed assistant messages are skipped because Pi may or may not replay them.
 */
function conversationOf(messages: readonly Message[]): ConversationMessage[] {
  return messages.filter(
    (message): message is ConversationMessage =>
      message.role !== "system" &&
      !(message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")),
  );
}

function digestMessage(message: ConversationMessage): string {
  switch (message.role) {
    case "user":
      return sha256(["user", textOf(message.content)]);
    case "assistant":
      // Thinking is left out: providers and Pi may drop or redact it on replay.
      return sha256([
        "assistant",
        message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
        message.content.flatMap((block) => (block.type === "toolCall" ? [[block.id, block.name]] : [])),
      ]);
    case "toolResult":
      return sha256(["toolResult", message.toolCallId, message.isError, textOf(message.content)]);
  }
}

/** Stable digests of the conversation part of Pi's messages, for {@link SessionRecord.digests}. */
export function digestMessages(messages: readonly Message[]): string[] {
  return conversationOf(messages).map(digestMessage);
}

/** Digest of what a session is created with; a change means the session must be rebuilt. */
export function digestSetup(systemPrompt: string, tools: readonly Tool[]): string {
  return sha256([systemPrompt, tools.map((tool) => [tool.name, tool.description, tool.parameters])]);
}

function startsWith(all: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= all.length && prefix.every((digest, index) => all[index] === digest);
}

/** Splits the conversation into what precedes the last tool results, those results, and user messages after them. */
function splitTrailingToolResults(conversation: ConversationMessage[]): {
  head: ConversationMessage[];
  results: ToolResultMessage[];
  steering: UserMessage[];
} {
  let end = conversation.length;
  while (end > 0 && conversation[end - 1]?.role === "user") end--;
  let start = end;
  while (start > 0 && conversation[start - 1]?.role === "toolResult") start--;
  return {
    head: conversation.slice(0, start),
    results: conversation.slice(start, end) as ToolResultMessage[],
    steering: conversation.slice(end) as UserMessage[],
  };
}

function promptOf(message: UserMessage): Prompt {
  const images =
    typeof message.content === "string"
      ? []
      : message.content.filter((block): block is ImageContent => block.type === "image");
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  return { text, images };
}

/**
 * Only the assistant message that requested the tools must match the record. Extensions may
 * rewrite older context (compaction while a tool ran, for example), but the held SDK turn already
 * holds the original, and a rebuild would cost a new premium request.
 */
function continueTools(conversation: ConversationMessage[], record: SessionRecord): SyncDecision | undefined {
  if (record.awaitingToolCallIds.length === 0) return undefined;
  const { head, results, steering } = splitTrailingToolResults(conversation);
  const requester = head.at(-1);
  if (requester?.role !== "assistant" || digestMessage(requester) !== record.digests.at(-1)) return undefined;
  const delivered = new Set(results.map((result) => result.toolCallId));
  if (!record.awaitingToolCallIds.every((id) => delivered.has(id))) return undefined;
  const awaiting = new Set(record.awaitingToolCallIds);
  return {
    kind: "continue-tools",
    results: results.filter((result) => awaiting.has(result.toolCallId)),
    steering: steering.map(promptOf),
  };
}

function sendNext(conversation: ConversationMessage[], record: SessionRecord): SyncDecision | undefined {
  const last = conversation.at(-1);
  if (record.awaitingToolCallIds.length > 0 || last?.role !== "user") return undefined;
  if (conversation.length !== record.digests.length + 1) return undefined;
  if (!startsWith(conversation.map(digestMessage), record.digests)) return undefined;
  return { kind: "send", prompt: promptOf(last) };
}

/** Pi retries a failed request with the same context; the session already holds it up to the prompt. */
function retryLast(conversation: ConversationMessage[], record: SessionRecord): SyncDecision | undefined {
  const last = conversation.at(-1);
  if (!record.lastTurnFailed || record.awaitingToolCallIds.length > 0 || last?.role !== "user")
    return undefined;
  if (conversation.length !== record.digests.length) return undefined;
  if (!startsWith(conversation.map(digestMessage), record.digests)) return undefined;
  return { kind: "retry", prompt: promptOf(last) };
}

function rebuildReason(record: SessionRecord | undefined, setupDigest: string): RebuildReason {
  if (!record) return "no-session";
  if (record.awaitingToolCallIds.length > 0) return "tool-results-mismatch";
  return record.setupDigest === setupDigest ? "history-diverged" : "setup-changed";
}

/**
 * Decides how to serve Pi's context with the SDK session described by `record`.
 *
 * Pure: compares message digests only. Tool results for the held calls continue the SDK turn,
 * one new user prompt on top of the recorded history is sent as is, Pi's retry of a transiently
 * failed prompt is resent, and anything else (a first turn, resume, fork, tree navigation,
 * compaction, edited history, a different system prompt or tool set) rebuilds.
 *
 * @param record Undefined when no SDK session exists for this Pi session.
 * @param setupDigest {@link digestSetup} of Pi's current system prompt and tools.
 */
export function decideSync(
  messages: readonly Message[],
  record: SessionRecord | undefined,
  setupDigest: string,
): SyncDecision {
  const conversation = conversationOf(messages);
  if (record) {
    // A held turn continues even if the tools changed meanwhile; the change applies on the next prompt.
    const decision =
      continueTools(conversation, record) ??
      (record.setupDigest === setupDigest
        ? (sendNext(conversation, record) ?? retryLast(conversation, record))
        : undefined);
    if (decision) return decision;
  }
  return { kind: "rebuild", prompt: rebuildPrompt(messages), reason: rebuildReason(record, setupDigest) };
}

/** Instruction used when a rebuilt conversation ends with tool results instead of a user prompt. */
export const CONTINUE_PROMPT = "Continue from where the conversation above left off.";

/**
 * The prompt for a fresh session: earlier messages as one transcript block, then the last user
 * message (or {@link CONTINUE_PROMPT} when the conversation ends with tool results).
 */
export function rebuildPrompt(messages: readonly Message[]): Prompt {
  const conversation = conversationOf(messages);
  const last = conversation.at(-1);
  const earlier = last?.role === "user" ? conversation.slice(0, -1) : conversation;
  const next = last?.role === "user" ? promptOf(last) : { text: CONTINUE_PROMPT, images: [] };
  if (earlier.length === 0) return next;
  return { text: `${serializeTranscript(earlier)}\n\n${next.text}`, images: next.images };
}

function serializeMessage(message: ConversationMessage): string {
  switch (message.role) {
    case "user":
      return `[user]\n${textOf(message.content)}`;
    case "assistant":
      return message.content
        .flatMap((block) => {
          if (block.type === "text") return block.text ? [`[assistant]\n${block.text}`] : [];
          if (block.type === "toolCall") {
            return [`[tool call ${block.name} id=${block.id}]\n${JSON.stringify(block.arguments)}`];
          }
          return []; // thinking is not replayed
        })
        .join("\n\n");
    case "toolResult": {
      const status = message.isError ? " (error)" : "";
      return `[tool result id=${message.toolCallId}${status}]\n${textOf(message.content)}`;
    }
  }
}

/**
 * Renders earlier messages as one delimited block, so a rebuilt session gets the whole history
 * in a single `send` (one premium request). Compaction summaries reach providers as user
 * messages, so they are replayed like any other user message. A closing tag inside the content
 * is escaped so a message cannot end the block early.
 */
export function serializeTranscript(messages: readonly Message[]): string {
  const body = conversationOf(messages)
    .map(serializeMessage)
    .filter((part) => part.length > 0)
    .join("\n\n")
    .replace(/<\/(conversation_history)>/gi, "<\\/$1>");
  return [
    "<conversation_history>",
    "This session was restored. The conversation so far follows; continue it without repeating it.",
    "",
    body,
    "</conversation_history>",
  ].join("\n");
}
