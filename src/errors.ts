/**
 * Custom error class for Mochi API errors.
 *
 * Handles both array and object error responses from the API:
 * - Array: ["Error message 1", "Error message 2"]
 * - Object: { "field": "Error message" }
 */
export class MochiError extends Error {
  errors: string[] | Record<string, string>;
  statusCode: number;

  constructor(errors: string[] | Record<string, string>, statusCode: number) {
    const flatten = (v: unknown) =>
      typeof v === "string" ? v : JSON.stringify(v);
    super(
      Array.isArray(errors)
        ? errors.map(flatten).join(", ")
        : Object.values(errors).map(flatten).join(", ")
    );
    this.errors = errors;
    this.statusCode = statusCode;
    this.name = "MochiError";
  }
}
