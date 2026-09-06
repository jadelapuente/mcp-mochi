import { describe, it, expect, vi, afterEach } from "vitest";
import { AxiosError } from "axios";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SerialQueue,
  MochiRequestGate,
  NoOpAccountLock,
  FileAccountLock,
  isRetryableRateLimit,
  isRetryableTransientError,
  backoffMs,
  retryAfterMs,
} from "../src/request-gate.js";

function axios429(): AxiosError {
  return new AxiosError(
    "Too Many Requests",
    "429",
    undefined,
    undefined,
    {
      status: 429,
      statusText: "Too Many Requests",
      headers: {},
      data: {},
      config: {} as never,
    }
  );
}

function axiosStatus(status: number, headers: Record<string, string> = {}): AxiosError {
  return new AxiosError(
    `HTTP ${status}`,
    String(status),
    undefined,
    undefined,
    {
      status,
      statusText: `HTTP ${status}`,
      headers,
      data: {},
      config: {} as never,
    }
  );
}

function axiosNetwork(code: string): AxiosError {
  return new AxiosError("network failure", code);
}

describe("SerialQueue", () => {
  it("runs tasks one at a time in order", async () => {
    const queue = new SerialQueue();
    const order: number[] = [];

    await Promise.all([
      queue.run(async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 20));
        order.push(2);
      }),
      queue.run(async () => {
        order.push(3);
      }),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });
});

describe("isRetryableRateLimit", () => {
  it("returns true for 429 and 503 axios errors", () => {
    expect(isRetryableRateLimit(axios429())).toBe(true);
    expect(
      isRetryableRateLimit(
        new AxiosError("unavailable", "503", undefined, undefined, {
          status: 503,
          statusText: "Service Unavailable",
          headers: {},
          data: {},
          config: {} as never,
        })
      )
    ).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isRetryableRateLimit(new Error("nope"))).toBe(false);
    expect(
      isRetryableRateLimit(
        new AxiosError("bad", "400", undefined, undefined, {
          status: 400,
          statusText: "Bad Request",
          headers: {},
          data: {},
          config: {} as never,
        })
      )
    ).toBe(false);
  });
});

describe("isRetryableTransientError", () => {
  it("returns true for retryable server and network failures", () => {
    expect(isRetryableTransientError(axiosStatus(502))).toBe(true);
    expect(isRetryableTransientError(axiosStatus(504))).toBe(true);
    expect(isRetryableTransientError(axiosNetwork("ECONNRESET"))).toBe(true);
    expect(isRetryableTransientError(axiosNetwork("EAI_AGAIN"))).toBe(true);
  });

  it("returns false for validation/client errors and non-axios errors", () => {
    expect(isRetryableTransientError(axiosStatus(400))).toBe(false);
    expect(isRetryableTransientError(axiosStatus(404))).toBe(false);
    expect(isRetryableTransientError(new Error("nope"))).toBe(false);
  });
});

describe("retryAfterMs", () => {
  it("parses numeric Retry-After seconds", () => {
    expect(retryAfterMs(axiosStatus(429, { "retry-after": "2" }))).toBe(2000);
    expect(retryAfterMs(axiosStatus(429, { "Retry-After": "3" }))).toBe(3000);
  });

  it("returns null when Retry-After is absent or invalid", () => {
    expect(retryAfterMs(axiosStatus(429))).toBeNull();
    expect(retryAfterMs(axiosStatus(429, { "retry-after": "later" }))).toBeNull();
  });
});

describe("backoffMs", () => {
  it("grows with attempt and stays capped", () => {
    expect(backoffMs(0)).toBeGreaterThanOrEqual(200);
    expect(backoffMs(10)).toBeLessThanOrEqual(5000 * 1.25);
  });
});

describe("MochiRequestGate retry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries on 429 and eventually succeeds", async () => {
    const gate = new MochiRequestGate("test-key", {
      disableAccountLock: true,
      sleep: async () => {},
      backoffMs: () => 0,
      logger: () => {},
    });
    let calls = 0;

    const result = await gate.run(async () => {
      calls++;
      if (calls < 3) throw axios429();
      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws after max retry attempts on persistent 429", async () => {
    const gate = new MochiRequestGate("test-key", {
      disableAccountLock: true,
      sleep: async () => {},
      backoffMs: () => 0,
      logger: () => {},
    });

    await expect(
      gate.run(async () => {
        throw axios429();
      })
    ).rejects.toThrow("Too Many Requests");
  });

  it("retries transient failures only when the caller opts in", async () => {
    const noRetryGate = new MochiRequestGate("test-key", {
      disableAccountLock: true,
      sleep: async () => {},
      backoffMs: () => 0,
      logger: () => {},
    });
    let noRetryCalls = 0;
    await expect(
      noRetryGate.run(async () => {
        noRetryCalls++;
        throw axiosStatus(502);
      })
    ).rejects.toThrow("HTTP 502");
    expect(noRetryCalls).toBe(1);

    const retryGate = new MochiRequestGate("test-key", {
      disableAccountLock: true,
      sleep: async () => {},
      backoffMs: () => 0,
      logger: () => {},
    });
    let retryCalls = 0;
    const result = await retryGate.run(
      async () => {
        retryCalls++;
        if (retryCalls === 1) throw axiosStatus(502);
        return "ok";
      },
      { retryTransientErrors: true }
    );
    expect(result).toBe("ok");
    expect(retryCalls).toBe(2);
  });

  it("releases the account lock before sleeping between retry attempts", async () => {
    const events: string[] = [];
    const gate = new MochiRequestGate("test-key", {
      lock: {
        async acquire() {
          events.push("acquire");
        },
        async release() {
          events.push("release");
        },
      },
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
      },
      backoffMs: () => 123,
      logger: () => {},
    });
    let calls = 0;

    const result = await gate.run(async () => {
      calls++;
      events.push(`call:${calls}`);
      if (calls === 1) throw axios429();
      return "ok";
    });

    expect(result).toBe("ok");
    expect(events).toEqual([
      "acquire",
      "call:1",
      "release",
      "sleep:123",
      "acquire",
      "call:2",
      "release",
    ]);
  });
});

describe("NoOpAccountLock", () => {
  it("acquire and release are no-ops", async () => {
    const lock = new NoOpAccountLock();
    await lock.acquire();
    await lock.release();
  });
});

describe("FileAccountLock", () => {
  it("gives up with a clear error instead of waiting forever for another process's lock", async () => {
    // Two chats on the same Mochi account each spawn their own mcp-mochi
    // process, so this is the real contention scenario: same key, two
    // FileAccountLock instances racing for the same on-disk lock.
    const apiKey = `test-account-${Date.now()}`;
    const cacheBase = await mkdtemp(join(tmpdir(), "mcp-mochi-test-"));
    const holder = new FileAccountLock(apiKey, { cacheBase });
    const contender = new FileAccountLock(apiKey, { cacheBase, maxWaitMs: 300 });

    await holder.acquire();
    try {
      const start = Date.now();
      await expect(contender.acquire()).rejects.toThrow(/timed out/i);
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      await holder.release();
      await rm(cacheBase, { force: true, recursive: true });
    }
  });
});
