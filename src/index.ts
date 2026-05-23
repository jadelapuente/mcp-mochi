#!/usr/bin/env node

import axios, { AxiosInstance } from "axios";
import FormData from "form-data";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

/**
 * Custom error class for Mochi API errors
 *
 * Handles both array and object error responses from the API:
 * - Array: ["Error message 1", "Error message 2"]
 * - Object: { "field": "Error message" }
 */
export class MochiError extends Error {
  errors: string[] | Record<string, string>;
  statusCode: number;

  constructor(errors: string[] | Record<string, string>, statusCode: number) {
    super(
      Array.isArray(errors)
        ? errors.join(", ")
        : Object.values(errors).join(", ")
    );
    this.errors = errors;
    this.statusCode = statusCode;
    this.name = "MochiError";
  }
}

// Zod schemas for request validation
const CreateCardFieldSchema = z.object({
  id: z.string().describe("Unique identifier for the field"),
  value: z.string().describe("Value of the field"),
});

const CreateCardRequestSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      "Markdown content of the card. Separate the question and answer with a horizontal rule (3 dashes) surrounded by newlines: '\\n---\\n'. IMPORTANT: the dashes must be on an empty line."
    ),
  deckId: z.string().min(1).describe("ID of the deck to create the card in"),
  templateId: z
    .string()
    .optional()
    .nullable()
    .default(null)
    .describe(
      "Optional template ID to use for the card. Defaults to null if not set."
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe("Optional array of tags to add to the card"),
  attachments: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "REQUIRED when referencing images/audio in content. Map of filename (with extension) to base64 data. Example: { 'img1234.png': '<base64>' } and reference as ![](img1234.png). The filename must match EXACTLY including extension."
    ),
});

const UpdateCardRequestSchema = z.object({
  content: z
    .string()
    .optional()
    .describe("Updated markdown content of the card"),
  deckId: z.string().optional().describe("ID of the deck to move the card to"),
  templateId: z.string().optional().describe("Template ID to use for the card"),
  archived: z.boolean().optional().describe("Whether the card is archived"),
  trashed: z.boolean().optional().describe("Whether the card is trashed"),
  fields: z
    .record(z.string(), CreateCardFieldSchema)
    .optional()
    .describe("Updated map of field IDs to field values"),
});

const ListDecksParamsSchema = z.object({
  bookmark: z
    .string()
    .optional()
    .describe("Pagination bookmark for fetching next page of results"),
});

const ListCardsParamsSchema = z.object({
  deckId: z.string().optional().describe("Get cards from deck ID"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of cards to return per page (1-100)"),
  bookmark: z
    .string()
    .optional()
    .describe("Pagination bookmark for fetching next page of results"),
});

const ListTemplatesParamsSchema = z.object({
  bookmark: z
    .string()
    .optional()
    .describe("Pagination bookmark for fetching next page of results"),
  verbose: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, include full template content and per-field details. Default false returns only id/name/position and field id+name, which is sufficient for picking a template and supplying create_cards_from_template fields."
    ),
});

const GetTemplateParamsSchema = z.object({
  templateId: z.string().min(1).describe("ID of the template to fetch"),
});

const GetDueCardsParamsSchema = z.object({
  deckId: z
    .string()
    .optional()
    .describe("Optional deck ID to filter due cards by a specific deck"),
  date: z
    .string()
    .optional()
    .describe(
      "Optional ISO 8601 date to get cards due on that date. Defaults to today."
    ),
});

const CreateCardFromTemplateSchema = z.object({
  templateId: z
    .string()
    .min(1)
    .describe("ID of the template to use. Get this from list_templates."),
  deckId: z
    .string()
    .min(1)
    .describe(
      "ID of the deck to create the card in. Get this from list_decks."
    ),
  fields: z
    .record(z.string(), z.string())
    .describe(
      'Map of field NAMES (not IDs) to values. E.g., { "Word": "serendipity" }'
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe("Optional array of tags to add to the card"),
  attachments: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "REQUIRED when referencing images/audio in fields. Map of filename (with extension) to base64 data. Example: { 'img1234.png': '<base64>' } and reference as ![alt](img1234.png). The filename must match EXACTLY including extension."
    ),
});

const CreateCardsRequestSchema = z.object({
  cards: z
    .array(CreateCardRequestSchema)
    .min(1)
    .describe(
      "Array of cards to create. Pass an array even for a single card."
    ),
});

const CreateCardsFromTemplateRequestSchema = z.object({
  cards: z
    .array(CreateCardFromTemplateSchema)
    .min(1)
    .describe(
      "Array of template-based cards to create. Pass an array even for a single card."
    ),
});

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB decoded
const MAX_RESOURCE_PAGES = 50; // Safety cap when paginating resources

// Internal type for adding attachments (used by addAttachment method)
interface AddAttachmentRequest {
  cardId: string;
  data: string;
  filename: string;
  contentType?: string;
}

// Helper to transform camelCase params to hyphenated format for Mochi API
function toMochiCreateCardRequest(
  params: CreateCardRequest
): Record<string, unknown> {
  return {
    content: params.content,
    "deck-id": params.deckId,
    "template-id": params.templateId,
    "manual-tags": params.tags,
  };
}

function toMochiUpdateCardRequest(
  params: UpdateCardRequest
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (params.content !== undefined) result.content = params.content;
  if (params.deckId !== undefined) result["deck-id"] = params.deckId;
  if (params.templateId !== undefined)
    result["template-id"] = params.templateId;
  if (params.archived !== undefined) result["archived?"] = params.archived;
  if (params.trashed !== undefined) result["trashed?"] = params.trashed;
  if (params.fields !== undefined) result.fields = params.fields;
  return result;
}

function toMochiListCardsParams(
  params: ListCardsParams
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (params.deckId !== undefined) result["deck-id"] = params.deckId;
  if (params.limit !== undefined) result.limit = params.limit;
  if (params.bookmark !== undefined) result.bookmark = params.bookmark;
  return result;
}

const TemplateFieldSchema = z.object({
  id: z.string().describe("Unique identifier for the template field"),
  name: z.string().describe("Display name of the field"),
  pos: z.string().describe("Position of the field in the template"),
  type: z
    .string()
    .optional()
    .nullable()
    .describe(
      "Field type: null/text for user input, or ai/speech/translate/dictionary for auto-generated"
    ),
  source: z
    .string()
    .optional()
    .nullable()
    .describe("Source field ID for auto-generated fields"),
  options: z
    .object({
      "multi-line?": z
        .boolean()
        .optional()
        .describe("Whether the field supports multiple lines of text"),
    })
    .passthrough()
    .optional()
    .describe("Additional options for the field"),
});

const TemplateSchema = z
  .object({
    id: z.string().describe("Unique identifier for the template"),
    name: z.string().describe("Display name of the template"),
    content: z.string().describe("Template content in markdown format"),
    pos: z.string().describe("Position of the template in the list"),
    fields: z
      .record(z.string(), TemplateFieldSchema)
      .describe("Map of field IDs to field definitions"),
  })
  .strip();

const SlimTemplateFieldSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const SlimTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  pos: z.string(),
  fields: z.array(SlimTemplateFieldSchema),
});

const ListTemplatesResponseSchema = z
  .object({
    bookmark: z.string().describe("Pagination bookmark for fetching next page"),
    docs: z
      .array(z.union([TemplateSchema, SlimTemplateSchema]))
      .describe(
        "Array of templates. Slim by default (id, name, pos, field id+name). Pass verbose:true to get full template content and field details."
      ),
  })
  .strip();

type ListTemplatesParams = z.infer<typeof ListTemplatesParamsSchema>;
type ListTemplatesResponse = z.infer<typeof ListTemplatesResponseSchema>;
type ListCardsParams = z.infer<typeof ListCardsParamsSchema>;
type ListDecksParams = z.infer<typeof ListDecksParamsSchema>;
type CreateCardRequest = z.infer<typeof CreateCardRequestSchema>;
type UpdateCardRequest = z.infer<typeof UpdateCardRequestSchema>;
type GetDueCardsParams = z.infer<typeof GetDueCardsParamsSchema>;
type CreateCardFromTemplateParams = z.infer<
  typeof CreateCardFromTemplateSchema
>;

// Response Zod schemas
const CardSchema = z
  .object({
    id: z.string().describe("Unique identifier for the card"),
    tags: z
      .array(z.string())
      .describe("Array of tags associated with the card"),
    content: z
      .string()
      .describe(
        'Markdown content of the card. Separate the question and answer with "---"'
      ),
    name: z.string().describe("Display name of the card"),
    "deck-id": z.string().describe("ID of the deck containing the card"),
    "archived?": z.boolean().optional().nullable(),
    "trashed?": z.object({ date: z.string() }).optional().nullable(),
    fields: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Map of field IDs to field values. Need to match the field IDs in the template"
      ),
  })
  .strip();

const CreateCardResponseSchema = CardSchema.strip();
const UpdateCardResponseSchema = CardSchema.strip();

const ListCardsResponseSchema = z
  .object({
    bookmark: z.string()
      .nullable()
      .optional()
      .describe("Pagination bookmark for fetching next page"),
    docs: z.array(CardSchema).describe("Array of cards"),
  })
  .strip();

type CreateCardResponse = z.infer<typeof CreateCardResponseSchema>;
type ListDecksResponse = z.infer<typeof ListDecksResponseSchema>;
type ListCardsResponse = z.infer<typeof ListCardsResponseSchema>;

const SlimCreatedCardSchema = z.object({
  id: z.string().describe("Mochi card ID"),
  "deck-id": z.string().describe("ID of the deck the card was created in"),
});

const BatchCreateResultSchema = z.object({
  created: z
    .array(SlimCreatedCardSchema)
    .describe(
      "Successfully created cards (id + deck-id only — content was supplied by the caller and is not echoed back). These cards exist on Mochi — do NOT retry creating them, even if attachmentErrors references them."
    ),
  failed: z
    .array(
      z.object({
        index: z
          .number()
          .describe("Zero-based index in the input array that failed"),
        error: z.string().describe("Error message for the failed card"),
      })
    )
    .describe("Cards that failed to create. Safe to retry."),
  attachmentErrors: z
    .array(
      z.object({
        index: z
          .number()
          .describe("Zero-based index in the input array"),
        cardId: z
          .string()
          .describe("ID of the card that was created without its attachment"),
        filename: z.string().describe("Attachment filename that failed to upload"),
        error: z.string().describe("Error message for the failed attachment"),
      })
    )
    .describe(
      "Attachments that failed AFTER the card was already created. The card exists in `created` — retry only the attachment, do not recreate the card."
    ),
});
type BatchCreateResult = z.infer<typeof BatchCreateResultSchema>;

interface BatchAttemptResult {
  card: CreateCardResponse;
  attachmentErrors: { filename: string; error: string }[];
}

function collectBatchResults(
  settled: PromiseSettledResult<BatchAttemptResult>[]
): BatchCreateResult {
  const created: BatchCreateResult["created"] = [];
  const failed: { index: number; error: string }[] = [];
  const attachmentErrors: BatchCreateResult["attachmentErrors"] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      created.push({ id: r.value.card.id, "deck-id": r.value.card["deck-id"] });
      for (const ae of r.value.attachmentErrors) {
        attachmentErrors.push({
          index: i,
          cardId: r.value.card.id,
          filename: ae.filename,
          error: ae.error,
        });
      }
    } else {
      const err = r.reason;
      failed.push({
        index: i,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return { created, failed, attachmentErrors };
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        try {
          results[i] = { status: "fulfilled", value: await fn(items[i], i) };
        } catch (e) {
          results[i] = { status: "rejected", reason: e };
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}

const DeckSchema = z
  .object({
    id: z.string().describe("Unique identifier for the deck"),
    sort: z.number().describe("Sort order of the deck"),
    name: z.string().describe("Display name of the deck"),
    "template-id": z
      .string()
      .optional()
      .nullable()
      .describe("Template ID associated with this deck, if any"),
    "archived?": z
      .boolean()
      .optional()
      .nullable()
      .describe("Whether the deck is archived"),
    "trashed?": z
      .object({ date: z.string() })
      .optional()
      .nullable()
      .describe(
        "Timestamp when the deck was trashed, in ISO 8601 format (matching JavaScript's Date#toJSON)"
      ),
  })
  .strip();

const ListDecksResponseSchema = z
  .object({
    bookmark: z.string().describe("Pagination bookmark for fetching next page"),
    docs: z.array(DeckSchema).describe("Array of decks"),
  })
  .strip();

const DueCardSchema = z
  .object({
    id: z.string().describe("Unique identifier for the card"),
    content: z.string().describe("Markdown content of the card"),
    name: z.string().describe("Display name of the card"),
    "deck-id": z.string().describe("ID of the deck containing the card"),
    "new?": z
      .boolean()
      .optional()
      .describe("Whether the card is new (never reviewed)"),
  })
  .passthrough();

const GetDueCardsResponseSchema = z.object({
  cards: z.array(DueCardSchema).describe("Array of cards due for review"),
});

function getApiKey(): string {
  const apiKey = process.env.MOCHI_API_KEY;
  if (!apiKey) {
    throw new Error("MOCHI_API_KEY environment variable is not set");
  }
  return apiKey;
}

// ---- Search helpers ---------------------------------------------------------

/** Lowercase, collapse whitespace, strip punctuation that distorts trigrams. */
export function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_~#>\-]+/g, " ") // markdown punctuation that noises trigrams
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

const SearchFlashcardsParamsSchema = z.object({
  query: z.string().min(1).describe("Text to search for"),
  deckId: z
    .string()
    .optional()
    .describe("Restrict the scan to a single deck. Strongly recommended."),
  mode: z
    .enum(["substring", "fuzzy"])
    .optional()
    .default("substring")
    .describe(
      "substring: case-insensitive substring match (default). fuzzy: trigram Jaccard similarity — use for near-duplicate detection."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe("Max matches to return"),
  maxScanned: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .optional()
    .default(2000)
    .describe(
      "Hard cap on cards scanned. If reached, the response sets truncated:true."
    ),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.3)
    .describe(
      "Minimum Jaccard score (0-1) for a fuzzy match. Ignored in substring mode."
    ),
  contextChars: z
    .number()
    .int()
    .min(20)
    .max(500)
    .optional()
    .default(120)
    .describe("Approximate snippet length around the match (substring mode)."),
});

const SearchMatchSchema = z.object({
  id: z.string().describe("Card ID"),
  "deck-id": z.string().describe("ID of the deck containing the card"),
  snippet: z
    .string()
    .describe(
      "Whitespace-collapsed excerpt of the card content around the match (substring) or the start of the content (fuzzy)."
    ),
  score: z
    .number()
    .optional()
    .describe(
      "Similarity score (0-1). Present in fuzzy mode only; higher = more similar."
    ),
});

const SearchFlashcardsResponseSchema = z.object({
  matches: z.array(SearchMatchSchema),
  scanned: z.number().describe("Number of cards scanned"),
  truncated: z
    .boolean()
    .describe(
      "True if the scan hit maxScanned before finishing. Re-run with a higher maxScanned or scope by deckId to be exhaustive."
    ),
});

type SearchFlashcardsParams = z.infer<typeof SearchFlashcardsParamsSchema>;
type SearchFlashcardsResponse = z.infer<typeof SearchFlashcardsResponseSchema>;

export class MochiClient {
  private api: AxiosInstance;
  private token: string;

  /**
   * @param token   Mochi API token
   * @param apiOverride  Inject an AxiosInstance (used by tests). When
   *                     provided, no interceptor is attached — the caller
   *                     is expected to control responses directly.
   */
  constructor(token: string, apiOverride?: AxiosInstance) {
    this.token = token;
    if (apiOverride) {
      this.api = apiOverride;
      return;
    }
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

    // Add response interceptor for error handling
    this.api.interceptors.response.use(
      (response) => response,
      (error) => {
        if (axios.isAxiosError(error) && error.response) {
          const { status, data } = error.response;
          // Mochi API returns errors as arrays or objects
          if (data && (Array.isArray(data) || typeof data === "object")) {
            throw new MochiError(data, status);
          }
          // Fallback for string error messages
          if (typeof data === "string" && data.length > 0) {
            throw new MochiError([data], status);
          }
          // Generic error with status
          throw new MochiError(
            [`Request failed with status ${status}`],
            status
          );
        }
        // Re-throw non-axios errors
        throw error;
      }
    );
  }

  async createCard(request: CreateCardRequest): Promise<CreateCardResponse> {
    // Attachments are handled in createCards()/createCardsFromTemplate(),
    // not here, because they require a second request after the card is
    // created. Reject up front so a direct caller doesn't get silent drops.
    if (request.attachments && Object.keys(request.attachments).length > 0) {
      throw new MochiError(
        [
          "createCard does not upload attachments. Use createCards (batch) which handles attachments after creating each card.",
        ],
        400
      );
    }
    const mochiRequest = toMochiCreateCardRequest(request);
    const response = await this.api.post("/cards", mochiRequest);
    return CreateCardResponseSchema.parse(response.data);
  }

  async updateCard(
    cardId: string,
    request: UpdateCardRequest
  ): Promise<CreateCardResponse> {
    const mochiRequest = toMochiUpdateCardRequest(request);
    const response = await this.api.post(
      `/cards/${encodeURIComponent(cardId)}`,
      mochiRequest
    );
    return CreateCardResponseSchema.parse(response.data);
  }

  async listDecks(params?: ListDecksParams): Promise<ListDecksResponse> {
    const validatedParams = params
      ? ListDecksParamsSchema.parse(params)
      : undefined;
    const response = await this.api.get("/decks", { params: validatedParams });
    const parsed = ListDecksResponseSchema.parse(response.data);
    return {
      bookmark: parsed.bookmark,
      docs: parsed.docs
        .filter((deck) => !deck["archived?"] && !deck["trashed?"])
        .sort((a, b) => a.sort - b.sort),
    };
  }

  /**
   * Paginate through all decks, capped at `maxPages` to keep cost bounded.
   * Resources should expose the full list, not just page 1.
   */
  async listAllDecks(
    maxPages = MAX_RESOURCE_PAGES
  ): Promise<z.infer<typeof DeckSchema>[]> {
    const all: z.infer<typeof DeckSchema>[] = [];
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
    const validatedParams = params
      ? ListCardsParamsSchema.parse(params)
      : undefined;
    const mochiParams = validatedParams
      ? toMochiListCardsParams(validatedParams)
      : undefined;
    const response = await this.api.get("/cards", { params: mochiParams });
    const parsed = ListCardsResponseSchema.parse(response.data);

    return {
      bookmark: parsed.bookmark,
      docs: parsed.docs.filter((card) => !card["archived?"] && !card["trashed?"]),
    };
  }

  async searchCards(
    params: SearchFlashcardsParams
  ): Promise<SearchFlashcardsResponse> {
    const { query, deckId, mode, limit, maxScanned, threshold, contextChars } =
      SearchFlashcardsParamsSchema.parse(params);

    const queryTrigrams = mode === "fuzzy" ? trigrams(query) : null;
    const queryLower = mode === "substring" ? query.toLowerCase() : null;

    const matches: z.infer<typeof SearchMatchSchema>[] = [];
    let scanned = 0;
    let bookmark: string | undefined;
    let truncated = false;

    while (scanned < maxScanned) {
      const remainingScan = maxScanned - scanned;
      const page = await this.listCards({
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

  async listTemplates(
    params?: ListTemplatesParams
  ): Promise<ListTemplatesResponse> {
    const validatedParams = params
      ? ListTemplatesParamsSchema.parse(params)
      : undefined;
    // `verbose` is for our slimming logic, not a Mochi query param.
    const { verbose, ...mochiParams } = validatedParams ?? {};
    const response = await this.api.get("/templates", {
      params: Object.keys(mochiParams).length ? mochiParams : undefined,
    });
    const data = response.data;
    if (verbose) {
      return ListTemplatesResponseSchema.parse(data);
    }
    const slimDocs = (data?.docs ?? []).map((t: z.infer<typeof TemplateSchema>) => ({
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

  /**
   * Paginate through all templates (slim shape), capped at `maxPages`.
   */
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
  ): Promise<z.infer<typeof GetDueCardsResponseSchema>> {
    const validatedParams = params
      ? GetDueCardsParamsSchema.parse(params)
      : undefined;
    const deckId = validatedParams?.deckId;
    const endpoint = deckId ? `/due/${encodeURIComponent(deckId)}` : "/due";
    const queryParams = validatedParams?.date
      ? { date: validatedParams.date }
      : undefined;
    const response = await this.api.get(endpoint, { params: queryParams });
    return GetDueCardsResponseSchema.parse(response.data);
  }

  async getTemplate(
    templateId: string
  ): Promise<z.infer<typeof TemplateSchema>> {
    const response = await this.api.get(
      `/templates/${encodeURIComponent(templateId)}`
    );
    return TemplateSchema.parse(response.data);
  }

  async createCardFromTemplate(
    request: CreateCardFromTemplateParams,
    cachedTemplate?: z.infer<typeof TemplateSchema>
  ): Promise<CreateCardResponse> {
    const template = cachedTemplate ?? (await this.getTemplate(request.templateId));

    // Map field names to IDs
    const fieldNameToId: Record<string, string> = {};
    for (const [fieldId, field] of Object.entries(template.fields)) {
      fieldNameToId[field.name] = fieldId;
    }

    // Build the fields object with IDs
    const fields: Record<string, { id: string; value: string }> = {};
    const fieldValues: string[] = [];

    for (const [fieldName, value] of Object.entries(request.fields)) {
      const fieldId = fieldNameToId[fieldName];
      if (!fieldId) {
        throw new MochiError(
          [
            `Unknown field name: "${fieldName}". Available fields: ${Object.keys(
              fieldNameToId
            ).join(", ")}`,
          ],
          400
        );
      }
      fields[fieldId] = { id: fieldId, value };
      fieldValues.push(value);
    }

    // Build content from field values (joined with separator for multi-field templates)
    const content = fieldValues.join("\n---\n");

    // Refuse to create empty cards from broken templates / empty fields
    if (content.trim().length === 0) {
      throw new MochiError(
        [
          `Refusing to create empty card: all provided fields are blank. ` +
            `Template "${template.name}" expects fields: ${Object.values(
              template.fields
            )
              .map((f) => f.name)
              .join(", ")}.`,
        ],
        400
      );
    }

    const mochiRequest = {
      content,
      "deck-id": request.deckId,
      "template-id": request.templateId,
      "manual-tags": request.tags,
      fields,
    };

    const response = await this.api.post("/cards", mochiRequest);
    return CreateCardResponseSchema.parse(response.data);
  }

  async deleteCard(cardId: string): Promise<void> {
    await this.api.delete(`/cards/${encodeURIComponent(cardId)}`);
  }

  async createCards(requests: CreateCardRequest[]): Promise<BatchCreateResult> {
    const settled = await runWithConcurrency(requests, 3, async (req) => {
      // Strip attachments before createCard — the singular path refuses
      // them by design (it can't upload). The batch wrapper uploads
      // attachments itself after the card is created.
      const { attachments, ...cardReq } = req;
      const card = await this.createCard(cardReq);
      const attachmentErrors = await this.uploadAttachmentsBestEffort(
        card.id,
        attachments
      );
      return { card, attachmentErrors };
    });
    return collectBatchResults(settled);
  }

  async createCardsFromTemplate(
    requests: CreateCardFromTemplateParams[]
  ): Promise<BatchCreateResult> {
    // Fetch each unique template only once for the whole batch
    const uniqueTemplateIds = Array.from(
      new Set(requests.map((r) => r.templateId))
    );
    const templateCache = new Map<string, z.infer<typeof TemplateSchema>>();
    await Promise.all(
      uniqueTemplateIds.map(async (id) => {
        templateCache.set(id, await this.getTemplate(id));
      })
    );

    const settled = await runWithConcurrency(requests, 3, async (req) => {
      const card = await this.createCardFromTemplate(
        req,
        templateCache.get(req.templateId)
      );
      const attachmentErrors = await this.uploadAttachmentsBestEffort(
        card.id,
        req.attachments
      );
      return { card, attachmentErrors };
    });
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
    // Infer content-type from filename if not provided
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

    // Reject oversize attachments before allocating a Buffer.
    // Base64 inflates by ~4/3; 4/3 * 10MB ≈ 13.3M chars.
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

    // Convert base64 to Buffer
    const buffer = Buffer.from(request.data, "base64");

    // Create form data
    const formData = new FormData();
    formData.append("file", buffer, {
      filename: request.filename,
      contentType,
    });

    // Upload attachment
    await this.api.post(
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
    );

    return {
      filename: request.filename,
      markdown: `![](${request.filename})`,
    };
  }

  async updateCards(
    items: BatchUpdateItem[]
  ): Promise<BatchMutationResult> {
    const settled = await runWithConcurrency(items, 3, async (item) => {
      const { cardId, ...rest } = item;
      await this.updateCard(cardId, rest);
      return cardId;
    });
    return collectMutationResults(items, settled);
  }

  async archiveCards(
    items: BatchArchiveItem[]
  ): Promise<BatchMutationResult> {
    const settled = await runWithConcurrency(items, 3, async (item) => {
      await this.updateCard(item.cardId, { archived: item.archived });
      return item.cardId;
    });
    return collectMutationResults(items, settled);
  }

  async deleteCards(
    items: BatchDeleteItem[]
  ): Promise<BatchMutationResult> {
    const settled = await runWithConcurrency(items, 3, async (item) => {
      await this.deleteCard(item.cardId);
      return item.cardId;
    });
    return collectMutationResults(items, settled);
  }
}

const BatchMutationResultSchema = z.object({
  succeeded: z
    .array(z.object({ cardId: z.string() }))
    .describe("IDs of cards that were mutated successfully"),
  failed: z
    .array(
      z.object({
        index: z.number().describe("Zero-based index in the input array"),
        cardId: z.string().describe("ID of the card that failed"),
        error: z.string().describe("Error message"),
      })
    )
    .describe("Cards that failed to mutate"),
});
type BatchMutationResult = z.infer<typeof BatchMutationResultSchema>;

interface HasCardId {
  cardId: string;
}

function collectMutationResults(
  inputs: HasCardId[],
  settled: PromiseSettledResult<string>[]
): BatchMutationResult {
  const succeeded: { cardId: string }[] = [];
  const failed: BatchMutationResult["failed"] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      succeeded.push({ cardId: r.value });
    } else {
      const err = r.reason;
      failed.push({
        index: i,
        cardId: inputs[i].cardId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return { succeeded, failed };
}

// Server setup
const server = new McpServer({
  name: "mcp-server/mochi",
  version: "2.6.0",
});

// Schema for update flashcard tool (combines cardId with update fields)
const UpdateFlashcardToolSchema = z.object({
  cardId: z.string().describe("ID of the card to update"),
  content: z
    .string()
    .optional()
    .describe("Updated markdown content of the card"),
  deckId: z.string().optional().describe("ID of the deck to move the card to"),
  templateId: z.string().optional().describe("Template ID to use for the card"),
  fields: z
    .record(z.string(), CreateCardFieldSchema)
    .optional()
    .describe("Updated map of field IDs to field values"),
  trashed: z
    .boolean()
    .optional()
    .describe(
      "Set to true to soft-delete (move to trash). This can be undone by setting to false."
    ),
});

// Schema for delete flashcard tool
const DeleteFlashcardToolSchema = z.object({
  cardId: z
    .string()
    .describe("ID of the card to permanently delete. This cannot be undone."),
});

// Schema for archive flashcard tool
const ArchiveFlashcardToolSchema = z.object({
  cardId: z.string().describe("ID of the card to archive"),
  archived: z
    .boolean()
    .default(true)
    .describe("Set to true to archive, false to unarchive"),
});

// Batch mutation schemas
const UpdateFlashcardsRequestSchema = z.object({
  updates: z
    .array(UpdateFlashcardToolSchema)
    .min(1)
    .describe(
      "Array of update operations. Each item must include cardId plus the fields to change. Use trashed: true here to soft-delete in bulk."
    ),
});

const ArchiveFlashcardsRequestSchema = z.object({
  archives: z
    .array(ArchiveFlashcardToolSchema)
    .min(1)
    .describe(
      "Array of archive/unarchive operations. Each item must include cardId; archived defaults to true."
    ),
});

const DeleteFlashcardsRequestSchema = z.object({
  deletes: z
    .array(DeleteFlashcardToolSchema)
    .min(1)
    .describe(
      "Array of cards to permanently delete. Cannot be undone. Use update_flashcards with trashed: true for soft delete."
    ),
});

type BatchUpdateItem = z.infer<typeof UpdateFlashcardToolSchema>;
type BatchArchiveItem = z.infer<typeof ArchiveFlashcardToolSchema>;
type BatchDeleteItem = z.infer<typeof DeleteFlashcardToolSchema>;

// Create Mochi client lazily so importing this module for tests doesn't
// crash on a missing MOCHI_API_KEY.
let _mochiClient: MochiClient | null = null;
function getMochi(): MochiClient {
  if (!_mochiClient) _mochiClient = new MochiClient(getApiKey());
  return _mochiClient;
}

// Helper to format errors for tool responses
function formatToolError(error: unknown): {
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
        text: `Error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    ],
    isError: true,
  };
}

// Register tools
// Note: Using type assertions due to Zod version compatibility between SDK (v4) and project (v3)
server.registerTool(
  "create_flashcards",
  {
    title: "Create flashcards on Mochi",
    description:
      "Create one or more flashcards in a single call. Always pass an array, even for a single card. Get deckId from list_decks. To add images/audio: 1) Reference in content as ![](filename.png), 2) Add to attachments as { 'filename.png': 'base64data' }. Returns per-card results; partial success is supported.",
    inputSchema: CreateCardsRequestSchema,
    outputSchema: BatchCreateResultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args: z.infer<typeof CreateCardsRequestSchema>) => {
    try {
      const result = await getMochi().createCards(args.cards);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

server.registerTool(
  "create_cards_from_template",
  {
    title: "Create flashcards from template on Mochi",
    description:
      "Create one or more flashcards from a template in a single call. Always pass an array, even for a single card. Maps field names to IDs automatically. Returns per-card results; partial success is supported.",
    inputSchema: CreateCardsFromTemplateRequestSchema,
    outputSchema: BatchCreateResultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args: z.infer<typeof CreateCardsFromTemplateRequestSchema>) => {
    try {
      const result = await getMochi().createCardsFromTemplate(args.cards);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

server.registerTool(
  "update_flashcard",
  {
    title: "Update flashcard on Mochi",
    description:
      "Update an existing flashcard's content, deck, template, or fields. Use delete_flashcard to delete or archive_flashcard to archive.",
    inputSchema: UpdateFlashcardToolSchema,
    outputSchema: UpdateCardResponseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args: z.infer<typeof UpdateFlashcardToolSchema>) => {
    try {
      const { cardId, ...updateArgs } = args;
      const response = await getMochi().updateCard(cardId, updateArgs);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

// Output schema for delete response
const DeleteFlashcardResponseSchema = z
  .object({
    success: z.boolean().describe("Whether the deletion was successful"),
    cardId: z.string().describe("ID of the deleted card"),
  })
  .strict();

server.registerTool(
  "delete_flashcard",
  {
    title: "Delete flashcard on Mochi",
    description:
      "Permanently delete a flashcard and its attachments. WARNING: This cannot be undone. For soft deletion, use update_flashcard with trashed: true.",
    inputSchema: DeleteFlashcardToolSchema,
    outputSchema: DeleteFlashcardResponseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (args: z.infer<typeof DeleteFlashcardToolSchema>) => {
    try {
      await getMochi().deleteCard(args.cardId);
      const response = { success: true, cardId: args.cardId };
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

server.registerTool(
  "archive_flashcard",
  {
    title: "Archive flashcard on Mochi",
    description:
      "Archive or unarchive a flashcard. Archived cards are hidden from review but not deleted.",
    inputSchema: ArchiveFlashcardToolSchema,
    outputSchema: UpdateCardResponseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (args: z.infer<typeof ArchiveFlashcardToolSchema>) => {
    try {
      const response = await getMochi().updateCard(args.cardId, {
        archived: args.archived,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

server.registerTool(
  "update_flashcards",
  {
    title: "Update flashcards on Mochi (batch)",
    description:
      "Update one or more flashcards in a single call. Pass an array even for one card. Use trashed: true to soft-delete in bulk, or set deckId to move cards between decks. Returns per-card results; partial success is supported.",
    inputSchema: UpdateFlashcardsRequestSchema,
    outputSchema: BatchMutationResultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args: z.infer<typeof UpdateFlashcardsRequestSchema>) => {
    try {
      const result = await getMochi().updateCards(args.updates);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

server.registerTool(
  "archive_flashcards",
  {
    title: "Archive flashcards on Mochi (batch)",
    description:
      "Archive or unarchive one or more flashcards in a single call. Pass an array even for one card. Returns per-card results; partial success is supported.",
    inputSchema: ArchiveFlashcardsRequestSchema,
    outputSchema: BatchMutationResultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (args: z.infer<typeof ArchiveFlashcardsRequestSchema>) => {
    try {
      const result = await getMochi().archiveCards(args.archives);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

server.registerTool(
  "delete_flashcards",
  {
    title: "Delete flashcards on Mochi (batch)",
    description:
      "Permanently delete one or more flashcards. WARNING: cannot be undone. For soft delete, use update_flashcards with trashed: true. Returns per-card results; partial success is supported.",
    inputSchema: DeleteFlashcardsRequestSchema,
    outputSchema: BatchMutationResultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (args: z.infer<typeof DeleteFlashcardsRequestSchema>) => {
    try {
      const result = await getMochi().deleteCards(args.deletes);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

server.registerTool(
  "list_flashcards",
  {
    title: "List flashcards on Mochi",
    description:
      "List flashcards, optionally filtered by deck. Returns paginated results.",
    inputSchema: ListCardsParamsSchema.shape,
    outputSchema: ListCardsResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    try {
      const response = await getMochi().listCards(args);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

server.registerTool(
  "search_flashcards",
  {
    title: "Search flashcards on Mochi",
    description:
      "Find cards by content. Two modes: substring (case-insensitive default, cheap) and fuzzy (trigram Jaccard, for near-duplicate detection). Pass deckId to scope the scan — strongly recommended. Bounded by maxScanned; check `truncated` in the response.",
    inputSchema: SearchFlashcardsParamsSchema.shape,
    outputSchema: SearchFlashcardsResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args: z.infer<typeof SearchFlashcardsParamsSchema>) => {
    try {
      const response = await getMochi().searchCards(args);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

server.registerTool(
  "list_decks",
  {
    title: "List decks on Mochi",
    description: "List all decks. Use to get deckId for other operations.",
    inputSchema: ListDecksParamsSchema.shape,
    outputSchema: ListDecksResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    try {
      const response = await getMochi().listDecks(args);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

server.registerTool(
  "list_templates",
  {
    title: "List templates on Mochi",
    description:
      "List all templates. Use with create_card_from_template for easy template-based card creation.",
    inputSchema: ListTemplatesParamsSchema.shape,
    outputSchema: ListTemplatesResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    try {
      const response = await getMochi().listTemplates(args);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

server.registerTool(
  "get_template",
  {
    title: "Get template by ID on Mochi",
    description:
      "Get a single template by its ID. Use to see template fields and structure.",
    inputSchema: GetTemplateParamsSchema.shape,
    outputSchema: TemplateSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args: z.infer<typeof GetTemplateParamsSchema>) => {
    try {
      const response = await getMochi().getTemplate(args.templateId);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

server.registerTool(
  "get_due_cards",
  {
    title: "Get due flashcards on Mochi",
    description:
      "Get flashcards due for review on a specific date (defaults to today).",
    inputSchema: GetDueCardsParamsSchema.shape,
    outputSchema: GetDueCardsResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    try {
      const response = await getMochi().getDueCards(args);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        structuredContent: response,
      };
    } catch (error) {
      return formatToolError(error);
    }
  }
);

// Register resources
server.registerResource(
  "decks",
  "mochi://decks",
  {
    description: "List of all decks in Mochi.",
    mimeType: "application/json",
  },
  async () => {
    const decks = await getMochi().listAllDecks();
    return {
      contents: [
        {
          uri: "mochi://decks",
          mimeType: "application/json",
          text: JSON.stringify(
            decks.map((deck) => ({ id: deck.id, name: deck.name })),
            null,
            2
          ),
        },
      ],
    };
  }
);

server.registerResource(
  "templates",
  "mochi://templates",
  {
    description: "List of all templates in Mochi.",
    mimeType: "application/json",
  },
  async () => {
    const templates = await getMochi().listAllTemplates();
    return {
      contents: [
        {
          uri: "mochi://templates",
          mimeType: "application/json",
          text: JSON.stringify({ docs: templates }, null, 2),
        },
      ],
    };
  }
);

// Register prompts
server.registerPrompt(
  "write-flashcard",
  {
    description: "Write a flashcard based on user-provided information.",
    argsSchema: {
      input: z
        .string()
        .describe("The information to base the flashcard on.")
        .optional(),
    },
  },
  async ({ input }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Create a flashcard using the info below while adhering to these principles:
- Keep questions and answers atomic.
- Utilize cloze prompts when applicable, like "This is a text with {{hidden}} part. Then don't use '---' separator.".
- Focus on effective retrieval practice by being concise and clear.
- Make it just challenging enough to reinforce specific facts.
- Only use create_card_from_template if the deck has a template-id defined. Otherwise use create_flashcard.
Input: ${input}
`,
        },
      },
    ],
  })
);

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only auto-start when this file is the process entry point. Importing
// it from tests must not connect to stdio or exit on missing env.
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
