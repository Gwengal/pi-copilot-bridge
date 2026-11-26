import type { CopilotClient } from "@microsoft/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import { CopilotAuthError, createCopilotRuntime, getPremiumQuota, listCopilotModels } from "./runtime.js";

interface FakeOptions {
  authenticated?: boolean;
  login?: string;
  startFailures?: number;
}

function fakeClient({ authenticated = true, login, startFailures = 0 }: FakeOptions = {}) {
  let failuresLeft = startFailures;
  const fake = {
    start: vi.fn(async () => {
      await Promise.resolve();
      if (failuresLeft-- > 0) throw new Error("spawn failed");
    }),
    stop: vi.fn(() => Promise.resolve([])),
    getAuthStatus: vi.fn(() => Promise.resolve({ isAuthenticated: authenticated, login })),
    listModels: vi.fn(() => Promise.resolve([{ id: "auto" }])),
    rpc: {
      account: {
        getQuota: vi.fn(() =>
          Promise.resolve({ quotaSnapshots: { premium_interactions: { usedRequests: 1 } } }),
        ),
      },
    },
  };
  return { fake, client: fake as unknown as CopilotClient };
}

describe("createCopilotRuntime", () => {
  it("does not start before the first client() call", () => {
    const { fake, client } = fakeClient();
    createCopilotRuntime({ createClient: () => client });
    expect(fake.start).not.toHaveBeenCalled();
  });

  it("starts once for concurrent and later callers", async () => {
    const { fake, client } = fakeClient();
    const create = vi.fn(() => client);
    const runtime = createCopilotRuntime({ createClient: create });
    const [a, b] = await Promise.all([runtime.client(), runtime.client()]);
    await runtime.client();
    expect(a).toBe(client);
    expect(b).toBe(client);
    expect(create).toHaveBeenCalledTimes(1);
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(fake.getAuthStatus).toHaveBeenCalledTimes(1);
  });

  it("retries after a failed start with a fresh client", async () => {
    const first = fakeClient({ startFailures: 1 });
    const second = fakeClient();
    const clients = [first.client, second.client];
    const runtime = createCopilotRuntime({ createClient: () => clients.shift()! });
    await expect(runtime.client()).rejects.toThrow("spawn failed");
    expect(first.fake.stop).toHaveBeenCalledTimes(1);
    await expect(runtime.client()).resolves.toBe(second.client);
  });

  it("throws CopilotAuthError with the login hint when not authenticated", async () => {
    const { fake, client } = fakeClient({ authenticated: false });
    const runtime = createCopilotRuntime({ createClient: () => client });
    const error: unknown = await runtime.client().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CopilotAuthError);
    expect((error as Error).message).toContain("npx @github/copilot");
    expect((error as Error).message).toContain("/login");
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it("mentions the login name when known", async () => {
    const { client } = fakeClient({ authenticated: false, login: "octocat" });
    const runtime = createCopilotRuntime({ createClient: () => client });
    await expect(runtime.client()).rejects.toThrow("octocat");
  });

  it("stop() stops a started client only", async () => {
    const idle = fakeClient();
    const unused = createCopilotRuntime({ createClient: () => idle.client });
    await unused.stop();
    expect(idle.fake.stop).not.toHaveBeenCalled();

    const { fake, client } = fakeClient();
    const runtime = createCopilotRuntime({ createClient: () => client });
    await runtime.client();
    await runtime.stop();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it("does not start a new process after stop()", async () => {
    const { fake, client } = fakeClient();
    const runtime = createCopilotRuntime({ createClient: () => client });
    await runtime.stop();
    await expect(runtime.client()).rejects.toThrow("stopped");
    expect(fake.start).not.toHaveBeenCalled();
  });

  it("stops a client whose start was still pending at stop()", async () => {
    const { fake, client } = fakeClient();
    const runtime = createCopilotRuntime({ createClient: () => client });
    const pending = runtime.client();
    await runtime.stop();
    await pending;
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });
});

describe("helpers", () => {
  it("listCopilotModels returns the SDK list", async () => {
    const { client } = fakeClient();
    const runtime = createCopilotRuntime({ createClient: () => client });
    await expect(listCopilotModels(runtime)).resolves.toEqual([{ id: "auto" }]);
  });

  it("getPremiumQuota returns the premium_interactions snapshot", async () => {
    const { client } = fakeClient();
    const runtime = createCopilotRuntime({ createClient: () => client });
    await expect(getPremiumQuota(runtime)).resolves.toEqual({ usedRequests: 1 });
  });
});
