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
  /** Account the started client is signed in with; undefined before a successful start. */
  account?(): CopilotAccount | undefined;
  /** Stops the current client so the next `client()` starts a new one, e.g. after a login. */
  restart?(): Promise<void>;
  /**
   * Stops the client if it was started. Final: afterwards `client()` rejects instead of starting a
   * new process, so late background work during shutdown cannot revive the runtime. A reload or
   * new session creates a new runtime.
   */
  stop(): Promise<void>;
}

/** The GitHub account the runtime uses, as `getAuthStatus()` reports it. */
export interface CopilotAccount {
  login?: string;
  /** How the runtime found the credential, e.g. "user" or "gh-cli". */
  authType?: string;
}

/** Where a credential came from, for people (SDK `authType`; unknown values pass through). */
const AUTH_SOURCES: Record<string, string> = {
  user: "Copilot CLI / Pi login",
  "gh-cli": "GitHub CLI",
  env: "COPILOT_GITHUB_TOKEN/GH_TOKEN",
  token: "GitHub token",
};

/** "octocat (GitHub CLI)": the account and where its credential came from. */
export function describeAccount(account: CopilotAccount): string {
  const source = account.authType ? (AUTH_SOURCES[account.authType] ?? account.authType) : undefined;
  const login = account.login ?? "unknown account";
  return source ? `${login} (${source})` : login;
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

/** Name of the provider's login entry in Pi's `/login` list. */
export const LOGIN_PROVIDER_NAME = "GitHub Copilot (SDK)";

/** Shown wherever a Copilot model is used without a Copilot login. */
export const NOT_LOGGED_IN_MESSAGE =
  `Not logged in to GitHub Copilot. Run /login and choose "${LOGIN_PROVIDER_NAME}" ` +
  "(or run `npx @github/copilot` and /login).";

/**
 * Creates an SDK client on the shared Copilot login (keychain, `COPILOT_HOME`).
 * "coding-agent" is required: mode "empty" ignores the Copilot CLI login (see ARCHITECTURE.md).
 */
export function createCopilotClient(): CopilotClient {
  return new CopilotClient({ mode: "coding-agent", github: { useLoggedInUser: true } });
}

async function startAuthenticated(
  client: CopilotClient,
  onAccount: (account: CopilotAccount) => void,
): Promise<CopilotClient> {
  try {
    await client.start();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) throw new CopilotAuthError(NOT_LOGGED_IN_MESSAGE);
    onAccount({ login: auth.login, authType: auth.authType });
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
  const createClient = options.createClient ?? createCopilotClient;
  let starting: Promise<CopilotClient> | undefined;
  let stopped = false;
  let account: CopilotAccount | undefined;

  return {
    client() {
      if (stopped) return Promise.reject(new Error("The Copilot runtime was stopped."));
      if (!starting) {
        const attempt = startAuthenticated(createClient(), (found) => (account = found));
        starting = attempt;
        attempt.catch(() => {
          if (starting === attempt) starting = undefined;
        });
      }
      return starting;
    },
    account: () => account,
    async restart() {
      const running = starting;
      starting = undefined;
      account = undefined;
      const client = await running?.catch(() => undefined);
      await client?.stop();
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
