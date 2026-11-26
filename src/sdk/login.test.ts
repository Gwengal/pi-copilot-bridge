import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { CopilotClient } from "@microsoft/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import { MANAGED_CREDENTIAL, loginToCopilot } from "./login.js";

const DEVICE_CODE = {
  kind: "device-code",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  expiresIn: 899,
  interval: 5,
};
const COMPLETED = {
  kind: "completed",
  result: { status: "completed", host: "github.com", login: "octocat" },
};

/** A fake client whose login flow answers `advance` with the given steps in order. */
function fakeClient(steps: unknown[], first: unknown = DEVICE_CODE) {
  const login = {
    begin: vi.fn(() => Promise.resolve({ flowId: "flow-1", step: first })),
    advance: vi.fn((): Promise<unknown> => Promise.resolve(steps.shift())),
    cancel: vi.fn(() => Promise.resolve()),
  };
  const session = {
    sessionId: "s-1",
    rpc: { accounts: { login } },
    disconnect: vi.fn(() => Promise.resolve()),
  };
  const client = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve([])),
    createSession: vi.fn(() => Promise.resolve(session)),
    deleteSession: vi.fn(() => Promise.resolve()),
  };
  return { login, session, client, create: () => client as unknown as CopilotClient };
}

function callbacks(overrides: Partial<OAuthLoginCallbacks> = {}) {
  return {
    onAuth: vi.fn(),
    onDeviceCode: vi.fn(),
    onPrompt: vi.fn(() => Promise.resolve("")),
    onProgress: vi.fn(),
    onSelect: vi.fn(() => Promise.resolve<string | undefined>(undefined)),
    ...overrides,
  };
}

describe("loginToCopilot", () => {
  it("shows the device code, waits for authorization and returns the login", async () => {
    const fake = fakeClient([COMPLETED]);
    const ui = callbacks();
    await expect(loginToCopilot(ui, fake.create)).resolves.toBe("octocat");

    expect(fake.login.begin).toHaveBeenCalledWith({ kind: "gitHub", method: "device-code" });
    expect(ui.onDeviceCode).toHaveBeenCalledWith({
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 899,
      intervalSeconds: 5,
    });
    expect(fake.login.advance).toHaveBeenCalledWith({ flowId: "flow-1" });
    expect(fake.login.cancel).not.toHaveBeenCalled();
    // The temporary client and session are cleaned up.
    expect(fake.session.disconnect).toHaveBeenCalled();
    expect(fake.client.deleteSession).toHaveBeenCalledWith("s-1");
    expect(fake.client.stop).toHaveBeenCalled();
  });

  it("passes the chosen account back when the runtime asks for a selection", async () => {
    const selection = {
      kind: "completed",
      result: {
        status: "needs-account-selection",
        accounts: [{ selectionId: "sel-2", host: "github.com", login: "octocat", kind: "user" }],
      },
    };
    const fake = fakeClient([selection, COMPLETED]);
    const ui = callbacks({ onSelect: vi.fn(() => Promise.resolve<string | undefined>("sel-2")) });
    await expect(loginToCopilot(ui, fake.create)).resolves.toBe("octocat");
    expect(fake.login.advance).toHaveBeenLastCalledWith({ flowId: "flow-1", input: "sel-2" });
  });

  it("fails with the runtime's message on an error step and cancels the flow", async () => {
    const fake = fakeClient([{ kind: "error", message: "The device code expired." }]);
    await expect(loginToCopilot(callbacks(), fake.create)).rejects.toThrow("The device code expired.");
    expect(fake.login.cancel).toHaveBeenCalledWith({ flowId: "flow-1" });
    expect(fake.client.stop).toHaveBeenCalled();
  });

  it("cancels the flow when Pi aborts while the runtime polls", async () => {
    const fake = fakeClient([]);
    fake.login.advance.mockImplementation(() => new Promise(() => undefined)); // polls forever
    const abort = new AbortController();
    const ui = callbacks({ signal: abort.signal, onDeviceCode: vi.fn(() => abort.abort()) });
    await expect(loginToCopilot(ui, fake.create)).rejects.toThrow("Login cancelled");
    expect(fake.login.cancel).toHaveBeenCalledWith({ flowId: "flow-1" });
    expect(fake.client.stop).toHaveBeenCalled();
  });

  it("stops the client when it cannot even start", async () => {
    const fake = fakeClient([]);
    fake.client.start.mockRejectedValue(new Error("spawn failed"));
    await expect(loginToCopilot(callbacks(), fake.create)).rejects.toThrow("spawn failed");
    expect(fake.client.stop).toHaveBeenCalled();
  });
});

describe("MANAGED_CREDENTIAL", () => {
  it("holds no token and never expires in practice", () => {
    expect(MANAGED_CREDENTIAL).toEqual({
      access: "managed-by-copilot-runtime",
      refresh: "managed-by-copilot-runtime",
      expires: Date.UTC(9999, 0, 1),
    });
  });
});
