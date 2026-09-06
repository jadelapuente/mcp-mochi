import type {
  CreateCardRequest,
  CreateDeckRequest,
  ListCardsParams,
  UpdateCardRequest,
  UpdateDeckRequest,
} from "./schemas.js";

export function toMochiCreateCardRequest(
  params: CreateCardRequest
): Record<string, unknown> {
  return {
    content: params.content,
    "deck-id": params.deckId,
    "template-id": params.templateId,
    "manual-tags": params.tags,
  };
}

export function toMochiUpdateCardRequest(
  params: UpdateCardRequest
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (params.content !== undefined) result.content = params.content;
  if (params.deckId !== undefined) result["deck-id"] = params.deckId;
  if (params.templateId !== undefined) result["template-id"] = params.templateId;
  if (params.archived !== undefined) result["archived?"] = params.archived;
  if (params.trashed !== undefined) result["trashed?"] = params.trashed;
  if (params.fields !== undefined) result.fields = params.fields;
  return result;
}

export function toMochiCreateDeckRequest(
  params: CreateDeckRequest
): Record<string, unknown> {
  const result: Record<string, unknown> = { name: params.name };
  if (params.parentId !== undefined) result["parent-id"] = params.parentId;
  return result;
}

export function toMochiUpdateDeckRequest(
  params: UpdateDeckRequest
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (params.name !== undefined) result.name = params.name;
  if (params.parentId !== undefined) result["parent-id"] = params.parentId;
  if (params.trashed !== undefined) result["trashed?"] = params.trashed;
  return result;
}

export function toMochiListCardsParams(
  params: ListCardsParams
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (params.deckId !== undefined) result["deck-id"] = params.deckId;
  if (params.limit !== undefined) result.limit = params.limit;
  if (params.bookmark !== undefined) result.bookmark = params.bookmark;
  return result;
}
