import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, type Api, type Model, type OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { CopilotClient, CreateSessionOptions, SessionEvent } from "@microsoft/copilot-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piCopilotBridge, { PROVIDER_ID } from "./index.js";
import { FALLBACK_MODELS } from "./catalog/fallback-models.js";
import { LIMITS_REPORT_EVENT, type LimitsReport } from "./limits/report.js";
import { MANAGED_CREDENTIAL } from "./sdk/login.js";
import type { CopilotRuntime } from "./sdk/runtime.js";

/** Every runtime the extension creates, with a fake client that never spawns a process. */
const runtimes: { runtime: CopilotRuntime; stop: ReturnType<typeof vi.fn>; client: FakeClient }[] = [];

/** Whether the fake runtime is logged in; the fake login flow switches it on. */
const auth = vi.hoisted(() => ({ loggedIn: true }));

vi.mock("./sdk/login.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sdk/login.js")>()),
  loginToCopilot: vi.fn(() => {
    auth.loggedIn = true;
    return Promise.resolve("octocat");
  }),
}));

class FakeClient {
  readonly listModels = vi.fn(() => Promise.resolve<unknown[]>([]));
  readonly rpc = {
    account: {
      getQuota: vi.fn(() =>
        Promise.resolve({
          quotaSnapshots: {
            premium_interactions: {
              isUnlimitedEntitlement: false,
              entitlementRequests: 300,
              usedRequests: 30,
              remainingPercentage: 90,
              overage: 0,
              overageAllowedWithExhaustedQuota: false,
            },
          },
        }),
      ),
    },
  };
  /** Each prompt reports a usage checkpoint 10 nano AI units higher than the last. */
  readonly createSession = vi.fn((options: CreateSessionOptions) => {
    let total = 0;
    return Promise.resolve({
      sessionId: "sdk-1",
      send: () => {
        total += 10;
        const emit = (type: string, data: object) =>
          options.events?.onEvent?.({ type, data } as unknown as SessionEvent);
        setTimeout(() => {
          emit("session.usage_checkpoint", { totalNanoAiu: total });
          emit("session.idle", {});
        }, 0);
        return Promise.resolve("u");
      },
      abort: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
    });
  });
  readonly deleteSession = vi.fn(() => Promise.resolve());
}

vi.mock("./sdk/runtime.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./sdk/runtime.js")>();
  return {
    ...original,
    createCopilotRuntime: () => {
      const client = new FakeClient();
      const stop = vi.fn(() => Promise.resolve());
      const runtime: CopilotRuntime = {
        client: () =>
          auth.loggedIn
            ? Promise.resolve(client as unknown as CopilotClient)
            : Promise.reject(new original.CopilotAuthError(original.NOT_LOGGED_IN_MESSAGE)),
        account: () => (auth.loggedIn ? { login: "octocat", authType: "gh-cli" } : undefined),
        restart: () => Promise.resolve(),
        stop,
      };
      runtimes.push({ runtime, stop, client });
      return runtime;
    },
  };
});

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A minimal ExtensionAPI: records handlers, registrations and emitted events. */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const registered: ProviderConfig[] = [];
  const reports: LimitsReport[] = [];
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerProvider: (_name: string, config: ProviderConfig) => registered.push(config),
    events: {
      emit: (channel: string, data: unknown) =>
        channel === LIMITS_REPORT_EVENT && reports.push(data as LimitsReport),
      on: () => () => undefined,
    },
  };
  const fire = async (event: string, payload: unknown, ctx: unknown = undefined) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  return { pi: api as unknown as ExtensionAPI, fire, registered, reports };
}

function sessionCtx(options: { hasProvider: boolean; onCopilot?: boolean }) {
  return {
    modelRegistry: {
      getProvider: (id: string) => (options.hasProvider && id === PROVIDER_ID ? {} : undefined),
    },
    sessionManager: { getSessionId: () => "pi-1" },
    model: options.onCopilot ? { provider: PROVIDER_ID } : undefined,
    ui: { notify: vi.fn() },
  };
}

let agentDir: string;

function writeModelCache(savedAt: string): void {
  mkdirSync(join(agentDir, "copilot-bridge"), { recursive: true });
  writeFileSync(
    join(agentDir, "copilot-bridge", "models.json"),
    JSON.stringify({ savedAt, models: [], efforts: {} }),
  );
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-copilot-bridge-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  writeModelCache(new Date().toISOString());
  runtimes.length = 0;
  auth.loggedIn = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});

describe("piCopilotBridge across module instances", () => {
  it("shares one runtime and stream function; only the last shutdown stops the runtime", async () => {
    const parent = fakePi();
    const child = fakePi();
    await piCopilotBridge(parent.pi);
    await piCopilotBridge(child.pi);

    expect(runtimes).toHaveLength(1); // no second Copilot process
    expect(parent.registered).toHaveLength(1);
    expect(child.registered).toHaveLength(0); // later instances do not register at load

    await child.fire("session_start", {}, sessionCtx({ hasProvider: true }));
    expect(child.registered).toHaveLength(0); // the parent's registration serves this registry
    await child.fire("session_start", {}, sessionCtx({ hasProvider: false }));
    expect(child.registered[0]?.streamSimple).toBe(parent.registered[0]?.streamSimple);

    await parent.fire("session_shutdown", {});
    expect(runtimes[0]?.stop).not.toHaveBeenCalled();
    await child.fire("session_shutdown", {});
    await child.fire("session_shutdown", {}); // idempotent
    expect(runtimes[0]?.stop).toHaveBeenCalledTimes(1);

    const reloaded = fakePi();
    await piCopilotBridge(reloaded.pi);
    expect(runtimes).toHaveLength(2); // a reload starts fresh
    expect(reloaded.registered).toHaveLength(1);
    await reloaded.fire("session_shutdown", {});
  });
});

describe("piCopilotBridge limits", () => {
  it("publishes the session's spend with the last quota even while quota fetches are throttled", async () => {
    const { pi, fire, registered, reports } = fakePi();
    await piCopilotBridge(pi);
    await fire("session_start", {}, sessionCtx({ hasProvider: true, onCopilot: true }));
    await vi.waitFor(() => expect(reports).toHaveLength(1));

    const streamSimple = registered[0]?.streamSimple as unknown as (
      m: Model<Api>,
      c: unknown,
      o: unknown,
    ) => unknown;
    const model = { id: "gpt-test", api: PROVIDER_ID, provider: PROVIDER_ID } as Model<Api>;
    const context = (text: string) =>
      normalizeContext({
        systemPrompt: "Pi",
        tools: [],
        messages: [{ role: "user", content: text, timestamp: 0 }],
      });
    streamSimple(model, context("a"), { sessionId: "pi-1" });
    await vi.waitFor(() => expect(reports).toHaveLength(2));
    // A diverged history rebuilds; the new SDK session's spend adds to the Pi session's total.
    streamSimple(model, context("b"), { sessionId: "pi-1" });
    await vi.waitFor(() => expect(reports).toHaveLength(3));

    expect(reports.map((report) => report.spend?.amount)).toEqual([0, 10 / 1e9, 20 / 1e9]);
    expect(reports[2]?.windows[0]).toMatchObject({ id: "premium", used: 30 });
    // Forced fetch at session start plus the first usage; the throttled one reuses the cached quota.
    expect(runtimes[0]?.client.rpc.account.getQuota).toHaveBeenCalledTimes(2);
    await fire("session_shutdown", {});
  });

  it("treats a cache with an unreadable date as stale and refreshes it", async () => {
    writeModelCache("not a date");
    const { pi, fire } = fakePi();
    await piCopilotBridge(pi);
    await fire("session_start", {}, sessionCtx({ hasProvider: true }));
    await vi.waitFor(() => expect(runtimes[0]?.client.listModels).toHaveBeenCalled());
    await fire("session_shutdown", {});
  });
});

describe("piCopilotBridge account notice", () => {
  it("names the account and its source once per Pi session, and in the limits label", async () => {
    const { pi, fire, reports } = fakePi();
    await piCopilotBridge(pi);
    const ctx = sessionCtx({ hasProvider: true, onCopilot: true });
    await fire("session_start", {}, ctx);
    await fire("model_select", { model: { provider: PROVIDER_ID } }, ctx);
    await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalled());
    await vi.waitFor(() => expect(reports.length).toBeGreaterThan(0));
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Copilot account: octocat (GitHub CLI)", "info");
    expect(reports[0]?.label).toBe("Copilot · octocat");
    await fire("session_shutdown", {});
  });
});

describe("piCopilotBridge without a Copilot login", () => {
  const cachePath = () => join(agentDir, "copilot-bridge", "models.json");
  const liveModel = { id: "live-model", name: "Live", capabilities: { supports: {}, limits: {} } };

  beforeEach(() => {
    rmSync(cachePath());
    auth.loggedIn = false;
  });

  it("registers the bundled fallback models and does not cache them", async () => {
    const { pi, fire, registered } = fakePi();
    await piCopilotBridge(pi);
    expect(registered[0]?.models?.map((model) => model.id)).toEqual(FALLBACK_MODELS.map((model) => model.id));
    expect(registered[0]?.name).toBe("GitHub Copilot (SDK)");
    expect(existsSync(cachePath())).toBe(false);
    await fire("session_shutdown", {});
  });

  it("keeps the fallback models when the runtime lists no models", async () => {
    auth.loggedIn = true; // the fake client lists [] by default
    const { pi, fire, registered } = fakePi();
    await piCopilotBridge(pi);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.models).toHaveLength(FALLBACK_MODELS.length);
    expect(existsSync(cachePath())).toBe(false);
    await fire("session_shutdown", {});
  });

  it("warns once at session start when a Copilot model is active", async () => {
    const { pi, fire } = fakePi();
    await piCopilotBridge(pi);
    const ctx = sessionCtx({ hasProvider: true, onCopilot: true });
    await fire("session_start", {}, ctx);
    await fire("session_start", {}, ctx);
    await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalled());
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('choose "GitHub Copilot (SDK)"'),
      "warning",
    );

    const other = sessionCtx({ hasProvider: true });
    await fire("session_start", {}, other);
    expect(other.ui.notify).not.toHaveBeenCalled();
    await fire("session_shutdown", {});
  });

  it("logs in through /login, loads live models and stores no token in Pi", async () => {
    const { pi, fire, registered } = fakePi();
    await piCopilotBridge(pi);
    const ctx = sessionCtx({ hasProvider: true });
    await fire("session_start", {}, ctx);
    runtimes[0]?.client.listModels.mockResolvedValue([liveModel]);

    const credential = await registered[0].oauth!.login({} as OAuthLoginCallbacks);

    expect(credential).toEqual(MANAGED_CREDENTIAL);
    expect(JSON.stringify(credential)).not.toMatch(/gh[opsu]_|token/i);
    expect(registered.at(-1)?.models?.map((model) => model.id)).toEqual(["live-model"]);
    expect(existsSync(cachePath())).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Logged in to GitHub Copilot as octocat.", "info");
    await fire("session_shutdown", {});
  });

  it("fails the login when the account still cannot use Copilot", async () => {
    const { loginToCopilot } = await import("./sdk/login.js");
    vi.mocked(loginToCopilot).mockResolvedValueOnce("octocat"); // flow succeeds, runtime stays logged out
    const { pi, fire, registered } = fakePi();
    await piCopilotBridge(pi);
    await expect(registered[0].oauth!.login({} as OAuthLoginCallbacks)).rejects.toThrow("Not logged in");
    await fire("session_shutdown", {});
  });
});
