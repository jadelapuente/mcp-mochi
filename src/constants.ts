export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_RESOURCE_PAGES = 50;
export const MAX_AGGREGATE_CARDS = 2000;

// Mochi allows one in-flight request per account; batch helpers stay serial too.
export const MOCHI_BATCH_CONCURRENCY = 1;
