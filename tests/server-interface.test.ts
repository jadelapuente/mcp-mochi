import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MOCHI_PROMPT_NAMES,
  MOCHI_RESOURCE_URIS,
  MOCHI_TOOL_NAMES,
  createMochiServer,
} from "../src/server.js";

describe("MCP public interface", () => {
  it("registers the documented tools, resources, and prompts", () => {
    const server = createMochiServer({
      getClient: () => {
        throw new Error("client should not be constructed during registration");
      },
    }) as any;

    expect(Object.keys(server._registeredTools)).toEqual([...MOCHI_TOOL_NAMES]);
    expect(Object.keys(server._registeredResources)).toEqual([
      ...MOCHI_RESOURCE_URIS,
    ]);
    expect(Object.keys(server._registeredPrompts)).toEqual([
      ...MOCHI_PROMPT_NAMES,
    ]);
  });

  it("does not require MOCHI_API_KEY until a default client is requested", () => {
    const original = process.env.MOCHI_API_KEY;
    delete process.env.MOCHI_API_KEY;
    try {
      expect(() => createMochiServer()).not.toThrow();
    } finally {
      if (original === undefined) {
        delete process.env.MOCHI_API_KEY;
      } else {
        process.env.MOCHI_API_KEY = original;
      }
    }
  });
});

describe("documented configuration", () => {
  it("uses the runtime environment variable name", () => {
    const envExample = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    expect(envExample).toContain("MOCHI_API_KEY=");
    expect(envExample).not.toContain("MOCHI_TOKEN=");
  });

  it("documents the registered tool names", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    for (const toolName of MOCHI_TOOL_NAMES) {
      expect(readme).toContain(`\`${toolName}\``);
    }
  });
});
