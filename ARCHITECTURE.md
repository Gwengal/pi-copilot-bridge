# Architecture

pi-copilot-bridge registers a Pi model provider (`copilot-bridge`) that talks to GitHub Copilot
through the official `@microsoft/copilot-sdk`. The SDK runs the real Copilot runtime, so requests
are genuine Copilot traffic under the user's own login. Pi keeps control of tools and permissions:
the runtime only sees Pi's tools, and Pi executes them.

## Facts verified against a real account (SDK 2.0.3, runtime 1.0.116)

- **Login.** `new CopilotClient({ mode: "coding-agent", github: { useLoggedInUser: true } })` uses the
  Copilot CLI login (`copilot` then `/login`), with tokens in the OS keychain. `mode: "empty"` does
  NOT pick up that login, even with the CLI's home directory, and requires `baseDirectory`.
  `client.getAuthStatus()` returns `{ isAuthenticated, login, statusMessage }`.
- **Models.** `client.listModels()` returns ids like `claude-haiku-5.5`, `gpt-6-luna`, `auto`.
  Each has `capabilities.supports.reasoning_effort` (allowed values), `capabilities.limits`
  (`max_context_window_tokens`, `max_output_tokens`, `vision`), `billing.tokenPrices`
  (AI credits per 1M tokens: `inputPrice`, `outputPrice`, `cacheReadPrice`, `cacheWritePrice`,
  optional `longContext`), optional `billing.promo`, and `policy.state`.
- **Quota.** `client.rpc.account.getQuota({})` → `quotaSnapshots.premium_interactions` with
  `entitlementRequests`, `usedRequests`, `remainingPercentage`, `overage`,
  `overageAllowedWithExhaustedQuota`, `tokenBasedBilling`, `resetDate`. It lags behind live usage,
  and `resetDate` looked implausible in our test (treat as unreliable).
- **Session options that keep Pi in control.**
  ```ts
  client.createSession({
    model,
    clientName: "pi-copilot-bridge",
    inference: { reasoningEffort }, // only values the model lists
    tools: { definitions: piTools, availableTools: piTools.map((t) => t.name) },
    systemMessage: { mode: "replace", content: piSystemPrompt },
    instructions: { skipCustomInstructions: true },
    state: { infiniteSessions: { enabled: false } }, // Pi compacts, not the runtime
    mcp: { disabledServers: ["github-mcp-server"] },
    permissions: { onRequest: () => ({ kind: "reject" }) },
    events: { streaming: true, onEvent },
  });
  ```
  With `availableTools` the runtime reported "Disabled tools: create, edit, glob, grep, powershell,
  view, web_fetch, task, …" and `session.rpc.tools.getCurrentMetadata({})` listed only our tool.
- **Held tool calls.** A tool from `defineTool(name, { parameters, skipPermission: true, handler })`
  may await for as long as it likes; the runtime waits (`external_tool.requested` …
  `external_tool.completed`) and then continues the same turn. One user prompt with a tool round
  trip cost `totalPremiumRequests: 1`.
- **Events (in order, one prompt with one tool call).** `user.message`, `assistant.turn_start`,
  `assistant.streaming_delta`/`assistant.tool_call_delta`, `assistant.usage` (input/output/cache
  tokens, `cost` multiplier), `assistant.message` (`content`, `toolRequests[]` with `toolCallId`,
  `name`, `arguments`), `tool.execution_start`, `external_tool.requested`, (handler runs),
  `external_tool.completed`, `tool.execution_complete`, `assistant.turn_end`,
  `assistant.turn_start`, `assistant.message_start`, `assistant.message_delta` (`deltaContent`),
  `assistant.usage`, `assistant.message` (final text), `session.usage_checkpoint`
  (`totalNanoAiu`, `totalPremiumRequests`), `assistant.idle`, `session.idle`.
  Reasoning streams as `assistant.reasoning_delta`.
- **Cost.** `totalNanoAiu / 1e9` = AI credits; matched `tokenPrices` exactly (0.014 credits).
  `session.rpc.usage.getMetrics({})` returns the same totals.
- **Token counts.** `inputTokens` is the whole prompt, cache reads and writes included
  (`session.usage_record`: 31022 = 4 input + 30879 cache read + 139 cache write). Pi counts
  `input`, `cacheRead` and `cacheWrite` separately, so the bridge reports
  `input = inputTokens - cacheReadTokens - cacheWriteTokens`.
- **Price tiers.** `billing.tokenPrices.maxPromptTokens` is the prompt budget of the default price
  tier (claude-haiku-5.5: 100k, claude-opus-5.5: 200k, gpt-6-luna: 272k); `tokenPrices.longContext`
  bills more above it, up to `capabilities.limits.max_context_window_tokens` (1M).
  `inference.contextTier` (`"default" | "long_context"`) pins the tier; omitted means "normal model
  behaviour", which user or managed settings may change, so the bridge passes `"default"`.
- **Steering.** `session.send({ prompt, mode: "immediate" })` "interjects during an in-progress
  turn": the runtime keeps it in a steering queue for the running turn's next model call.
- **Session storage.** `client.stop()` keeps session data on disk for a later resume;
  `client.deleteSession(id)` removes it.

## How a Pi turn maps to the SDK

Pi calls `streamSimple(model, context, options)` once per assistant message. The SDK runs its own
agent loop. The bridge reconciles the two the same way pi-claude-bridge does with the Claude SDK:

1. **New user prompt** (last Pi message is a user message): send it with `session.send({ prompt })`
   and attach Pi's stream to the session's event flow.
2. **Model asks for tools**: emit the tool-call blocks to Pi and end Pi's stream with
   `stopReason: "toolUse"`. The SDK handler for each call stays pending (held).
3. **Pi runs the tools** and calls `streamSimple` again with tool-result messages. The bridge
   resolves the held handlers with those results and attaches the new stream. The SDK continues
   the same turn. No new prompt, no new premium request. User messages Pi queued after the
   results (steering) are sent first with `mode: "immediate"`, so the running turn picks them up.
4. **`session.idle`**: finish Pi's message with `stopReason: "stop"` and final usage.
5. **Abort** (`options.signal`): `session.abort()`, settle pending handlers as aborted, end Pi's
   stream as aborted. An abort while `send` is still pending is repeated once `send` resolves.
6. **Lost held turn**: if the runtime cancels a held handler itself, or the SDK session goes idle
   while Pi still runs the tools, the session is marked broken and the next call rebuilds instead
   of waiting for a turn that no longer exists.

Only one `streamSimple` call per Pi session runs at a time; a concurrent second call fails with a
clear error instead of interrupting the first (which is usually the user's main turn). Requests
without `sessionId`, and summaries (`cacheRetention: "none"`), use a throwaway SDK session that is
deleted afterwards. Pi's cache-warming replays (`maxTokens: 1` with `disableContinuation`) are
answered with an error without sending anything: Copilot would bill them as a full request.

## Errors

`session.error` ends Pi's message with `stopReason: "error"`. Transient errors (`errorType`
`rate_limit`, `quota`, `network`) keep the SDK session: Pi's retry resends the same context, which
the bridge recognises and answers by sending the last prompt again. Any other error marks the
session broken, so the next call rebuilds. `errorType: "context_limit"` becomes an error message
starting with `context_length_exceeded`, which makes Pi compact and retry.

## Session sync

The SDK session holds its own history; Pi may rewrite its history (resume, fork, tree navigation,
compaction, switching to this provider mid-session). The bridge records what the SDK session has
seen. When Pi's context no longer extends that record, it creates a fresh SDK session and sends
the earlier transcript together with the new prompt in ONE `send` (one premium request), as a
clearly delimited block (a closing delimiter inside the content is escaped). Model changes within
a matching session use the session's model RPC instead of a rebuild when the runtime allows it;
the effort is passed explicitly (`null` resets it), since an omitted effort keeps the old one.

Held tool calls continue when Pi's trailing tool results cover every held call and the assistant
message that requested them matches the record; older history may differ (an extension may have
rewritten it), because the SDK turn already holds the original and a rebuild costs a new prompt.

Every new SDK session increments `rebuildCount()`. With `PI_COPILOT_BRIDGE_DEBUG=1` each one logs a
one-line reason (`no-session`, `one-off`, `broken`, `setup-changed`, `history-diverged`,
`tool-results-mismatch`, `model-switch-refused`) to stderr, never message content.

## Extension instances, limits and cleanup

A subagent can load the extension module again in the same process. All instances share one object
on `globalThis` (`Symbol.for("pi-copilot-bridge:shared")`) holding the runtime, the stream function,
the model cache and the limits state, with a reference count. Only the first instance registers at
load and refreshes the model catalog; a later one registers (with the shared stream function) only
when its registry lacks the provider. Each `session_shutdown` decrements the count; the last one
disposes every SDK session and stops the runtime, after which `client()` rejects instead of
starting a new process. A reload or new session loads a fresh shared object.

Spend is tracked per Pi session: the stream function sums the `session.usage_checkpoint` deltas of
every SDK session that served it (rebuilds and one-off summaries included). The quota fetch is
throttled to once a minute; spend is always published, with the last cached quota report.

Disposing an SDK session disconnects it and then deletes it (`client.deleteSession`), since the
bridge never resumes SDK sessions.

## Modules

| File                      | Responsibility                                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sdk/runtime.ts`      | Lazy, shared `CopilotClient`: start once, auth check with a clear "run `copilot` and `/login`" error, `listModels`, `getQuota`, stop on shutdown. Small interface so tests can fake it.                                                               |
| `src/catalog/models.ts`   | SDK model → Pi model definition (id, name with price hint, context window = default price tier's `maxPromptTokens` so Pi compacts before long-context prices, max tokens, reasoning, input types, cost 0 because Copilot bills credits, not dollars). |
| `src/catalog/effort.ts`   | Pi thinking level → SDK `reasoningEffort`, clamped to what the model lists; `undefined` when unsupported.                                                                                                                                             |
| `src/limits/report.ts`    | Quota snapshot + session usage → `pi-limits:report:v1` payload (premium window, credits spent).                                                                                                                                                       |
| `src/stream/translate.ts` | SDK session events → Pi assistant-message events for the current turn.                                                                                                                                                                                |
| `src/stream/tools.ts`     | Pi tool declarations → SDK tools with held handlers; resolve/abort pending calls.                                                                                                                                                                     |
| `src/session/sync.ts`     | Decide continue / send prompt / rebuild; serialize earlier transcript for a rebuild.                                                                                                                                                                  |
| `src/session/turn.ts`     | `streamSimple` entry: ties runtime, sync, tools and translate together per Pi session.                                                                                                                                                                |
| `src/index.ts`            | Extension entry: register the provider, refresh models, publish limits, clean up.                                                                                                                                                                     |

## Rules

- English code, comments and messages. Readable over clever. TSDoc on every export, short inline
  comments only to explain why.
- No credentials in logs. Never read or write token files; the SDK owns login.
- Every module with logic has Vitest tests next to it. The SDK is faked at the `sdk/runtime.ts` and
  `CopilotSession` boundary; no test talks to the network.
