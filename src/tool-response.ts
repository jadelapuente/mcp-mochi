import { z } from "zod";

import { MochiError } from "./errors.js";

export function formatToolError(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  if (error instanceof z.ZodError) {
    const formattedErrors = error.issues.map((issue) => {
      const path = issue.path.join(".");
      const message =
        issue.code === "invalid_type" && issue.message.includes("Required")
          ? `Required field '${path}' is missing`
          : issue.message;
      return `${path ? `${path}: ` : ""}${message}`;
    });
    return {
      content: [
        {
          type: "text",
          text: `Validation error:\n${formattedErrors.join("\n")}`,
        },
      ],
      isError: true,
    };
  }
  if (error instanceof MochiError) {
    return {
      content: [
        {
          type: "text",
          text: `Mochi API error (${error.statusCode}): ${error.message}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  };
}

export function jsonToolResponse<T>(structuredContent: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}
