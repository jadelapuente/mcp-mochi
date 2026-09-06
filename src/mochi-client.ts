import axios, { AxiosInstance } from "axios";
import FormData from "form-data";

import {
  MAX_ATTACHMENT_BYTES,
  MAX_RESOURCE_PAGES,
  MOCHI_BATCH_CONCURRENCY,
} from "./constants.js";
import {
  listAllCards as listAllCardsWorkflow,
  listCards as listCardsWorkflow,
  listCardsDeep as listCardsDeepWorkflow,
} from "./card-listing.js";
import { searchCards as searchCardsWorkflow } from "./card-search.js";
import { MochiError } from "./errors.js";
import {
  MochiRequestGate,
  type MochiRequestGateRunOptions,
} from "./request-gate.js";
import {
  BatchArchiveItem,
  BatchCreateResult,
  BatchDeleteItem,
  BatchMutationResult,
  BatchUpdateItem,
  CardMalformedEntry,
  CardSchema,
  CardsPageEnvelopeSchema,
  CreateCardFromTemplateParams,
  CreateCardResponse,
  CreateCardResponseSchema,
  CreateCardRequest,
  CreateDeckRequest,
  Deck,
  DeckSchema,
  GetDueCardsParams,
  GetDueCardsParamsSchema,
  GetDueCardsResponse,
  GetDueCardsResponseSchema,
  ListCardsParams,
  ListCardsParamsSchema,
  ListCardsResponse,
  ListDecksParams,
  ListDecksParamsSchema,
  ListDecksResponse,
  ListDecksResponseSchema,
  ListTemplatesParams,
  ListTemplatesParamsSchema,
  ListTemplatesResponse,
  ListTemplatesResponseSchema,
  SearchFlashcardsParams,
  SearchFlashcardsResponse,
  Template,
  TemplateSchema,
  UpdateCardRequest,
  UpdateFlashcardResponse,
  UpdateFlashcardResponseSchema,
  UpdateDeckRequest,
  extractCardId,
  summarizeCardError,
} from "./schemas.js";
import {
  toMochiCreateCardRequest,
  toMochiCreateDeckRequest,
  toMochiListCardsParams,
  toMochiUpdateCardRequest,
  toMochiUpdateDeckRequest,
} from "./mochi-mappers.js";
import { collectBatchResults, collectMutationResults, runWithConcurrency } from "./batch.js";
import { descendantDeckIds } from "./deck-tree.js";
import { logMochiCall, summarizeArgs } from "./diagnostics.js";
import { buildCreateCardFromTemplateRequest } from "./template-card.js";

export interface AddAttachmentRequest {
  cardId: string;
  data: string;
  filename: string;
  contentType?: string;
}

export interface RequestGate {
  run<T>(
    fn: () => Promise<T>,
    options?: MochiRequestGateRunOptions
  ): Promise<T>;
}

export interface MochiClientOptions {
  gate?: RequestGate;
}

export class MochiClient {
  private api: AxiosInstance;
  private token: string;
  private gate: RequestGate | null = null;

  /**
   * @param token   Mochi API token
   * @param apiOverride  Inject an AxiosInstance (used by tests).
   * @param options      Optional request gate injection for transport tests.
   */
  constructor(
    token: string,
    apiOverride?: AxiosInstance,
    options: MochiClientOptions = {}
  ) {
    this.token = token;
    if (apiOverride) {
      this.api = apiOverride;
      this.gate = options.gate ?? null;
      return;
    }
    this.gate = options.gate ?? new MochiRequestGate(token);
    this.api = axios.create({
      baseURL: "https://app.mochi.cards/api/",
      timeout: 30000,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.token}:`).toString(
          "base64"
        )}`,
        "Content-Type": "application/json",
      },
    });

    this.api.interceptors.request.use((config) => {
      (
        config as { metadata?: { start: number; args: Record<string, unknown> } }
      ).metadata = {
        start: Date.now(),
        args: summarizeArgs(config.data),
      };
      return config;
    });

    this.api.interceptors.response.use(
      (response) => {
        const start = (response.config as { metadata?: { start: number } })
          .metadata?.start;
        logMochiCall(
          response.config,
          response.status,
          start ? Date.now() - start : -1
        );
        return response;
      },
      (error) => {
        const cfg = (
          error as {
            config?: {
              metadata?: { start: number; args?: Record<string, unknown> };
              method?: string;
              url?: string;
              data?: unknown;
            };
          }
        ).config;
        const ms = cfg?.metadata?.start ? Date.now() - cfg.metadata.start : -1;
        if (axios.isAxiosError(error)) {
          logMochiCall(
            error.config,
            error.response?.status ?? error.code ?? "ERR",
            ms,
            error.response?.data ?? error.message
          );
          if (error.response) {
            const { status, data } = error.response;
            if (status === 429 || status === 503) {
              throw error;
            }
            if (data && (Array.isArray(data) || typeof data === "object")) {
              throw new MochiError(data, status);
            }
            if (typeof data === "string" && data.length > 0) {
              throw new MochiError([data], status);
            }
            throw new MochiError(
              [`Request failed with status ${status}`],
              status
            );
          }
        } else {
          logMochiCall(
            cfg,
            "ERR",
            ms,
            error instanceof Error ? error.message : String(error)
          );
        }
        throw error;
      }
    );
  }

  /** Route HTTP through the account gate (serial + cross-process lock + retry). */
  private request<T>(
    fn: () => Promise<T>,
    options?: MochiRequestGateRunOptions
  ): Promise<T> {
    return this.gate ? this.gate.run(fn, options) : fn();
  }

  private readRequest<T>(fn: () => Promise<T>): Promise<T> {
    return this.request(fn, { retryTransientErrors: true });
  }

  async createCard(request: CreateCardRequest): Promise<CreateCardResponse> {
    if (request.attachments && Object.keys(request.attachments).length > 0) {
      throw new MochiError(
        [
          "createCard does not upload attachments. Use createCards (batch) which handles attachments after creating each card.",
        ],
        400
      );
    }
    const mochiRequest = toMochiCreateCardRequest(request);
    const response = await this.request(() =>
      this.api.post("/cards", mochiRequest)
    );
    return CreateCardResponseSchema.parse(response.data);
  }

  async updateCard(
    cardId: string,
    request: UpdateCardRequest
  ): Promise<CreateCardResponse> {
    const mochiRequest = toMochiUpdateCardRequest(request);
    const response = await this.request(() =>
      this.api.post(`/cards/${encodeURIComponent(cardId)}`, mochiRequest)
    );
    return CreateCardResponseSchema.parse(response.data);
  }

  async createDeck(request: CreateDeckRequest): Promise<Deck> {
    const mochiRequest = toMochiCreateDeckRequest(request);
    const response = await this.request(() =>
      this.api.post("/decks", mochiRequest)
    );
    return DeckSchema.parse(response.data);
  }

  async updateDeck(deckId: string, request: UpdateDeckRequest): Promise<Deck> {
    const mochiRequest = toMochiUpdateDeckRequest(request);
    const response = await this.request(() =>
      this.api.post(`/decks/${encodeURIComponent(deckId)}`, mochiRequest)
    );
    return DeckSchema.parse(response.data);
  }

  async listDecks(params?: ListDecksParams): Promise<ListDecksResponse> {
    const validatedParams = params
      ? ListDecksParamsSchema.parse(params)
      : undefined;

    if (validatedParams?.deckId) {
      const all = await this.listAllDecks();
      const wanted = validatedParams.includeSubdecks
        ? new Set(descendantDeckIds(all, validatedParams.deckId))
        : new Set([validatedParams.deckId]);
      return {
        bookmark: "",
        docs: all.filter((deck) => wanted.has(deck.id)),
      };
    }

    const response = await this.readRequest(() =>
      this.api.get("/decks", {
        params: validatedParams?.bookmark
          ? { bookmark: validatedParams.bookmark }
          : undefined,
      })
    );
    const parsed = ListDecksResponseSchema.parse(response.data);
    return {
      bookmark: parsed.bookmark,
      docs: parsed.docs
        .filter((deck) => !deck["archived?"] && !deck["trashed?"])
        .sort((a, b) => a.sort - b.sort),
    };
  }

  async listAllDecks(maxPages = MAX_RESOURCE_PAGES): Promise<Deck[]> {
    const all: Deck[] = [];
    let bookmark: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.listDecks(bookmark ? { bookmark } : undefined);
      all.push(...page.docs);
      if (!page.bookmark || page.docs.length === 0) break;
      bookmark = page.bookmark;
    }
    return all.sort((a, b) => a.sort - b.sort);
  }

  async listCards(params?: ListCardsParams): Promise<ListCardsResponse> {
    return listCardsWorkflow(this, params);
  }

  async listAllCards(deckId?: string): Promise<ListCardsResponse> {
    return listAllCardsWorkflow(this, deckId);
  }

  async fetchCardsPage(params?: ListCardsParams): Promise<ListCardsResponse> {
    const validatedParams = params
      ? ListCardsParamsSchema.parse(params)
      : undefined;
    const mochiParams = validatedParams
      ? toMochiListCardsParams(validatedParams)
      : undefined;
    const response = await this.readRequest(() =>
      this.api.get("/cards", { params: mochiParams })
    );

    const envelope = CardsPageEnvelopeSchema.parse(response.data);
    const docs: CreateCardResponse[] = [];
    const malformed: CardMalformedEntry[] = [];
    for (const raw of envelope.docs) {
      const result = CardSchema.safeParse(raw);
      if (!result.success) {
        malformed.push({
          id: extractCardId(raw),
          error: summarizeCardError(result.error),
        });
        continue;
      }
      const card = result.data;
      if (!card["archived?"] && !card["trashed?"]) docs.push(card);
    }

    return {
      bookmark: envelope.bookmark,
      docs,
      ...(malformed.length > 0 ? { malformed } : {}),
    };
  }

  async listCardsDeep(deckId: string): Promise<ListCardsResponse> {
    return listCardsDeepWorkflow(this, deckId);
  }

  async searchCards(
    params: SearchFlashcardsParams
  ): Promise<SearchFlashcardsResponse> {
    return searchCardsWorkflow(this, params);
  }

  async listTemplates(
    params?: ListTemplatesParams
  ): Promise<ListTemplatesResponse> {
    const validatedParams = params
      ? ListTemplatesParamsSchema.parse(params)
      : undefined;
    const { verbose, ...mochiParams } = validatedParams ?? {};
    const response = await this.readRequest(() =>
      this.api.get("/templates", {
        params: Object.keys(mochiParams).length ? mochiParams : undefined,
      })
    );
    const data = response.data;
    if (verbose) {
      return ListTemplatesResponseSchema.parse(data);
    }
    const slimDocs = (data?.docs ?? []).map((t: Template) => ({
      id: t.id,
      name: t.name,
      pos: t.pos,
      fields: Object.entries(t.fields ?? {}).map(([id, f]) => ({
        id,
        name: f.name,
      })),
    }));
    return ListTemplatesResponseSchema.parse({
      bookmark: data?.bookmark ?? "",
      docs: slimDocs,
    });
  }

  async listAllTemplates(
    maxPages = MAX_RESOURCE_PAGES
  ): Promise<ListTemplatesResponse["docs"]> {
    const all: ListTemplatesResponse["docs"] = [];
    let bookmark: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.listTemplates(
        bookmark ? { bookmark, verbose: false } : { verbose: false }
      );
      all.push(...page.docs);
      if (!page.bookmark || page.docs.length === 0) break;
      bookmark = page.bookmark;
    }
    return all;
  }

  async getDueCards(
    params?: GetDueCardsParams
  ): Promise<GetDueCardsResponse> {
    const validatedParams = params
      ? GetDueCardsParamsSchema.parse(params)
      : undefined;
    const deckId = validatedParams?.deckId;
    const endpoint = deckId ? `/due/${encodeURIComponent(deckId)}` : "/due";
    const queryParams = validatedParams?.date
      ? { date: validatedParams.date }
      : undefined;
    const response = await this.readRequest(() =>
      this.api.get(endpoint, { params: queryParams })
    );
    return GetDueCardsResponseSchema.parse(response.data);
  }

  async getTemplate(templateId: string): Promise<Template> {
    const response = await this.readRequest(() =>
      this.api.get(`/templates/${encodeURIComponent(templateId)}`)
    );
    return TemplateSchema.parse(response.data);
  }

  async createCardFromTemplate(
    request: CreateCardFromTemplateParams,
    cachedTemplate?: Template
  ): Promise<CreateCardResponse> {
    const template = cachedTemplate ?? (await this.getTemplate(request.templateId));
    const mochiRequest = buildCreateCardFromTemplateRequest(request, template);
    const response = await this.request(() =>
      this.api.post("/cards", mochiRequest)
    );
    return CreateCardResponseSchema.parse(response.data);
  }

  async deleteCard(cardId: string): Promise<void> {
    await this.request(() =>
      this.api.delete(`/cards/${encodeURIComponent(cardId)}`)
    );
  }

  async createCards(requests: CreateCardRequest[]): Promise<BatchCreateResult> {
    const settled = await runWithConcurrency(
      requests,
      MOCHI_BATCH_CONCURRENCY,
      async (req) => {
        const { attachments, ...cardReq } = req;
        const card = await this.createCard(cardReq);
        const attachmentErrors = await this.uploadAttachmentsBestEffort(
          card.id,
          attachments
        );
        return { card, attachmentErrors };
      }
    );
    return collectBatchResults(settled);
  }

  async createCardsFromTemplate(
    requests: CreateCardFromTemplateParams[]
  ): Promise<BatchCreateResult> {
    const uniqueTemplateIds = Array.from(
      new Set(requests.map((r) => r.templateId))
    );
    const templateCache = new Map<string, Template>();
    await Promise.all(
      uniqueTemplateIds.map(async (id) => {
        templateCache.set(id, await this.getTemplate(id));
      })
    );

    const settled = await runWithConcurrency(
      requests,
      MOCHI_BATCH_CONCURRENCY,
      async (req) => {
        const card = await this.createCardFromTemplate(
          req,
          templateCache.get(req.templateId)
        );
        const attachmentErrors = await this.uploadAttachmentsBestEffort(
          card.id,
          req.attachments
        );
        return { card, attachmentErrors };
      }
    );
    return collectBatchResults(settled);
  }

  private async uploadAttachmentsBestEffort(
    cardId: string,
    attachments: Record<string, string> | undefined
  ): Promise<{ filename: string; error: string }[]> {
    if (!attachments) return [];
    const errors: { filename: string; error: string }[] = [];
    for (const [filename, data] of Object.entries(attachments)) {
      try {
        await this.addAttachment({ cardId, filename, data });
      } catch (e) {
        errors.push({
          filename,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return errors;
  }

  async addAttachment(
    request: AddAttachmentRequest
  ): Promise<{ filename: string; markdown: string }> {
    let contentType = request.contentType;
    if (!contentType) {
      const ext = request.filename.split(".").pop()?.toLowerCase();
      const mimeTypes: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        ogg: "audio/ogg",
        mp4: "video/mp4",
        pdf: "application/pdf",
      };
      contentType = mimeTypes[ext ?? ""] ?? "application/octet-stream";
    }

    const estimatedBytes = Math.floor((request.data.length * 3) / 4);
    if (estimatedBytes > MAX_ATTACHMENT_BYTES) {
      throw new MochiError(
        [
          `Attachment "${request.filename}" is too large: ~${(
            estimatedBytes /
            1024 /
            1024
          ).toFixed(1)} MB exceeds the ${
            MAX_ATTACHMENT_BYTES / 1024 / 1024
          } MB limit.`,
        ],
        413
      );
    }

    const buffer = Buffer.from(request.data, "base64");
    const formData = new FormData();
    formData.append("file", buffer, {
      filename: request.filename,
      contentType,
    });

    await this.request(() =>
      this.api.post(
        `/cards/${encodeURIComponent(
          request.cardId
        )}/attachments/${encodeURIComponent(request.filename)}`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            Authorization: `Basic ${Buffer.from(`${this.token}:`).toString(
              "base64"
            )}`,
          },
        }
      )
    );

    return {
      filename: request.filename,
      markdown: `![](${request.filename})`,
    };
  }

  async updateCards(items: BatchUpdateItem[]): Promise<BatchMutationResult> {
    const settled = await runWithConcurrency(
      items,
      MOCHI_BATCH_CONCURRENCY,
      async (item) => {
        const { cardId, ...rest } = item;
        await this.updateCard(cardId, rest);
        return cardId;
      }
    );
    return collectMutationResults(items, settled);
  }

  async updateCardsBulk(
    cardIds: string[],
    patch: Omit<BatchUpdateItem, "cardId">
  ): Promise<BatchMutationResult> {
    const hasChange = Object.values(patch).some((v) => v !== undefined);
    if (!hasChange) {
      throw new MochiError(
        [
          "No change provided. Set at least one of deckId, templateId, or trashed to apply across the cards.",
        ],
        400
      );
    }
    const uniqueIds = Array.from(new Set(cardIds));
    const items = uniqueIds.map((cardId) => ({ cardId, ...patch }));
    return this.updateCards(items);
  }

  async archiveCards(items: BatchArchiveItem[]): Promise<BatchMutationResult> {
    const settled = await runWithConcurrency(
      items,
      MOCHI_BATCH_CONCURRENCY,
      async (item) => {
        await this.updateCard(item.cardId, { archived: item.archived });
        return item.cardId;
      }
    );
    return collectMutationResults(items, settled);
  }

  async deleteCards(items: BatchDeleteItem[]): Promise<BatchMutationResult> {
    const settled = await runWithConcurrency(
      items,
      MOCHI_BATCH_CONCURRENCY,
      async (item) => {
        await this.deleteCard(item.cardId);
        return item.cardId;
      }
    );
    return collectMutationResults(items, settled);
  }
}

export function pickChangedFields(
  updateArgs: Omit<BatchUpdateItem, "cardId">,
  card: CreateCardResponse
): UpdateFlashcardResponse {
  const changed: UpdateFlashcardResponse = { id: card.id };
  if (updateArgs.content !== undefined) changed.content = card.content;
  if (updateArgs.deckId !== undefined) changed["deck-id"] = card["deck-id"];
  if (updateArgs.templateId !== undefined)
    changed["template-id"] = card["template-id"] ?? null;
  if (updateArgs.fields !== undefined) changed.fields = card.fields;
  if (updateArgs.trashed !== undefined)
    changed.trashed = Boolean(card["trashed?"]);
  return changed;
}
