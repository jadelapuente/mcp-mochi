#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

import { createMochiServer } from "./server.js";

export * from "./batch.js";
export * from "./card-listing.js";
export * from "./card-search.js";
export * from "./config.js";
export * from "./constants.js";
export * from "./deck-tree.js";
export * from "./diagnostics.js";
export * from "./errors.js";
export * from "./mochi-client.js";
export * from "./mochi-mappers.js";
export * from "./request-gate.js";
export * from "./schemas.js";
export * from "./search.js";
export * from "./server.js";
export * from "./template-card.js";
export * from "./tool-response.js";

export async function runServer(): Promise<void> {
  dotenv.config();
  const server = createMochiServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMainModule = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  runServer().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
  });
}
