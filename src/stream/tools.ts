import type { Tool as PiTool, ToolResultMessage } from "@earendil-works/pi-ai";
import { defineTool, type Tool as SdkTool, type ToolResultObject } from "@microsoft/copilot-sdk";

/** Binary content of a tool result (the SDK does not export its name). */
type ToolBinaryResult = NonNullable<ToolResultObject["binaryResultsForLlm"]>[number];

/** A Pi tool result reduced to what the SDK handler hands back to the model. */
export interface HeldToolResult {
  text: string;
  isError: boolean;
  /** Images forwarded to the model with the text. */
  images?: ToolBinaryResult[];
}

/** Image limits of a vision model, from `capabilities.limits.vision`; each one is optional. */
export interface VisionLimits {
  supportedMediaTypes?: readonly string[];
  maxImages?: number;
  maxImageBytes?: number;
}

/** What a held handler returns to the SDK: plain text on success, a result object otherwise. */
type SdkToolReturn = string | ToolResultObject;

/** Note that replaces an image for a model without vision. */
export const IMAGE_OMITTED = "[image omitted]";

/**
 * Converts the Pi tool-result messages of one continuation into what the SDK handlers return.
 *
 * With `vision` (the model accepts images), image blocks are forwarded as binary results, within the
 * model's limits; `maxImages` counts across all results of the batch, since they reach the model in
 * one request. An image outside the limits, or any image for a model without vision, becomes a short
 * note in the text.
 */
export function toHeldToolResults(
  messages: readonly ToolResultMessage[],
  vision: VisionLimits | undefined,
): HeldToolResult[] {
  let imagesLeft = vision?.maxImages ?? Number.POSITIVE_INFINITY;
  return messages.map((message) => {
    const images: ToolBinaryResult[] = [];
    const text = message.content
      .map((block) => {
        if (block.type === "text") return block.text;
        if (!vision) return IMAGE_OMITTED;
        const reason = rejectImage(block.mimeType, block.data, vision, imagesLeft);
        if (reason) return `[image omitted: ${reason}]`;
        imagesLeft--;
        images.push({ type: "image", data: block.data, mimeType: block.mimeType });
        return "[image attached]";
      })
      .join("\n");
    return { text, isError: message.isError, ...(images.length > 0 ? { images } : {}) };
  });
}

/** Why an image cannot be forwarded, or undefined when it can. */
function rejectImage(
  mimeType: string,
  data: string,
  vision: VisionLimits,
  imagesLeft: number,
): string | undefined {
  const types = vision.supportedMediaTypes;
  if (types && types.length > 0 && !types.includes(mimeType))
    return `${mimeType} is not supported by this model`;
  if (imagesLeft <= 0) return `limit of ${vision.maxImages} images per request reached`;
  const bytes = Buffer.byteLength(data, "base64");
  if (vision.maxImageBytes && bytes > vision.maxImageBytes) {
    return `${bytes} bytes exceed the model's limit of ${vision.maxImageBytes} bytes`;
  }
  return undefined;
}

function toSdkReturn(result: HeldToolResult): SdkToolReturn {
  if (!result.isError && !result.images) return result.text;
  return {
    textResultForLlm: result.text,
    resultType: result.isError ? "failure" : "success",
    ...(result.isError ? { error: result.text } : {}),
    ...(result.images ? { binaryResultsForLlm: result.images } : {}),
  };
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
