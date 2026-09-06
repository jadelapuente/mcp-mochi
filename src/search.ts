/** Lowercase, collapse whitespace, strip punctuation that distorts trigrams. */
export function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_~#>\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build the set of 3-character sliding windows after normalization. */
export function trigrams(s: string): Set<string> {
  const norm = normalizeForSearch(s);
  const out = new Set<string>();
  if (norm.length === 0) return out;
  if (norm.length < 3) {
    out.add(norm);
    return out;
  }
  for (let i = 0; i <= norm.length - 3; i++) {
    out.add(norm.slice(i, i + 3));
  }
  return out;
}

/** Jaccard similarity of two trigram sets in [0, 1]. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Extract a snippet of approx `contextChars` characters around an index. */
export function extractSnippet(
  content: string,
  matchIndex: number,
  contextChars: number
): string {
  const start = Math.max(0, matchIndex - Math.floor(contextChars / 2));
  const end = Math.min(content.length, start + contextChars);
  const slice = content.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${slice}${suffix}`;
}
