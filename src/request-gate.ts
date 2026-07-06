import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import axios from "axios";
import lockfile from "proper-lockfile";

/** Serializes async work within a single process (promise chain). */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

export interface AccountLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export class NoOpAccountLock implements AccountLock {
  async acquire(): Promise<void> {}
  async release(): Promise<void> {}
}

/** Cross-process advisory lock keyed by API key hash (same host). */
export class FileAccountLock implements AccountLock {
  private readonly lockTarget: string;
  private releaseFn: (() => Promise<void>) | null = null;

  constructor(apiKey: string) {
    const hash = createHash("sha256").update(apiKey).digest("hex");
    const cacheBase =
      process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
    this.lockTarget = join(cacheBase, "mcp-mochi", "locks", hash);
  }

  async acquire(): Promise<void> {
    const dir = join(this.lockTarget, "..");
    await mkdir(dir, { recursive: true });
    // proper-lockfile requires the target path to exist.
    await writeFile(this.lockTarget, "", { flag: "a" });
    this.releaseFn = await lockfile.lock(this.lockTarget, {
      retries: {
        forever: true,
        minTimeout: 50,
        maxTimeout: 2000,
      },
    });
  }

  async release(): Promise<void> {
    if (!this.releaseFn) return;
    const release = this.releaseFn;
    this.releaseFn = null;
    await release();
  }
}

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 200;
const RETRY_MAX_MS = 5000;

export function isRetryableRateLimit(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status === 429 || status === 503;
  }
  return false;
}

export function backoffMs(attempt: number): number {
  const exp = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
  const jitter = Math.random() * exp * 0.25;
  return exp + jitter;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One in-flight Mochi HTTP request per account: in-process queue, optional
 * cross-process file lock, and 429/503 retry with backoff.
 */
export class MochiRequestGate {
  private readonly queue = new SerialQueue();
  private readonly lock: AccountLock;

  constructor(apiKey: string, options?: { disableAccountLock?: boolean }) {
    const disabled =
      options?.disableAccountLock ||
      process.env.MOCHI_DISABLE_ACCOUNT_LOCK === "1";
    this.lock = disabled ? new NoOpAccountLock() : new FileAccountLock(apiKey);
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.run(() => this.runWithLockAndRetry(fn));
  }

  private async runWithLockAndRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      await this.lock.acquire();
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (isRetryableRateLimit(error) && attempt < MAX_RETRY_ATTEMPTS - 1) {
          console.error(
            `[mochi] ${JSON.stringify({
              t: new Date().toISOString(),
              event: "rate_limit_retry",
              attempt: attempt + 1,
              maxAttempts: MAX_RETRY_ATTEMPTS,
            })}`
          );
          await sleep(backoffMs(attempt));
          continue;
        }
        throw error;
      } finally {
        await this.lock.release();
      }
    }
    throw lastError;
  }
}
