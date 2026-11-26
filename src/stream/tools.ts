import type { Tool as PiTool, ToolResultMessage } from "@earendil-works/pi-ai";
import { defineTool, type Tool as SdkTool, type ToolResultObject } from "@microsoft/copilot-sdk";

/** A Pi tool result reduced to what the SDK handler hands back to the model. */
export interface HeldToolResult {
  text: string;
  isError: boolean;
}

/** What a held handler returns to the SDK: plain text on success, a failure object otherwise. */
type SdkToolReturn = string | ToolResultObject;

/** Placeholder for image blocks until image tool results are forwarded. */
export const IMAGE_OMITTED = "[image omitted]";

/** Converts a Pi tool-result message into the text the SDK handler returns. Images become a short note. */
export function toHeldToolResult(message: ToolResultMessage): HeldToolResult {
  const text = message.content
    .map((block) => (block.type === "text" ? block.text : IMAGE_OMITTED))
    .join("\n");
  return { text, isError: message.isError };
}

function toSdkReturn(result: HeldToolResult): SdkToolReturn {
  if (!result.isError) return result.text;
  return { textResultForLlm: result.text, resultType: "failure", error: result.text };
}

/**
 * SDK tool handlers that do not run anything themselves.
 *
 * The Copilot runtime calls a handler when the model requests a tool. Pi runs the tool, so the
 * handler only parks the call until Pi delivers the result with {@link resolve}; meanwhile the
 * runtime keeps the turn open. Pi may deliver a result before the runtime has invoked the handler,
 * so early results are kept until the handler asks for them.
 */
export class HeldToolCalls {
  private readonly waiting = new Map<string, (result: SdkToolReturn) => void>();
  private readonly early = new Map<string, SdkToolReturn>();

  /**
   * @param onCancel Called when the runtime itself gives up on a waiting call. The SDK turn then no
   *   longer waits for Pi's result, so the caller must not try to continue it.
   */
  constructor(private readonly onCancel: (toolCallId: string) => void = () => undefined) {}

  /**
   * SDK definitions for Pi's tools. Each one overrides a built-in tool of the same name
   * (Pi's `edit` and `grep` collide with Copilot built-ins, which the runtime rejects otherwise).
   */
  createTools(piTools: readonly PiTool[]): SdkTool[] {
    return piTools.map((tool) =>
      defineTool(tool.name, {
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
        skipPermission: true,
        overridesBuiltInTool: true,
        handler: (_args, invocation) => this.hold(invocation.toolCallId, invocation.signal),
      }),
    );
  }

  /** Delivers Pi's result for a tool call, now or as soon as the runtime invokes its handler. */
  resolve(toolCallId: string, result: HeldToolResult): void {
    const settle = this.waiting.get(toolCallId);
    if (!settle) {
      this.early.set(toolCallId, toSdkReturn(result));
      return;
    }
    this.waiting.delete(toolCallId);
    settle(toSdkReturn(result));
  }

  /** Tool calls whose handler is currently waiting for a result. */
  pendingIds(): string[] {
    return [...this.waiting.keys()];
  }

  /** Fails every waiting handler with `reason` and forgets early results. */
  abortAll(reason: string): void {
    const failure = toSdkReturn({ text: reason, isError: true });
    for (const settle of this.waiting.values()) settle(failure);
    this.waiting.clear();
    this.early.clear();
  }

  /** Forgets results for calls the runtime never invoked; called when the SDK turn ended. */
  forgetEarly(): void {
    this.early.clear();
  }

  private hold(toolCallId: string, signal: AbortSignal | undefined): SdkToolReturn | Promise<SdkToolReturn> {
    const early = this.early.get(toolCallId);
    if (early !== undefined) {
      this.early.delete(toolCallId);
      return early;
    }
    return new Promise((resolve) => {
      // The runtime aborts the signal when it gives up on the call (completion, disconnect).
      const cancel = () => {
        if (this.waiting.get(toolCallId) !== settle) return;
        this.waiting.delete(toolCallId);
        settle(toSdkReturn({ text: "Tool call cancelled by the runtime.", isError: true }));
        this.onCancel(toolCallId);
      };
      const settle = (result: SdkToolReturn) => {
        signal?.removeEventListener("abort", cancel);
        resolve(result);
      };
      this.waiting.set(toolCallId, settle);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }
}
