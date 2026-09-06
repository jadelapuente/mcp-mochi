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

// Every chat/session spawns its own mcp-mochi process, so this lock routinely
// contends across processes (not just within one). Cap the wait instead of
// retrying forever: if another process is genuinely stuck mid-request, every
// other chat should get a clear error rather than hang indefinitely.
const DEFAULT_LOCK_MAX_WAIT_MS = 60_000;

/** Cross-process advisory lock keyed by API key hash (same host). */
export class FileAccountLock implements AccountLock {
  private readonly lockTarget: string;
  private readonly maxWaitMs: number;
  private releaseFn: (() => Promise<void>) | null = null;

  constructor(apiKey: string, options?: { maxWaitMs?: number; cacheBase?: string }) {
    const hash = createHash("sha256").update(apiKey).digest("hex");
    const cacheBase =
      options?.cacheBase ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
    this.lockTarget = join(cacheBase, "mcp-mochi", "locks", hash);
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS;
  }

  async acquire(): Promise<void> {
    const dir = join(this.lockTarget, "..");
    await mkdir(dir, { recursive: true });
    // proper-lockfile requires the target path to exist.
    await writeFile(this.lockTarget, "", { flag: "a" });
    try {
      this.releaseFn = await lockfile.lock(this.lockTarget, {
        retries: {
          forever: true,
          minTimeout: 50,
          maxTimeout: 2000,
          maxRetryTime: this.maxWaitMs,
        },
      });
    } catch {
      throw new Error(
        `Timed out after ${Math.round(this.maxWaitMs / 1000)}s waiting for the Mochi account lock (${
          this.lockTarget
        }). Another mcp-mochi process — e.g. a different open chat — is likely mid-request. Wait for it to finish, or if none is actually running, delete that lock file and retry.`
      );
    }
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
const RETRY_AFTER_MAX_MS = 60_000;

export interface MochiRequestGateRunOptions {
  /**
   * Retry transport/server failures where a repeat request is safe for the
   * caller. Use this for read-only/idempotent requests, not card creation.
   */
  retryTransientErrors?: boolean;
}

export function isRetryableRateLimit(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status === 429 || status === 503;
  }
  return false;
}

export function isRetryableTransientError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  if (status !== undefined) {
    return [408, 425, 429, 500, 502, 503, 504].includes(status);
  }
  return [
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNABORTED",
    "EAI_AGAIN",
    "ERR_NETWORK",
  ].includes(error.code ?? "");
}

export function retryAfterMs(error: unknown): number | null {
  if (!axios.isAxiosError(error)) return null;
  const headers = error.response?.headers as
    | ({ get?: (name: string) => unknown } & Record<string, unknown>)
    | undefined;
  const raw =
    headers?.get?.("retry-after") ??
    headers?.["retry-after"] ??
    headers?.["Retry-After"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" && typeof value !== "number") return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
  }

  const dateMs = Date.parse(String(value));
  if (!Number.isFinite(dateMs)) return null;
  return Math.min(Math.max(0, dateMs - Date.now()), RETRY_AFTER_MAX_MS);
}

export function backoffMs(attempt: number): number {
  const exp = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
  const jitter = Math.random() * exp * 0.25;
  return exp + jitter;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface MochiRequestGateOptions {
  disableAccountLock?: boolean;
  lock?: AccountLock;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: (attempt: number) => number;
  logger?: (message: string) => void;
}

/**
 * One in-flight Mochi HTTP request per account: in-process queue, optional
 * cross-process file lock, and 429/503 retry with backoff.
 */
export class MochiRequestGate {
  private readonly queue = new SerialQueue();
  private readonly lock: AccountLock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly getBackoffMs: (attempt: number) => number;
  private readonly logger: (message: string) => void;

  constructor(apiKey: string, options?: MochiRequestGateOptions) {
    const disabled =
      options?.disableAccountLock ||
      process.env.MOCHI_DISABLE_ACCOUNT_LOCK === "1";
    this.lock =
      options?.lock ?? (disabled ? new NoOpAccountLock() : new FileAccountLock(apiKey));
    this.sleep = options?.sleep ?? defaultSleep;
    this.getBackoffMs = options?.backoffMs ?? backoffMs;
    this.logger = options?.logger ?? console.error;
  }

  run<T>(
    fn: () => Promise<T>,
    options: MochiRequestGateRunOptions = {}
  ): Promise<T> {
    return this.queue.run(() => this.runWithLockAndRetry(fn, options));
  }

  private async runWithLockAndRetry<T>(
    fn: () => Promise<T>,
    options: MochiRequestGateRunOptions
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      await this.lock.acquire();
      let retryDelayMs: number | null = null;
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const retryable =
          isRetryableRateLimit(error) ||
          (options.retryTransientErrors && isRetryableTransientError(error));
        if (retryable && attempt < MAX_RETRY_ATTEMPTS - 1) {
          retryDelayMs = retryAfterMs(error) ?? this.getBackoffMs(attempt);
          const retryCause = axios.isAxiosError(error)
            ? {
                status: error.response?.status,
                code: error.code,
              }
            : {};
          this.logger(
            `[mochi] ${JSON.stringify({
              t: new Date().toISOString(),
              event: "request_retry",
              attempt: attempt + 1,
              maxAttempts: MAX_RETRY_ATTEMPTS,
              delayMs: Math.round(retryDelayMs),
              ...retryCause,
            })}`
          );
        } else {
          throw error;
        }
      } finally {
        await this.lock.release();
      }
      await this.sleep(retryDelayMs);
    }
    throw lastError;
  }
}
