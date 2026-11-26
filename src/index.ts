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
import { FALLBACK_EFFORTS, FALLBACK_MODELS, FALLBACK_VISION } from "./catalog/fallback-models.js";
import {
  PROVIDER_ID,
  supportedEffortsById,
  toPiModels,
  visionLimitsById,
  type PiModelDefinition,
} from "./catalog/models.js";
import type { VisionLimits } from "./stream/tools.js";
import { MANAGED_CREDENTIAL, loginToCopilot } from "./sdk/login.js";
import {
  CopilotAuthError,
  LOGIN_PROVIDER_NAME,
  describeAccount,
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
  /** Image limits per vision model; missing in caches written before images were forwarded. */
  vision?: Record<string, VisionLimits>;
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
  vision: Map<string, VisionLimits>;
  quotaThrottle: Throttle;
  /** Last quota report; spend is published with it while quota fetches are throttled. */
  quota: LimitsReport | undefined;
  /** Credits spent per Pi session (nano AI units), as last reported by the stream function. */
  spend: Map<string, number>;
  /** Event bus of the instance serving each Pi session, so limits reach the right status bar. */
  buses: Map<string, EventBus>;
  /** The "not logged in" warning was shown; it appears once per process (or once after a login). */
  authWarned: boolean;
  /** Pi sessions that were told which Copilot account they use. */
  accountShown: Set<string>;
}

const globals = globalThis as Record<symbol, SharedBridge | undefined>;

/** Fetches the quota unless throttled, then publishes it with the Pi session's spend. */
async function publishLimits(shared: SharedBridge, bus: EventBus, piSessionKey: string, force = false) {
  if (force || shared.quotaThrottle.ready()) {
    try {
      const snapshot = await getPremiumQuota(shared.runtime);
      shared.quota = quotaReport(snapshot, new Date(), shared.runtime.account?.()?.login) ?? shared.quota;
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
      visionLimits: (modelId) => shared.vision.get(modelId),
      onUsage: ({ piSessionKey, nanoAiu }) => {
        shared.spend.set(piSessionKey, nanoAiu);
        void publishLimits(shared, shared.buses.get(piSessionKey) ?? fallbackBus, piSessionKey);
      },
    }),
    refCount: 0,
    cache,
    efforts: new Map(Object.entries(cache?.efforts ?? FALLBACK_EFFORTS)),
    vision: new Map(Object.entries(cache?.vision ?? (cache ? {} : FALLBACK_VISION))),
    quotaThrottle: createThrottle(),
    quota: undefined,
    spend: new Map(),
    buses: new Map(),
    authWarned: false,
    accountShown: new Set(),
  };
  return shared;
}

/**
 * Tells a Pi session once which account Copilot runs on: with an empty Copilot home the runtime
 * falls back to the GitHub CLI login or an environment token, which may be another account.
 * Shows the "not logged in" warning instead when there is no login at all.
 */
function showAccount(shared: SharedBridge, ctx: ExtensionContext): void {
  const piSessionKey = ctx.sessionManager.getSessionId();
  if (shared.accountShown.has(piSessionKey)) return;
  shared.runtime.client().then(
    () => {
      const account = shared.runtime.account?.();
      if (!account || shared.accountShown.has(piSessionKey)) return;
      shared.accountShown.add(piSessionKey);
      ctx.ui.notify(`Copilot account: ${describeAccount(account)}`, "info");
    },
    (error: unknown) => warnIfLoggedOut(shared, ctx, error),
  );
}

/** Shows the "not logged in" warning once, when `error` says the user is not logged in. */
function warnIfLoggedOut(shared: SharedBridge, ctx: ExtensionContext | undefined, error: unknown): void {
  if (!ctx || !(error instanceof CopilotAuthError) || shared.authWarned) return;
  shared.authWarned = true;
  ctx.ui.notify(error.message, "warning");
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
  /** Context of this instance's latest Pi session, for notifications outside event handlers. */
  let latestCtx: ExtensionContext | undefined;

  // Always the shared stream function: a per-instance one would not know the held tool calls.
  const register = (models: readonly PiModelDefinition[]): void => {
    pi.registerProvider(PROVIDER_ID, {
      name: LOGIN_PROVIDER_NAME,
      // The SDK owns transport and login, so these two only satisfy the provider shape. The API key
      // also keeps the models listed before any login.
      baseUrl: PROVIDER_ID,
      apiKey: "not-used",
      api: PROVIDER_ID,
      models: [...models],
      streamSimple: shared.streaming.streamSimple,
      oauth: {
        name: LOGIN_PROVIDER_NAME,
        isSubscription: true,
        login: async (callbacks) => {
          const login = await loginToCopilot(callbacks);
          // A running client may use another account (GitHub CLI fallback); its sessions go with it.
          await shared.streaming.disposeAll();
          await shared.runtime.restart?.();
          await shared.runtime.client(); // fails if the account still cannot use Copilot
          shared.authWarned = false;
          await refreshModels();
          if (latestCtx) shared.accountShown.add(latestCtx.sessionManager.getSessionId());
          notify(`Logged in to GitHub Copilot${login ? ` as ${login}` : ""}.`);
          return MANAGED_CREDENTIAL;
        },
        // Pi stores only a placeholder; the runtime refreshes the real credential itself.
        refreshToken: (credential) => Promise.resolve(credential),
        getApiKey: () => "not-used",
      },
    });
  };

  const notify = (message: string): void => {
    try {
      latestCtx?.ui.notify(message, "info");
    } catch {
      // The session may have been replaced meanwhile; Pi shows its own login confirmation anyway.
    }
  };

  /** Fetches the live model list, caches and registers it. Resolves false when that failed. */
  const refreshModels = async (ctx?: ExtensionContext): Promise<boolean> => {
    try {
      const sdkModels = await listCopilotModels(shared.runtime);
      const models = toPiModels(sdkModels);
      // An empty list would hide every model (and be cached for a day); keep what is shown instead.
      if (models.length === 0) return false;
      shared.efforts = supportedEffortsById(sdkModels);
      shared.vision = visionLimitsById(sdkModels);
      shared.cache = {
        savedAt: new Date().toISOString(),
        models,
        efforts: Object.fromEntries(shared.efforts),
        vision: Object.fromEntries(shared.vision),
      };
      writeCache(cachePath, shared.cache);
      if (!released) register(models);
      return true;
    } catch (error) {
      warnIfLoggedOut(shared, ctx, error);
      return false;
    }
  };

  /** Without a cache, the bundled snapshot keeps the models visible until a live fetch succeeds. */
  const currentModels = (): readonly PiModelDefinition[] => shared.cache?.models ?? FALLBACK_MODELS;

  // Only the owner registers at load time and refreshes the catalog; a later instance (subagent)
  // registers at session_start only if its registry lacks the provider.
  if (owner) {
    if (shared.cache) register(shared.cache.models);
    // First run ever: one live call. Not logged in (or offline): show the bundled snapshot.
    else if (!(await refreshModels())) register(FALLBACK_MODELS);
  }

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    const piSessionKey = ctx.sessionManager.getSessionId();
    shared.buses.set(piSessionKey, pi.events);
    if (!ctx.modelRegistry.getProvider(PROVIDER_ID)) register(currentModels());
    const onCopilot = ctx.model?.provider === PROVIDER_ID;
    if (owner && isStale(shared.cache)) void refreshModels(onCopilot ? ctx : undefined);
    if (onCopilot) {
      void publishLimits(shared, pi.events, piSessionKey, true);
      showAccount(shared, ctx);
    }
  });

  pi.on("model_select", (event, ctx) => {
    if (event.model.provider !== PROVIDER_ID) return;
    void publishLimits(shared, pi.events, ctx.sessionManager.getSessionId(), true);
    showAccount(shared, ctx);
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
