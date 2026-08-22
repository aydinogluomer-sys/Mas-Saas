import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS, BACKOFF_CAP_SECONDS, JOB_STATUSES,
  backoffSeconds, canTransition, nextAfterFailure, progressPercent, queueVerdict,
} from "./rules";

describe("backoffSeconds", () => {
  it("doubles per attempt", () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBe(60);
    expect(backoffSeconds(3)).toBe(120);
    expect(backoffSeconds(4)).toBe(240);
  });

  it("is capped, so a retry never disappears into next week", () => {
    // Without the cap, attempt 20 would be 30 * 2^19 seconds ≈ 182 days.
    expect(backoffSeconds(20)).toBe(BACKOFF_CAP_SECONDS);
    expect(backoffSeconds(50)).toBe(BACKOFF_CAP_SECONDS);
  });

  it("never returns a nonsensical delay for a nonsensical attempt", () => {
    expect(backoffSeconds(0)).toBe(30);
    expect(backoffSeconds(-5)).toBe(30);
    expect(backoffSeconds(Number.NaN)).toBe(30);
  });

  it("is deterministic — no jitter, same input same answer", () => {
    const a = Array.from({ length: 10 }, () => backoffSeconds(5));
    expect(new Set(a).size).toBe(1);
  });
});

describe("nextAfterFailure", () => {
  it("retries while attempts remain", () => {
    expect(nextAfterFailure(1, 5)).toEqual({ status: "failed", retryInSeconds: 30 });
    expect(nextAfterFailure(3, 5)).toEqual({ status: "failed", retryInSeconds: 120 });
  });

  it("dead-letters when attempts are exhausted", () => {
    expect(nextAfterFailure(5, 5)).toEqual({ status: "dead_letter", retryInSeconds: null });
    expect(nextAfterFailure(9, 5)).toEqual({ status: "dead_letter", retryInSeconds: null });
  });

  it("dead-letters a PERMANENT failure immediately, without burning attempts", () => {
    // A malformed workbook is just as malformed in 30 seconds. Retrying it four more times
    // delays every other job and buries the real error under identical copies.
    expect(nextAfterFailure(1, 5, true)).toEqual({ status: "dead_letter", retryInSeconds: null });
  });
});

describe("canTransition", () => {
  it("allows the documented moves", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "succeeded")).toBe(true);
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("dead_letter", "queued")).toBe(true);
  });

  it("REFUSES to reopen a finished job", () => {
    // The whole reason the guard exists: re-running a completed import would double every row
    // it wrote.
    expect(canTransition("succeeded", "running")).toBe(false);
    expect(canTransition("succeeded", "queued")).toBe(false);
    expect(canTransition("cancelled", "queued")).toBe(false);
    expect(canTransition("cancelled", "running")).toBe(false);
  });

  it("refuses to skip straight from queued to succeeded", () => {
    expect(canTransition("queued", "succeeded")).toBe(false);
  });

  it("treats a no-op as allowed", () => {
    for (const s of JOB_STATUSES) expect(canTransition(s, s)).toBe(true);
  });

  it("has no duplicate entries in the allow-list", () => {
    const keys = ALLOWED_TRANSITIONS.map(([a, b]) => `${a}->${b}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("progressPercent", () => {
  it("returns null — not 0 — when the total is unknown", () => {
    // A job reading "0%" for ten minutes gets reported as broken. "Unknown" is the honest answer
    // when the work has not been counted yet.
    expect(progressPercent(0, null)).toBeNull();
    expect(progressPercent(500, null)).toBeNull();
  });

  it("computes a real percentage", () => {
    expect(progressPercent(0, 200)).toBe(0);
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(200, 200)).toBe(100);
  });

  it("never exceeds 100 even if a worker over-reports", () => {
    expect(progressPercent(250, 200)).toBe(100);
  });

  it("treats a zero total as unknown rather than dividing by zero", () => {
    expect(progressPercent(0, 0)).toBeNull();
  });
});

describe("queueVerdict", () => {
  it("dead letters dominate every other signal", () => {
    expect(queueVerdict(0, 3).tone).toBe("neg");
    expect(queueVerdict(null, 1).tone).toBe("neg");
  });

  it("an empty queue is healthy, not unknown", () => {
    expect(queueVerdict(null, 0).tone).toBe("pos");
  });

  it("escalates with waiting time", () => {
    expect(queueVerdict(10, 0).tone).toBe("pos");
    expect(queueVerdict(600, 0).tone).toBe("warn");
    expect(queueVerdict(7200, 0).tone).toBe("neg");
  });
});
