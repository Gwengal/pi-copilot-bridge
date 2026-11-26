import { describe, expect, it } from "vitest";
import { createThrottle, quotaReport, withSpend, type QuotaSnapshot } from "./report.js";

const now = new Date("2026-11-26T12:00:00.000Z");

const snapshot: QuotaSnapshot = {
  isUnlimitedEntitlement: false,
  entitlementRequests: 3000,
  usedRequests: 1119,
  remainingPercentage: 62.7,
  overage: 0,
  overageAllowedWithExhaustedQuota: true,
};

describe("quotaReport", () => {
  it("returns undefined without a snapshot", () => {
    expect(quotaReport(undefined, now)).toBeUndefined();
  });

  it("builds one premium window", () => {
    const report = quotaReport({ ...snapshot, resetDate: "2026-12-01T00:00:00Z" }, now);
    expect(report).toMatchObject({ source: "copilot", label: "Copilot", providers: ["copilot-bridge"] });
    expect(report?.observedAt).toBe(now.toISOString());
    expect(report?.windows).toHaveLength(1);
    const window = report?.windows[0];
    expect(window).toMatchObject({ id: "premium", label: "Premium", used: 1119, limit: 3000, unit: "req" });
    expect(window?.usedPercent).toBeCloseTo(37.3);
    expect(window?.resetsAt).toBe("2026-12-01T00:00:00.000Z");
    expect(window).not.toHaveProperty("status");
  });

  it("omits resetsAt when missing, past or unparsable", () => {
    for (const resetDate of [undefined, "2026-11-01T00:00:00Z", "garbage"]) {
      expect(quotaReport({ ...snapshot, resetDate }, now)?.windows[0]).not.toHaveProperty("resetsAt");
    }
  });

  it("flags overage", () => {
    const report = quotaReport({ ...snapshot, overage: 12, remainingPercentage: 0 }, now);
    expect(report?.windows[0]?.status).toBe("overage");
  });

  it("flags exhaustion only when overage is not allowed", () => {
    const exhausted = { ...snapshot, remainingPercentage: 0, usedRequests: 3000 };
    expect(
      quotaReport({ ...exhausted, overageAllowedWithExhaustedQuota: false }, now)?.windows[0]?.status,
    ).toBe("exhausted");
    expect(quotaReport(exhausted, now)?.windows[0]).not.toHaveProperty("status");
  });

  it("omits the window when the remaining percentage is not a finite number", () => {
    for (const remainingPercentage of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(quotaReport({ ...snapshot, remainingPercentage }, now)?.windows).toEqual([]);
    }
  });

  it("has no window for unlimited entitlements", () => {
    const report = quotaReport({ ...snapshot, isUnlimitedEntitlement: true, entitlementRequests: -1 }, now);
    expect(report?.windows).toEqual([]);
  });
});

describe("withSpend", () => {
  it("converts nano AI credits to credits without mutating the report", () => {
    const report = quotaReport(snapshot, now)!;
    const spent = withSpend(report, 14_000_000);
    expect(spent.spend).toEqual({ amount: 0.014, unit: "credits" });
    expect(report.spend).toBeUndefined();
  });
});

describe("createThrottle", () => {
  it("is ready first, then once per interval", () => {
    let time = 1_000;
    const throttle = createThrottle(60_000, () => time);
    expect(throttle.ready()).toBe(true);
    time += 59_999;
    expect(throttle.ready()).toBe(false);
    time += 1;
    expect(throttle.ready()).toBe(true);
    expect(throttle.ready()).toBe(false);
  });
});
