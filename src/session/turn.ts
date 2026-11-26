import { randomUUID } from "node:crypto";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { CopilotClient, CopilotSession, MessageOptions, SessionEvent } from "@microsoft/copilot-sdk";
import { resolveReasoningEffort } from "../catalog/effort.js";
import type { CopilotRuntime } from "../sdk/runtime.js";
import {
  decideSync,
  digestMessages,
  digestSetup,
  rebuildPrompt,
  type Prompt,
  type SessionRecord,
  type SyncDecision,
} from "./sync.js";
import { HeldToolCalls, toHeldToolResult } from "../stream/tools.js";
import { PiTurnWriter } from "../stream/translate.js";

/** Services `streamSimple` needs; injected so tests can fake the SDK. */
export interface TurnDependencies {
  runtime: CopilotRuntime;
  /** Allowed reasoning efforts for a Copilot model id, from listModels. */
  supportedEfforts(modelId: string): readonly string[] | undefined;
  /**
   * Called after each SDK usage checkpoint with what the Pi session has spent so far, summed over
   * all SDK sessions that served it (rebuilds and one-off summary sessions included).
   */
  onUsage?(usage: { piSessionKey: string; nanoAiu: number }): void;
}

/** The provider entry point and its cleanup, as returned by {@link createStreamSimple}. */
export interface CopilotStreaming {
  /** Pi's `streamSimple` for the Copilot provider. */
  streamSimple: StreamFunction<Api, SimpleStreamOptions>;
  /** Disconnects and deletes every SDK session and fails their held tool calls. */
  disposeAll: () => Promise<void>;
  /** How many SDK sessions were created so far; each one costs a fresh prompt. */
  rebuildCount: () => number;
}

/** Environment variable that, set to `1`, logs why each SDK session was created (no content). */
export const DEBUG_ENV = "PI_COPILOT_BRIDGE_DEBUG";

const ABORTED_MESSAGE = "Request was aborted";
const BUSY_MESSAGE = "Another Copilot request is still running for this Pi session.";
const CACHE_WARM_MESSAGE = "copilot-bridge does not support cache warming.";

/** SDK error types after which the session itself is fine; Pi's retry resends the same prompt. */
const TRANSIENT_ERROR_TYPES = new Set(["rate_limit", "quota", "network"]);

/** One SDK session serving one Pi session. */
interface BridgedSession {
  key: string;
  /** Pi session the spend is booked to; differs from `key` for one-off sessions. */
  spendKey: string;
  client: CopilotClient;
  session: CopilotSession;
  tools: HeldToolCalls;
  record: SessionRecord;
  modelId: string;
  effort: string | undefined;
  /** The Pi stream currently fed by this session's events. */
  turn: Turn | undefined;
  /** Serializes event handling so `onProviderStreamEvent` is awaited in order. */
  events: Promise<void>;
  /** Set when the SDK session is in an unknown state; the next turn starts a fresh session. */
  broken: boolean;
  /** Whether the last `session.error` of the attached turn was transient. */
  lastErrorTransient: boolean;
  /** Session total from the last usage checkpoint, to book only the difference. */
  reportedNanoAiu: number;
}

/** One `streamSimple` call. */
interface Turn {
  key: string;
  spendKey: string;
  /** Summaries, requests without a Pi session id and other one-off requests get a throwaway session. */
  oneOff: boolean;
  model: Model<Api>;
  context: TranscriptContext;
  options: SimpleStreamOptions | undefined;
  writer: PiTurnWriter;
  owner: BridgedSession | undefined;
  onAbort: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maps Pi's session id to an SDK session key. Pi passes `options.sessionId` for every request of
 * an agent session. Requests with `cacheRetention: "none"` (compaction and branch summaries) are
 * one-off and must not replace the conversation's SDK session, so they get a throwaway key; so do
 * requests without a session id, which nothing could continue anyway.
 */
function sessionKeyOf(options: SimpleStreamOptions | undefined): {
  key: string;
  spendKey: string;
  oneOff: boolean;
} {
  const sessionId = options?.sessionId;
  if (sessionId === undefined || options?.cacheRetention === "none") {
    const key = `one-off:${randomUUID()}`;
    return { key, spendKey: sessionId ?? key, oneOff: true };
  }
  return { key: sessionId, spendKey: sessionId, oneOff: false };
}

/** Pi's cache warmer replays the last request capped at one output token. */
function isCacheWarming(options: SimpleStreamOptions | undefined): boolean {
  return options?.maxTokens === 1 && options.disableContinuation === true;
}

function toMessageOptions(prompt: Prompt): MessageOptions {
  if (prompt.images.length === 0) return { prompt: prompt.text };
  return {
    prompt: prompt.text,
    attachments: prompt.images.map((image) => ({ type: "blob", data: image.data, mimeType: image.mimeType })),
  };
}

/**
 * Creates Pi's `streamSimple` for Copilot.
 *
 * Each Pi session maps to one SDK session. A new user prompt is one `session.send`; when the
 * model requests tools, the Pi message ends with `toolUse` while the SDK turn stays open on held
 * tool handlers, and the next call delivers Pi's tool results into that same turn. Anything that
 * does not extend the SDK session's history rebuilds it (see {@link decideSync}). Only one request
 * per Pi session runs at a time; a second concurrent one fails instead of disturbing the first.
 *
 * Request hooks: `onPayload` sees (and may replace) the `MessageOptions` passed to `session.send`;
 * `onResponse` gets a synthetic `{ status: 200, headers: {} }` once the SDK accepted the prompt or
 * tool results, since the SDK exposes no HTTP response; `onProviderStreamEvent` is awaited with
 * each raw SDK session event before it is translated.
 */
export function createStreamSimple(deps: TurnDependencies): CopilotStreaming {
  const sessions = new Map<string, BridgedSession>();
  /** The running `streamSimple` call per session key. */
  const active = new Map<string, Turn>();
  const spent = new Map<string, number>();
  let rebuilds = 0;

  function handleEvent(owner: BridgedSession, event: SessionEvent): void {
    if (event.type === "session.usage_checkpoint") reportUsage(owner, event.data.totalNanoAiu);
    // The SDK turn is over, so results for calls it never invoked are of no use.
    if (event.type === "session.idle") owner.tools.forgetEarly();
    const turn = owner.turn;
    owner.events = owner.events
      .then(async () => {
        if (!turn || turn.writer.finished) return noteUnattended(owner, event);
        if (event.type === "session.error") {
          owner.lastErrorTransient = TRANSIENT_ERROR_TYPES.has(event.data.errorType);
        }
        await turn.options?.onProviderStreamEvent?.(event, turn.model);
        turn.writer.apply(event);
      })
      .catch((error: unknown) => turn?.writer.fail("error", errorText(error)));
  }

  /** An event no Pi stream listens to, typically while Pi runs the held tool calls. */
  function noteUnattended(owner: BridgedSession, event: SessionEvent): void {
    const heldTurnEnded = event.type === "session.idle" && owner.record.awaitingToolCallIds.length > 0;
    // Either way the held turn will not take Pi's tool results, so continuing it would hang.
    if (event.type === "session.error" || heldTurnEnded) owner.broken = true;
  }

  /** The runtime gave up on a held call itself, so the held turn cannot be continued. */
  function heldCallCancelled(owner: BridgedSession): void {
    owner.broken = true;
    owner.turn?.writer.fail("error", "The Copilot runtime cancelled a pending tool call.");
  }

  function reportUsage(owner: BridgedSession, totalNanoAiu: number): void {
    const delta = Math.max(0, totalNanoAiu - owner.reportedNanoAiu);
    owner.reportedNanoAiu = Math.max(owner.reportedNanoAiu, totalNanoAiu);
    const total = (spent.get(owner.spendKey) ?? 0) + delta;
    spent.set(owner.spendKey, total);
    try {
      deps.onUsage?.({ piSessionKey: owner.spendKey, nanoAiu: total });
    } catch {
      // usage reporting must never break a turn
    }
  }

  function noteRebuild(reason: string): void {
    rebuilds++;
    if (process.env[DEBUG_ENV] === "1") {
      process.stderr.write(`[pi-copilot-bridge] new SDK session #${rebuilds}: ${reason}\n`);
    }
  }

  async function createSession(
    turn: Turn,
    effort: string | undefined,
    systemPrompt: string,
    piTools: Tool[],
    setupDigest: string,
  ): Promise<BridgedSession> {
    const client = await deps.runtime.client();
    // Events can arrive while createSession is still pending; they precede any prompt and are dropped.
    const route: { to?: BridgedSession } = {};
    const tools = new HeldToolCalls(() => route.to && heldCallCancelled(route.to));
    const session = await client.createSession({
      model: turn.model.id,
      clientName: "pi-copilot-bridge",
      // Explicit default tier: Pi compacts at the default tier's prompt budget (see models.ts),
      // so a user or managed setting must not switch the session to long-context prices.
      inference: { contextTier: "default", ...(effort ? { reasoningEffort: effort } : {}) },
      tools: { definitions: tools.createTools(piTools), availableTools: piTools.map((tool) => tool.name) },
      systemMessage: { mode: "replace", content: systemPrompt },
      instructions: { skipCustomInstructions: true },
      state: { infiniteSessions: { enabled: false } }, // Pi compacts, not the runtime
      mcp: { disabledServers: ["github-mcp-server"] },
      permissions: { onRequest: () => ({ kind: "reject" }) },
      events: { streaming: true, onEvent: (event) => route.to && handleEvent(route.to, event) },
    });
    const owner: BridgedSession = {
      key: turn.key,
      spendKey: turn.spendKey,
      client,
      session,
      tools,
      record: { digests: [], awaitingToolCallIds: [], setupDigest },
      modelId: turn.model.id,
      effort,
      turn: undefined,
      events: Promise.resolve(),
      broken: false,
      lastErrorTransient: false,
      reportedNanoAiu: 0,
    };
    route.to = owner;
    sessions.set(turn.key, owner);
    return owner;
  }

  async function dispose(owner: BridgedSession): Promise<void> {
    if (sessions.get(owner.key) !== owner) return; // already disposed
    sessions.delete(owner.key);
    owner.tools.abortAll("Session closed");
    owner.turn?.writer.fail("error", "Session closed");
    await owner.session.disconnect().catch(() => undefined);
    // The bridge never resumes SDK sessions, so their stored history would only be a privacy cost.
    await owner.client.deleteSession(owner.session.sessionId).catch(() => undefined);
  }

  /** Stops the SDK turn and fails its held tool calls; the SDK session stays usable. */
  function interrupt(owner: BridgedSession): void {
    owner.tools.abortAll(ABORTED_MESSAGE);
    owner.record = { ...owner.record, awaitingToolCallIds: [] };
    owner.session.abort().catch(() => undefined);
  }

  function attach(owner: BridgedSession, turn: Turn, messages: TranscriptContext["messages"]): void {
    owner.turn = turn;
    turn.owner = owner;
    owner.record = {
      ...owner.record,
      digests: digestMessages(messages),
      awaitingToolCallIds: [],
      lastTurnFailed: false,
    };
  }

  /** Switches model or effort in place; false when the runtime refused and a rebuild is needed. */
  async function switchModel(
    owner: BridgedSession,
    modelId: string,
    effort: string | undefined,
  ): Promise<boolean> {
    if (owner.modelId === modelId && owner.effort === effort) return true;
    try {
      // An omitted effort would keep the previous one; null resets it to the model's default.
      await owner.session.rpc.model.switchTo({
        modelId,
        reasoningEffort: effort ?? null,
        contextTier: "default",
      });
    } catch {
      return false;
    }
    owner.modelId = modelId;
    owner.effort = effort;
    return true;
  }

  /** Records what the SDK session now holds once Pi's message is final. */
  function concludeTurn(turn: Turn, message: AssistantMessage): void {
    turn.options?.signal?.removeEventListener("abort", turn.onAbort);
    if (active.get(turn.key) === turn) active.delete(turn.key);
    const owner = turn.owner;
    if (!owner) return;
    if (owner.turn === turn) owner.turn = undefined;
    const transient = message.stopReason === "error" && owner.lastErrorTransient;
    owner.lastErrorTransient = false;
    if (transient) owner.record = { ...owner.record, lastTurnFailed: true };
    else if (message.stopReason === "error") owner.broken = true;
    if (
      message.stopReason === "stop" ||
      message.stopReason === "length" ||
      message.stopReason === "toolUse"
    ) {
      owner.record = {
        ...owner.record,
        digests: digestMessages([...turn.context.messages, message]),
        awaitingToolCallIds: message.stopReason === "toolUse" ? turn.writer.toolCallIds() : [],
      };
    }
    if (turn.oneOff) void dispose(owner);
  }

  async function reportResponse(turn: Turn): Promise<void> {
    await turn.options?.onResponse?.({ status: 200, headers: {} }, turn.model);
  }

  async function payloadFor(turn: Turn, message: MessageOptions): Promise<MessageOptions> {
    return ((await turn.options?.onPayload?.(message, turn.model)) as MessageOptions | undefined) ?? message;
  }

  /** Delivers Pi's tool results (and any steering messages) into the held SDK turn. */
  async function continueHeldTurn(
    owner: BridgedSession,
    turn: Turn,
    decision: Extract<SyncDecision, { kind: "continue-tools" }>,
  ): Promise<void> {
    attach(owner, turn, turn.context.messages);
    // Steering goes in first: the runtime keeps it for the running turn's next model call, which
    // comes after the tool results, so the model sees both in Pi's order without a new prompt.
    for (const steering of decision.steering) {
      await owner.session.send(await payloadFor(turn, { ...toMessageOptions(steering), mode: "immediate" }));
    }
    for (const result of decision.results) owner.tools.resolve(result.toolCallId, toHeldToolResult(result));
    await reportResponse(turn);
    turn.writer.start();
  }

  async function serve(turn: Turn): Promise<void> {
    const { model, context, options, writer } = turn;
    const piTools = getCurrentTools(context.messages);
    const systemPrompt = getCurrentSystemPrompt(context.messages);
    const setupDigest = digestSetup(systemPrompt, piTools);
    const effort = resolveReasoningEffort(deps.supportedEfforts(model.id), options?.reasoning);

    let owner = sessions.get(turn.key);
    const wasBroken = owner?.broken === true;
    if (owner && wasBroken) {
      await dispose(owner);
      owner = undefined;
    }
    const decision = decideSync(context.messages, owner?.record, setupDigest);

    if (decision.kind === "continue-tools") {
      // decideSync only continues a recorded session, so owner is always set here.
      if (!owner) throw new Error("Tool results arrived without a held Copilot turn");
      return continueHeldTurn(owner, turn, decision);
    }

    let prompt = decision.prompt;
    if (!owner || decision.kind === "rebuild" || !(await switchModel(owner, model.id, effort))) {
      const reason =
        decision.kind !== "rebuild"
          ? "model-switch-refused"
          : turn.oneOff
            ? "one-off"
            : wasBroken
              ? "broken"
              : decision.reason;
      noteRebuild(reason);
      // A refused model switch also rebuilds, so the prompt must carry the transcript.
      if (decision.kind !== "rebuild") prompt = rebuildPrompt(context.messages);
      if (owner) await dispose(owner);
      owner = await createSession(turn, effort, systemPrompt, piTools, setupDigest);
    }
    const payload = await payloadFor(turn, toMessageOptions(prompt));
    if (writer.finished) {
      // Aborted during setup; a one-off session has no later turn to reuse it.
      if (turn.oneOff) await dispose(owner);
      return;
    }
    attach(owner, turn, context.messages);
    await owner.session.send(payload);
    // An abort while send was pending may have reached the runtime before the prompt did.
    if (writer.message.stopReason === "aborted") owner.session.abort().catch(() => undefined);
    await reportResponse(turn);
    writer.start();
  }

  function streamSimple(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const { key, spendKey, oneOff } = sessionKeyOf(options);
    const turn: Turn = {
      key,
      spendKey,
      oneOff,
      model,
      context,
      options,
      writer: new PiTurnWriter(model, stream, (message) => concludeTurn(turn, message)),
      owner: undefined,
      onAbort: () => {
        if (turn.owner) interrupt(turn.owner);
        turn.writer.fail("aborted", ABORTED_MESSAGE);
      },
    };

    if (isCacheWarming(options)) {
      // Copilot bills a replay like any request and its cache is not ours to refresh; send nothing.
      turn.writer.fail("error", CACHE_WARM_MESSAGE);
      return stream;
    }
    if (options?.signal?.aborted) {
      // Pi calls back with an already aborted signal after a run was cancelled during tool execution.
      const held = sessions.get(key);
      if (held && held.record.awaitingToolCallIds.length > 0) interrupt(held);
      turn.writer.fail("aborted", ABORTED_MESSAGE);
      return stream;
    }
    if (active.has(key)) {
      // Interrupting the running request could kill the user's main turn for a side request.
      turn.writer.fail("error", BUSY_MESSAGE);
      return stream;
    }
    active.set(key, turn);
    options?.signal?.addEventListener("abort", turn.onAbort, { once: true });
    serve(turn).catch((error: unknown) => turn.writer.fail("error", errorText(error)));
    return stream;
  }

  return {
    streamSimple,
    async disposeAll() {
      await Promise.all([...sessions.values()].map(dispose));
    },
    rebuildCount: () => rebuilds,
  };
}
