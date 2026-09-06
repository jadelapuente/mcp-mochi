/**
 * Condense a request body into log-safe metadata: field lengths and a flag for
 * non-printable-ASCII characters. Raw content is never logged.
 */
export function summarizeArgs(data: unknown): Record<string, unknown> {
  if (data == null) return {};
  if (typeof (data as { getHeaders?: unknown })?.getHeaders === "function") {
    return { body: "multipart" };
  }
  let serialized: string;
  try {
    serialized = typeof data === "string" ? data : JSON.stringify(data) ?? "";
  } catch {
    return { body: "unserializable" };
  }
  const summary: Record<string, unknown> = {
    bodyLen: serialized.length,
    hasSpecialChars: /[^\x20-\x7E\t\n\r]/.test(serialized),
  };
  if (typeof data === "object") {
    const fieldLens: Record<string, number> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (typeof v === "string") fieldLens[k] = v.length;
    }
    if (Object.keys(fieldLens).length) summary.fieldLens = fieldLens;
  }
  return summary;
}

/**
 * Emit one structured stderr line per Mochi HTTP call. stderr is safe on a
 * stdio MCP server because stdout carries JSON-RPC.
 */
export function logMochiCall(
  config:
    | {
        method?: string;
        url?: string;
        data?: unknown;
        metadata?: { args?: Record<string, unknown> };
      }
    | undefined,
  status: number | string,
  durationMs: number,
  errPayload?: unknown
): void {
  const args = config?.metadata?.args ?? summarizeArgs(config?.data);
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    method: (config?.method ?? "?").toUpperCase(),
    url: config?.url ?? "?",
    status,
    ms: durationMs,
    ...args,
  };
  if (errPayload !== undefined) {
    line.error =
      typeof errPayload === "string" ? errPayload : JSON.stringify(errPayload);
  }
  console.error(`[mochi] ${JSON.stringify(line)}`);
}
