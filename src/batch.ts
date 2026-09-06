import type {
  BatchCreateResult,
  BatchMutationResult,
  CreateCardResponse,
} from "./schemas.js";

export interface BatchAttemptResult {
  card: CreateCardResponse;
  attachmentErrors: { filename: string; error: string }[];
}

export function collectBatchResults(
  settled: PromiseSettledResult<BatchAttemptResult>[]
): BatchCreateResult {
  const created: BatchCreateResult["created"] = [];
  const failed: BatchCreateResult["failed"] = [];
  const attachmentErrors: BatchCreateResult["attachmentErrors"] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      created.push({ id: r.value.card.id, "deck-id": r.value.card["deck-id"] });
      for (const ae of r.value.attachmentErrors) {
        attachmentErrors.push({
          index: i,
          cardId: r.value.card.id,
          filename: ae.filename,
          error: ae.error,
        });
      }
    } else {
      const err = r.reason;
      failed.push({
        index: i,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return { created, failed, attachmentErrors };
}

export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        try {
          results[i] = { status: "fulfilled", value: await fn(items[i], i) };
        } catch (e) {
          results[i] = { status: "rejected", reason: e };
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}

export interface HasCardId {
  cardId: string;
}

export function collectMutationResults(
  inputs: HasCardId[],
  settled: PromiseSettledResult<string>[]
): BatchMutationResult {
  let succeeded = 0;
  const failed: BatchMutationResult["failed"] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      succeeded++;
    } else {
      const err = r.reason;
      failed.push({
        index: i,
        cardId: inputs[i].cardId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return { succeeded, failed };
}
