import { extractSnippet, jaccard, trigrams } from "./search.js";
import type {
  ListCardsParams,
  ListCardsResponse,
  SearchFlashcardsParams,
  SearchFlashcardsResponse,
  SearchMatch,
} from "./schemas.js";
import { SearchFlashcardsParamsSchema } from "./schemas.js";

export interface CardSearchDeps {
  fetchCardsPage(params?: ListCardsParams): Promise<ListCardsResponse>;
}

export async function searchCards(
  deps: CardSearchDeps,
  params: SearchFlashcardsParams
): Promise<SearchFlashcardsResponse> {
  const { query, deckId, mode, limit, maxScanned, threshold, contextChars } =
    SearchFlashcardsParamsSchema.parse(params);

  const queryTrigrams = mode === "fuzzy" ? trigrams(query) : null;
  const queryLower = mode === "substring" ? query.toLowerCase() : null;

  const matches: SearchMatch[] = [];
  let scanned = 0;
  let bookmark: string | undefined;
  let truncated = false;

  while (scanned < maxScanned) {
    const remainingScan = maxScanned - scanned;
    const page = await deps.fetchCardsPage({
      deckId,
      limit: Math.min(100, Math.max(1, remainingScan)),
      bookmark,
    });

    for (const card of page.docs) {
      if (scanned >= maxScanned) {
        truncated = true;
        break;
      }
      scanned++;
      const content = card.content ?? "";
      if (mode === "substring") {
        const idx = content.toLowerCase().indexOf(queryLower!);
        if (idx !== -1) {
          matches.push({
            id: card.id,
            "deck-id": card["deck-id"],
            snippet: extractSnippet(content, idx, contextChars),
          });
        }
      } else {
        const score = jaccard(queryTrigrams!, trigrams(content));
        if (score >= threshold) {
          matches.push({
            id: card.id,
            "deck-id": card["deck-id"],
            snippet: extractSnippet(content, 0, contextChars),
            score,
          });
        }
      }
    }

    if (!page.bookmark || page.docs.length === 0) break;
    bookmark = page.bookmark;
  }

  if (mode === "fuzzy") {
    matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  return {
    matches: matches.slice(0, limit),
    scanned,
    truncated,
  };
}
