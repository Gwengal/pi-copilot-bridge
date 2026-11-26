import type { CopilotClient } from "@microsoft/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  CopilotAuthError,
  createCopilotRuntime,
  describeAccount,
  getPremiumQuota,
  listCopilotModels,
} from "./runtime.js";

interface FakeOptions {
  authenticated?: boolean;
  login?: string;
  authType?: string;
  startFailures?: number;
}

function fakeClient({ authenticated = true, login, authType, startFailures = 0 }: FakeOptions = {}) {
  let failuresLeft = startFailures;
  const fake = {
    start: vi.fn(async () => {
      await Promise.resolve();
      if (failuresLeft-- > 0) throw new Error("spawn failed");
    }),
    stop: vi.fn(() => Promise.resolve([])),
    getAuthStatus: vi.fn(() => Promise.resolve({ isAuthenticated: authenticated, login, authType })),
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

  it("names both login paths in the error", async () => {
    const { client } = fakeClient({ authenticated: false, login: "octocat" });
    const runtime = createCopilotRuntime({ createClient: () => client });
    await expect(runtime.client()).rejects.toThrow(
      'Not logged in to GitHub Copilot. Run /login and choose "GitHub Copilot (SDK)" ' +
        "(or run `npx @github/copilot` and /login).",
    );
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

describe("account", () => {
  it("reports the signed-in account after start, and a new one after restart()", async () => {
    const clients = [
      fakeClient({ login: "octocat", authType: "gh-cli" }),
      fakeClient({ login: "work", authType: "user" }),
    ];
    const runtime = createCopilotRuntime({ createClient: () => clients.shift()!.client });
    expect(runtime.account?.()).toBeUndefined();
    await runtime.client();
    expect(runtime.account?.()).toEqual({ login: "octocat", authType: "gh-cli" });
    await runtime.restart?.();
    expect(runtime.account?.()).toBeUndefined();
    await runtime.client();
    expect(runtime.account?.()).toEqual({ login: "work", authType: "user" });
  });

  it("describes where the credential came from", () => {
    expect(describeAccount({ login: "a", authType: "user" })).toBe("a (Copilot CLI / Pi login)");
    expect(describeAccount({ login: "a", authType: "gh-cli" })).toBe("a (GitHub CLI)");
    expect(describeAccount({ login: "a", authType: "env" })).toBe("a (COPILOT_GITHUB_TOKEN/GH_TOKEN)");
    expect(describeAccount({ login: "a", authType: "hmac" })).toBe("a (hmac)");
    expect(describeAccount({ login: "a" })).toBe("a");
    expect(describeAccount({ authType: "gh-cli" })).toBe("unknown account (GitHub CLI)");
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
