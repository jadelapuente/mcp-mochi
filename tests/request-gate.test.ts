import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AxiosError } from "axios";

import {
  SerialQueue,
  MochiRequestGate,
  NoOpAccountLock,
  isRetryableRateLimit,
  backoffMs,
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

describe("backoffMs", () => {
  it("grows with attempt and stays capped", () => {
    expect(backoffMs(0)).toBeGreaterThanOrEqual(200);
    expect(backoffMs(10)).toBeLessThanOrEqual(5000 * 1.25);
  });
});

describe("MochiRequestGate retry", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries on 429 and eventually succeeds", async () => {
    const gate = new MochiRequestGate("test-key", {
      disableAccountLock: true,
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
    });

    await expect(
      gate.run(async () => {
        throw axios429();
      })
    ).rejects.toThrow("Too Many Requests");
  });
});

describe("NoOpAccountLock", () => {
  it("acquire and release are no-ops", async () => {
    const lock = new NoOpAccountLock();
    await lock.acquire();
    await lock.release();
  });
});
