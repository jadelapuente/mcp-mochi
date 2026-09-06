import {
  MAX_AGGREGATE_CARDS,
  MAX_RESOURCE_PAGES,
} from "./constants.js";
import { descendantDeckIds } from "./deck-tree.js";
import { MochiError } from "./errors.js";
import type {
  CardMalformedEntry,
  CreateCardResponse,
  Deck,
  ListCardsParams,
  ListCardsResponse,
} from "./schemas.js";
import { ListCardsParamsSchema } from "./schemas.js";

export interface CardListingDeps {
  fetchCardsPage(params?: ListCardsParams): Promise<ListCardsResponse>;
  listAllDecks(): Promise<Deck[]>;
}

export async function listCards(
  deps: CardListingDeps,
  params?: ListCardsParams
): Promise<ListCardsResponse> {
  const validatedParams = params ? ListCardsParamsSchema.parse(params) : undefined;

  if (validatedParams?.includeSubdecks) {
    if (!validatedParams.deckId) {
      throw new MochiError(
        ["includeSubdecks requires deckId - it cascades a single deck's subtree."],
        400
      );
    }
    return listCardsDeep(deps, validatedParams.deckId);
  }

  return listAllCards(deps, validatedParams?.deckId);
}

export async function listAllCards(
  deps: Pick<CardListingDeps, "fetchCardsPage">,
  deckId?: string
): Promise<ListCardsResponse> {
  const docs: CreateCardResponse[] = [];
  const malformed: CardMalformedEntry[] = [];
  let bookmark: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_RESOURCE_PAGES; page++) {
    const res = await deps.fetchCardsPage({ deckId, limit: 100, bookmark });
    docs.push(...res.docs);
    if (res.malformed) malformed.push(...res.malformed);
    if (docs.length >= MAX_AGGREGATE_CARDS) {
      truncated = true;
      break;
    }
    const pageEmpty = res.docs.length === 0 && (res.malformed?.length ?? 0) === 0;
    if (!res.bookmark || pageEmpty) break;
    bookmark = res.bookmark;
  }

  return {
    bookmark: null,
    docs: truncated ? docs.slice(0, MAX_AGGREGATE_CARDS) : docs,
    truncated,
    ...(malformed.length > 0 ? { malformed } : {}),
  };
}

export async function listCardsDeep(
  deps: CardListingDeps,
  deckId: string
): Promise<ListCardsResponse> {
  const all = await deps.listAllDecks();
  const deckIds = descendantDeckIds(all, deckId);
  const docs: CreateCardResponse[] = [];
  const malformed: CardMalformedEntry[] = [];
  let truncated = false;

  outer: for (const id of deckIds) {
    let bookmark: string | undefined;
    for (let page = 0; page < MAX_RESOURCE_PAGES; page++) {
      const res = await deps.fetchCardsPage({ deckId: id, limit: 100, bookmark });
      docs.push(...res.docs);
      if (res.malformed) malformed.push(...res.malformed);
      if (docs.length >= MAX_AGGREGATE_CARDS) {
        truncated = true;
        break outer;
      }
      const pageEmpty = res.docs.length === 0 && (res.malformed?.length ?? 0) === 0;
      if (!res.bookmark || pageEmpty) break;
      bookmark = res.bookmark;
    }
  }

  return {
    bookmark: null,
    docs: truncated ? docs.slice(0, MAX_AGGREGATE_CARDS) : docs,
    truncated,
    ...(malformed.length > 0 ? { malformed } : {}),
  };
}
