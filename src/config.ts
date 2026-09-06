export function getApiKey(): string {
  const apiKey = process.env.MOCHI_API_KEY;
  if (!apiKey) {
    throw new Error("MOCHI_API_KEY environment variable is not set");
  }
  return apiKey;
}
