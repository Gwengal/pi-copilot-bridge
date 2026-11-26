import { PROVIDER_ID } from "../catalog/models.js";
import type { PremiumQuotaSnapshot } from "../sdk/runtime.js";

/**
 * Local minimal copy of the pi-limits event contract (sibling repo `pi-limits`, src/contract.ts).
 * Emit a {@link LimitsReport} on `pi.events` under this event name.
 */
export const LIMITS_REPORT_EVENT = "pi-limits:report:v1";

/** One quota window; subset of `LimitWindow` in the pi-limits contract. */
export interface LimitWindow {
  id: string;
  label: string;
  usedPercent: number;
  used?: number;
  limit?: number;
  unit?: string;
  resetsAt?: string;
  status?: "ok" | "warning" | "exhausted" | "overage";
}

/** Payload of {@link LIMITS_REPORT_EVENT}; subset of `LimitsReport` in the pi-limits contract. */
export interface LimitsReport {
  source: string;
  label?: string;
  providers?: string[];
  windows: LimitWindow[];
  spend?: { amount: number; unit: string };
  observedAt?: string;
}

/** The quota fields this module reads. */
export type QuotaSnapshot = Pick<
  PremiumQuotaSnapshot,
  | "isUnlimitedEntitlement"
  | "entitlementRequests"
  | "usedRequests"
  | "remainingPercentage"
  | "overage"
  | "overageAllowedWithExhaustedQuota"
  | "resetDate"
>;

const NANO_PER_UNIT = 1e9;

/** Reset date as ISO string, or undefined when missing, unparsable or not in the future. */
function plausibleReset(resetDate: string | undefined, now: Date): string | undefined {
  if (!resetDate) return undefined;
  const time = Date.parse(resetDate);
  return time > now.getTime() ? new Date(time).toISOString() : undefined;
}

function statusOf(snapshot: QuotaSnapshot): LimitWindow["status"] {
  if (snapshot.overage > 0) return "overage";
  if (snapshot.remainingPercentage <= 0 && !snapshot.overageAllowedWithExhaustedQuota) return "exhausted";
  return undefined; // let pi-limits derive ok/warning from usedPercent
}

function premiumWindow(snapshot: QuotaSnapshot, now: Date): LimitWindow {
  const window: LimitWindow = {
    id: "premium",
    label: "Premium",
    usedPercent: 100 - snapshot.remainingPercentage,
    used: snapshot.usedRequests,
    limit: snapshot.entitlementRequests,
    unit: "req",
  };
  const resetsAt = plausibleReset(snapshot.resetDate, now);
  if (resetsAt) window.resetsAt = resetsAt;
  const status = statusOf(snapshot);
  if (status) window.status = status;
  return window;
}

/**
 * Builds the pi-limits report for the premium-request quota.
 * Returns undefined without a snapshot. An unlimited entitlement, or a snapshot without a usable
 * percentage, yields a report without windows rather than a window showing NaN.
 * The label names the account (`login`), so the footer shows whose quota it is.
 */
export function quotaReport(
  snapshot: QuotaSnapshot | undefined,
  now: Date,
  login?: string,
): LimitsReport | undefined {
  if (!snapshot) return undefined;
  const hasWindow = !snapshot.isUnlimitedEntitlement && Number.isFinite(snapshot.remainingPercentage);
  return {
    source: "copilot",
    label: login ? `Copilot · ${login}` : "Copilot",
    providers: [PROVIDER_ID],
    windows: hasWindow ? [premiumWindow(snapshot, now)] : [],
    observedAt: now.toISOString(),
  };
}

/** Adds the session spend (SDK `totalNanoAiu`) to a report, in AI credits. */
export function withSpend(report: LimitsReport, nanoAiu: number): LimitsReport {
  return { ...report, spend: { amount: nanoAiu / NANO_PER_UNIT, unit: "credits" } };
}

/** Rate limiter for quota fetches. */
export interface Throttle {
  /** True at most once per interval; the call that returns true starts a new interval. */
  ready(): boolean;
}

/** Creates a {@link Throttle}; the first call is always ready. The clock is injectable for tests. */
export function createThrottle(intervalMs = 60_000, clock: () => number = Date.now): Throttle {
  let last: number | undefined;
  return {
    ready() {
      const now = clock();
      if (last !== undefined && now - last < intervalMs) return false;
      last = now;
      return true;
    },
  };
}
