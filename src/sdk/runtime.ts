import { CopilotClient } from "@microsoft/copilot-sdk";
import type { Model } from "@microsoft/copilot-sdk";

/** Quota snapshot type as the SDK returns it (the SDK does not export its name). */
export type PremiumQuotaSnapshot = NonNullable<
  Awaited<ReturnType<CopilotClient["rpc"]["account"]["getQuota"]>>["quotaSnapshots"][string]
>;

/** Lazily started, shared access to the Copilot SDK client. */
export interface CopilotRuntime {
  /** Started, authenticated SDK client. Rejects with {@link CopilotAuthError} when not logged in. */
  client(): Promise<CopilotClient>;
  /**
   * Stops the client if it was started. Final: afterwards `client()` rejects instead of starting a
   * new process, so late background work during shutdown cannot revive the runtime. A reload or
   * new session creates a new runtime.
   */
  stop(): Promise<void>;
}

/** The user is not logged in to GitHub Copilot; the message tells them how to fix it. */
export class CopilotAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopilotAuthError";
  }
}

/** Options for {@link createCopilotRuntime}. */
export interface CopilotRuntimeOptions {
  /** Client factory, replaced in tests. */
  createClient?: () => CopilotClient;
}

// "coding-agent" is required: mode "empty" ignores the Copilot CLI login (see ARCHITECTURE.md).
function createDefaultClient(): CopilotClient {
  return new CopilotClient({ mode: "coding-agent", github: { useLoggedInUser: true } });
}

function notLoggedInMessage(login: string | undefined): string {
  const who = login ? ` (login: ${login})` : "";
  return `GitHub Copilot is not logged in${who}. Run \`npx @github/copilot\`, then \`/login\`.`;
}

async function startAuthenticated(client: CopilotClient): Promise<CopilotClient> {
  try {
    await client.start();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) throw new CopilotAuthError(notLoggedInMessage(auth.login));
    return client;
  } catch (error) {
    await client.stop().catch(() => undefined); // do not leak a half-started runtime process
    throw error;
  }
}

/**
 * Creates a runtime that starts the SDK client on first use. Concurrent callers share one start;
 * a failed start is not cached, so the next call retries (for example after the user logged in).
 */
export function createCopilotRuntime(options: CopilotRuntimeOptions = {}): CopilotRuntime {
  const createClient = options.createClient ?? createDefaultClient;
  let starting: Promise<CopilotClient> | undefined;
  let stopped = false;

  return {
    client() {
      if (stopped) return Promise.reject(new Error("The Copilot runtime was stopped."));
      if (!starting) {
        const attempt = startAuthenticated(createClient());
        starting = attempt;
        attempt.catch(() => {
          if (starting === attempt) starting = undefined;
        });
      }
      return starting;
    },
    async stop() {
      stopped = true;
      const running = starting;
      starting = undefined;
      if (!running) return;
      const client = await running.catch(() => undefined);
      await client?.stop();
    },
  };
}

/** Lists the models the logged-in account may use. */
export async function listCopilotModels(runtime: CopilotRuntime): Promise<Model[]> {
  return (await runtime.client()).listModels();
}

/** Premium-request quota of the account, or undefined when the runtime reports none. */
export async function getPremiumQuota(runtime: CopilotRuntime): Promise<PremiumQuotaSnapshot | undefined> {
  const { quotaSnapshots } = await (await runtime.client()).rpc.account.getQuota({});
  return quotaSnapshots["premium_interactions"];
}
