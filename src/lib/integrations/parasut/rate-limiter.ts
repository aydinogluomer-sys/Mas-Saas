// Faz 51 (E1) — Paraşüt API v4 Rate Limiter (8 requests / 10s token bucket + HTTP 429 Retry-After exponential backoff).
//
// Paraşüt enforces a strict 10 requests / 10 seconds ceiling per company. We cap bursts at
// 8 requests / 10 seconds with deterministic injectable clock/sleep for unit tests and
// automatic Retry-After + exponential backoff on HTTP 429 responses.

import type { HttpClient, HttpRequest, HttpResponse } from "../types";

export interface RateLimiterOptions {
  maxRequestsPerWindow?: number;
  windowMs?: number;
  maxRetriesOn429?: number;
  baseBackoffMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export class ParasutRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxRetriesOn429: number;
  private readonly baseBackoffMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private timestamps: number[] = [];
  public totalSleepsMs: number[] = [];

  constructor(options: RateLimiterOptions = {}) {
    this.maxRequests = options.maxRequestsPerWindow ?? 8;
    this.windowMs = options.windowMs ?? 10_000;
    this.maxRetriesOn429 = options.maxRetriesOn429 ?? 4;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  private async acquireSlot(): Promise<void> {
    while (true) {
      const current = this.now();
      this.timestamps = this.timestamps.filter((t) => current - t < this.windowMs);
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(this.now());
        return;
      }
      const oldest = this.timestamps[0];
      const waitMs = Math.max(1, this.windowMs - (current - oldest));
      this.totalSleepsMs.push(waitMs);
      await this.sleep(waitMs);
    }
  }

  private parseRetryAfterMs(headers: Record<string, string> | undefined, attempt: number): number {
    const raw =
      headers?.["retry-after"] ??
      headers?.["Retry-After"] ??
      headers?.["x-ratelimit-reset"] ??
      null;
    if (raw) {
      const sec = Number(raw.trim());
      if (Number.isFinite(sec) && sec > 0) {
        return Math.min(30_000, Math.round(sec * 1000));
      }
    }
    return Math.min(30_000, this.baseBackoffMs * Math.pow(2, attempt));
  }

  async send(http: HttpClient, request: HttpRequest): Promise<HttpResponse> {
    let attempt = 0;
    while (true) {
      await this.acquireSlot();
      const response = await http.send(request);
      if (response.status !== 429 || attempt >= this.maxRetriesOn429) {
        return response;
      }
      const backoffMs = this.parseRetryAfterMs(response.headers, attempt);
      this.totalSleepsMs.push(backoffMs);
      await this.sleep(backoffMs);
      attempt += 1;
    }
  }
}

