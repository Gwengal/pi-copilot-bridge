import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { CopilotClient, CopilotSession } from "@microsoft/copilot-sdk";
import { createCopilotClient } from "./runtime.js";

/** One step of the SDK's interactive login flow (the SDK does not export its name). */
type LoginStep = Awaited<ReturnType<CopilotSession["rpc"]["accounts"]["login"]["advance"]>>;

/**
 * What Pi stores after a login: a placeholder, never a token. The Copilot runtime keeps the real
 * credential in the system keychain, and the bridge's stream function does not read Pi's credential.
 */
export const MANAGED_CREDENTIAL: OAuthCredentials = Object.freeze({
  access: "managed-by-copilot-runtime",
  refresh: "managed-by-copilot-runtime",
  expires: Date.UTC(9999, 0, 1),
});

/** Guards against a runtime that keeps answering with non-terminal steps. */
const MAX_STEPS = 20;

/**
 * Signs in to GitHub.com with the Copilot runtime's own interactive login (OAuth device code).
 *
 * Runs on a temporary, unauthenticated client and session: the login RPC lives on the session, and
 * the runtime persists the credential itself. Uses the SDK's experimental `accounts.login` API.
 *
 * @param callbacks - Pi's login callbacks: device code, prompts, progress and the abort signal.
 * @param createClient - Client factory, replaced in tests.
 * @returns The GitHub login that was signed in, when the runtime reports it.
 * @throws When the flow fails, is declined or is cancelled (`"Login cancelled"`).
 */
export async function loginToCopilot(
  callbacks: OAuthLoginCallbacks,
  createClient: () => CopilotClient = createCopilotClient,
): Promise<string | undefined> {
  const client = createClient();
  let session: CopilotSession | undefined;
  let flowId: string | undefined;
  let finished = false;
  try {
    await client.start();
    session = await client.createSession({
      clientName: "pi-copilot-bridge",
      mcp: { disabledServers: ["github-mcp-server"] },
      permissions: { onRequest: () => ({ kind: "reject" }) },
    });
    const login = session.rpc.accounts.login;
    const begun = await untilAborted(
      login.begin({ kind: "gitHub", method: "device-code" }),
      callbacks.signal,
    );
    flowId = begun.flowId;
    let step: LoginStep = begun.step;
    for (let count = 0; count < MAX_STEPS; count++) {
      const input = await handleStep(step, callbacks);
      if (input.done) {
        finished = true;
        return input.login;
      }
      step = await untilAborted(login.advance({ flowId, ...input.advance }), callbacks.signal);
    }
    throw new Error("GitHub Copilot login did not finish.");
  } finally {
    if (session) {
      const open = session;
      if (flowId && !finished) await open.rpc.accounts.login.cancel({ flowId }).catch(() => undefined);
      await open.disconnect().catch(() => undefined);
      await client.deleteSession(open.sessionId).catch(() => undefined);
    }
    await client.stop().catch(() => undefined);
  }
}

type StepOutcome = { done: true; login: string | undefined } | { done: false; advance: { input?: string } };

/** Shows one step to the user and says how to continue. Throws on error steps. */
async function handleStep(step: LoginStep, callbacks: OAuthLoginCallbacks): Promise<StepOutcome> {
  switch (step.kind) {
    case "device-code":
      callbacks.onDeviceCode({
        userCode: step.userCode,
        verificationUri: step.verificationUri,
        expiresInSeconds: step.expiresIn,
        intervalSeconds: step.interval,
      });
      return { done: false, advance: {} };
    case "open-url":
      callbacks.onAuth({ url: step.url });
      return { done: false, advance: {} };
    case "input-required":
      return { done: false, advance: { input: await callbacks.onPrompt({ message: step.prompt }) } };
    case "awaiting":
    case "needs-interaction":
      callbacks.onProgress?.("Waiting for GitHub authorization...");
      return { done: false, advance: {} };
    case "error":
      throw new Error(step.message);
    case "completed":
      return completedOutcome(step.result, callbacks);
  }
}

async function completedOutcome(
  result: Extract<LoginStep, { kind: "completed" }>["result"],
  callbacks: OAuthLoginCallbacks,
): Promise<StepOutcome> {
  switch (result.status) {
    case "completed":
      return { done: true, login: result.login };
    case "needs-account-selection": {
      const options = (result.accounts ?? []).map((account) => ({
        id: account.selectionId,
        label: `${account.login} (${account.host})`,
      }));
      const choice = await callbacks.onSelect({ message: "Choose the GitHub account for Copilot", options });
      if (!choice) throw new Error("Login cancelled");
      return { done: false, advance: { input: choice } };
    }
    case "needs-plaintext-consent":
      // ponytail: no plaintext-token consent UI; such systems log in with the Copilot CLI instead.
      throw new Error(
        "No system keychain is available to store the GitHub login. Run `npx @github/copilot` and /login, " +
          "or set COPILOT_GITHUB_TOKEN.",
      );
    case "declined":
      throw new Error("Login cancelled");
  }
}

/** Rejects with `"Login cancelled"` as soon as the signal aborts; the caller cancels the flow. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Login cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Login cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
