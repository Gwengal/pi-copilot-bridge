import type { Model } from "@microsoft/copilot-sdk";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Provider id under which the models appear in Pi, e.g. `copilot-bridge/claude-haiku-5.5`. */
export const PROVIDER_ID = "copilot-bridge";

/** Pi's definition of a chat model offered by a provider. */
export type PiModelDefinition = Extract<ProviderModelConfig, { reasoning: boolean }>;

const FALLBACK_CONTEXT_WINDOW = 128_000; // "auto" reports 0
const FALLBACK_MAX_OUTPUT_TOKENS = 16_384;

/** Compact price hint, for example "10/50 cr" (AI credits per 1M input/output tokens). */
function priceHint(billing: Model["billing"]): string | undefined {
  const { inputPrice, outputPrice } = billing?.tokenPrices ?? {};
  if (inputPrice === undefined || outputPrice === undefined) return undefined;
  const discount = billing?.promo?.discountPercent;
  return `${inputPrice}/${outputPrice} cr` + (discount ? ` · -${discount}%` : "");
}

function displayName(model: Model): string {
  const hint = priceHint(model.billing);
  return hint ? `${model.name} · ${hint}` : model.name;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value && value > 0 ? value : fallback;
}

/**
 * Prompt budget of the default price tier, else the technical maximum. Copilot bills prompts above
 * the default tier at long-context prices, so Pi should compact before that point.
 */
function contextWindowOf(model: Model): number {
  const defaultTier = model.billing?.tokenPrices?.maxPromptTokens;
  if (defaultTier && defaultTier > 0) return defaultTier;
  return positiveOr(model.capabilities.limits?.max_context_window_tokens, FALLBACK_CONTEXT_WINDOW);
}

function toPiModel(model: Model): PiModelDefinition {
  const { supports, limits } = model.capabilities;
  const contextWindow = contextWindowOf(model);
  return {
    id: model.id,
    name: displayName(model),
    reasoning: (model.supportedReasoningEfforts?.length ?? 0) > 0,
    input: supports?.vision ? ["text", "image"] : ["text"],
    // Copilot bills AI credits, not dollars, so Pi's per-token dollar costs stay 0. The price
    // hint in the name is the user-facing cost signal.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(positiveOr(limits?.max_output_tokens, FALLBACK_MAX_OUTPUT_TOKENS), contextWindow),
  };
}

/** Converts SDK models to Pi model definitions, skipping models disabled by policy. */
export function toPiModels(sdkModels: readonly Model[]): PiModelDefinition[] {
  return sdkModels.filter((model) => model.policy?.state !== "disabled").map(toPiModel);
}

/** Reasoning efforts each model accepts, keyed by model id (empty array: no effort setting). */
export function supportedEffortsById(sdkModels: readonly Model[]): Map<string, readonly string[]> {
  return new Map(sdkModels.map((model) => [model.id, model.supportedReasoningEfforts ?? []]));
}
