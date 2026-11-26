import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  LIMITS_REPORT_EVENT,
  createThrottle,
  quotaReport,
  withSpend,
  type LimitsReport,
  type Throttle,
} from "./limits/report.js";
import { PROVIDER_ID, supportedEffortsById, toPiModels, type PiModelDefinition } from "./catalog/models.js";
import {
  CopilotAuthError,
  createCopilotRuntime,
  getPremiumQuota,
  listCopilotModels,
  type CopilotRuntime,
} from "./sdk/runtime.js";
import { createStreamSimple, type CopilotStreaming } from "./session/turn.js";

export { PROVIDER_ID } from "./catalog/models.js";

/** How long a cached model list is trusted before it is refreshed in the background. */
const MODEL_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

/** Key of the {@link SharedBridge} on `globalThis`, shared by every module instance in the process. */
const SHARED_KEY = Symbol.for("pi-copilot-bridge:shared");

/** What we persist between runs so Pi can list Copilot models without starting the Copilot runtime. */
interface ModelCache {
  savedAt: string;
  models: PiModelDefinition[];
  efforts: Record<string, readonly string[]>;
}

type EventBus = ExtensionAPI["events"];

/**
 * State shared by all module instances of one process. A subagent can load this module again;
 * it must reuse the parent's runtime (no second Copilot process) and stream function (which holds
 * the held tool calls of every Pi session).
 */
interface SharedBridge {
  runtime: CopilotRuntime;
  streaming: CopilotStreaming;
  /** Live module instances; the last one to shut down disposes the sessions and stops the runtime. */
  refCount: number;
  cache: ModelCache | undefined;
  efforts: Map<string, readonly string[]>;
  quotaThrottle: Throttle;
  /** Last quota report; spend is published with it while quota fetches are throttled. */
  quota: LimitsReport | undefined;
  /** Credits spent per Pi session (nano AI units), as last reported by the stream function. */
  spend: Map<string, number>;
  /** Event bus of the instance serving each Pi session, so limits reach the right status bar. */
  buses: Map<string, EventBus>;
}

const globals = globalThis as Record<symbol, SharedBridge | undefined>;

/** Fetches the quota unless throttled, then publishes it with the Pi session's spend. */
async function publishLimits(shared: SharedBridge, bus: EventBus, piSessionKey: string, force = false) {
  if (force || shared.quotaThrottle.ready()) {
    try {
      shared.quota = quotaReport(await getPremiumQuota(shared.runtime), new Date()) ?? shared.quota;
    } catch {
      // Limits are informational. A failed quota call must never disturb the conversation.
    }
  }
  if (!shared.quota || globals[SHARED_KEY] !== shared) return; // nothing to show, or shut down meanwhile
  bus.emit(LIMITS_REPORT_EVENT, withSpend(shared.quota, shared.spend.get(piSessionKey) ?? 0));
}

function createShared(cachePath: string, fallbackBus: EventBus): SharedBridge {
  const runtime = createCopilotRuntime();
  const cache = readCache(cachePath);
  const shared: SharedBridge = {
    runtime,
    streaming: createStreamSimple({
      runtime,
      supportedEfforts: (modelId) => shared.efforts.get(modelId),
      onUsage: ({ piSessionKey, nanoAiu }) => {
        shared.spend.set(piSessionKey, nanoAiu);
        void publishLimits(shared, shared.buses.get(piSessionKey) ?? fallbackBus, piSessionKey);
      },
    }),
    refCount: 0,
    cache,
    efforts: new Map(Object.entries(cache?.efforts ?? {})),
    quotaThrottle: createThrottle(),
    quota: undefined,
    spend: new Map(),
    buses: new Map(),
  };
  return shared;
}

/**
 * pi-copilot-bridge extension entry point.
 *
 * Registers the `copilot-bridge` provider. Requests go through the official Copilot SDK, which runs the
 * real Copilot runtime under the user's Copilot CLI login. The runtime starts lazily: only when a Copilot
 * model is used or the cached model list is stale.
 *
 * @param pi - The Pi extension API.
 */
export default async function piCopilotBridge(pi: ExtensionAPI): Promise<void> {
  const cachePath = join(getAgentDir(), "copilot-bridge", "models.json");
  const owner = !globals[SHARED_KEY];
  const shared = globals[SHARED_KEY] ?? createShared(cachePath, pi.events);
  globals[SHARED_KEY] = shared;
  shared.refCount++;
  let released = false;

  // Always the shared stream function: a per-instance one would not know the held tool calls.
  const register = (models: PiModelDefinition[]): void => {
    pi.registerProvider(PROVIDER_ID, {
      // The SDK owns transport and login, so these two only satisfy the provider shape.
      baseUrl: PROVIDER_ID,
      apiKey: "not-used",
      api: PROVIDER_ID,
      models,
      streamSimple: shared.streaming.streamSimple,
    });
  };

  const refreshModels = async (ctx?: ExtensionContext): Promise<void> => {
    try {
      const sdkModels = await listCopilotModels(shared.runtime);
      const models = toPiModels(sdkModels);
      shared.efforts = supportedEffortsById(sdkModels);
      shared.cache = {
        savedAt: new Date().toISOString(),
        models,
        efforts: Object.fromEntries(shared.efforts),
      };
      writeCache(cachePath, shared.cache);
      if (!released) register(models);
    } catch (error) {
      if (error instanceof CopilotAuthError) ctx?.ui.notify(error.message, "warning");
    }
  };

  // Only the owner registers at load time and refreshes the catalog; a later instance (subagent)
  // registers at session_start only if its registry lacks the provider.
  if (owner) {
    if (shared.cache) register(shared.cache.models);
    else await refreshModels(); // First run ever: one live call so the models show up at all.
  }

  pi.on("session_start", (_event, ctx) => {
    const piSessionKey = ctx.sessionManager.getSessionId();
    shared.buses.set(piSessionKey, pi.events);
    if (!ctx.modelRegistry.getProvider(PROVIDER_ID)) register(shared.cache?.models ?? []);
    if (owner && isStale(shared.cache)) void refreshModels(ctx);
    if (ctx.model?.provider === PROVIDER_ID) void publishLimits(shared, pi.events, piSessionKey, true);
  });

  pi.on("model_select", (event, ctx) => {
    if (event.model.provider !== PROVIDER_ID) return;
    void publishLimits(shared, pi.events, ctx.sessionManager.getSessionId(), true);
    if (owner && isStale(shared.cache)) void refreshModels(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (released) return; // idempotent
    released = true;
    for (const [key, bus] of shared.buses) if (bus === pi.events) shared.buses.delete(key);
    if (--shared.refCount > 0) return;
    if (globals[SHARED_KEY] === shared) globals[SHARED_KEY] = undefined;
    await shared.streaming.disposeAll();
    await shared.runtime.stop();
  });
}

/** True when there is no cache, its date is unreadable, or it is older than {@link MODEL_CACHE_MAX_AGE_MS}. */
function isStale(cache: ModelCache | undefined): boolean {
  const age = cache ? Date.now() - Date.parse(cache.savedAt) : Number.NaN;
  return !(age <= MODEL_CACHE_MAX_AGE_MS); // NaN (unparsable savedAt) counts as stale
}

/** Reads the model cache. A missing or damaged file simply means "no cache". */
function readCache(path: string): ModelCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ModelCache;
    return Array.isArray(parsed.models) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the model cache. It holds model metadata only, never credentials. */
function writeCache(path: string, cache: ModelCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2));
  } catch {
    // Without a cache the next start just asks the runtime again.
  }
}
