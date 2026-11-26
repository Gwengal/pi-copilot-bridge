import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CopilotClient, CreateSessionOptions, SessionEvent } from "@microsoft/copilot-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piCopilotBridge, { PROVIDER_ID } from "./index.js";
import { LIMITS_REPORT_EVENT, type LimitsReport } from "./limits/report.js";
import type { CopilotRuntime } from "./sdk/runtime.js";

/** Every runtime the extension creates, with a fake client that never spawns a process. */
const runtimes: { runtime: CopilotRuntime; stop: ReturnType<typeof vi.fn>; client: FakeClient }[] = [];

class FakeClient {
  readonly listModels = vi.fn(() => Promise.resolve([]));
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
        client: () => Promise.resolve(client as unknown as CopilotClient),
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
  const registered: { streamSimple: unknown }[] = [];
  const reports: LimitsReport[] = [];
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerProvider: (_name: string, config: { streamSimple: unknown }) => registered.push(config),
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

    const streamSimple = registered[0]?.streamSimple as (m: Model<Api>, c: unknown, o: unknown) => unknown;
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
