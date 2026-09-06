import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getApiKey } from "./config.js";
import { MochiClient, pickChangedFields } from "./mochi-client.js";
import {
  ArchiveFlashcardToolSchema,
  ArchiveFlashcardsRequestSchema,
  BatchCreateResultSchema,
  BatchMutationResultSchema,
  CreateCardsFromTemplateRequestSchema,
  CreateCardsRequestSchema,
  CreateDeckRequestSchema,
  DeckSchema,
  DeleteFlashcardResponseSchema,
  DeleteFlashcardToolSchema,
  DeleteFlashcardsRequestSchema,
  GetDueCardsResponseSchema,
  GetDueCardsParamsSchema,
  GetTemplateParamsSchema,
  ListCardsResponseSchema,
  ListDecksParamsSchema,
  ListDecksResponseSchema,
  ListFlashcardsToolSchema,
  ListTemplatesParamsSchema,
  ListTemplatesResponseSchema,
  SearchFlashcardsParamsSchema,
  SearchFlashcardsResponseSchema,
  TemplateSchema,
  UpdateCardResponseSchema,
  UpdateDeckToolSchema,
  UpdateFlashcardResponseSchema,
  UpdateFlashcardToolSchema,
  UpdateFlashcardsBulkToolSchema,
  UpdateFlashcardsRequestSchema,
} from "./schemas.js";
import { formatToolError, jsonToolResponse } from "./tool-response.js";

export const MOCHI_TOOL_NAMES = [
  "create_flashcards",
  "create_cards_from_template",
  "update_flashcard",
  "delete_flashcard",
  "archive_flashcard",
  "update_flashcards",
  "update_flashcards_bulk",
  "archive_flashcards",
  "delete_flashcards",
  "list_flashcards",
  "search_flashcards",
  "list_decks",
  "create_deck",
  "update_deck",
  "list_templates",
  "get_template",
  "get_due_cards",
] as const;

export const MOCHI_RESOURCE_URIS = ["mochi://decks", "mochi://templates"] as const;
export const MOCHI_PROMPT_NAMES = ["write-flashcard"] as const;

let defaultMochiClient: MochiClient | null = null;

export function getDefaultMochiClient(): MochiClient {
  if (!defaultMochiClient) defaultMochiClient = new MochiClient(getApiKey());
  return defaultMochiClient;
}

export function resetDefaultMochiClientForTests(): void {
  defaultMochiClient = null;
}

export interface MochiServerOptions {
  getClient?: () => MochiClient;
}

async function handleJson<T>(fn: () => Promise<T>) {
  try {
    return jsonToolResponse(await fn());
  } catch (error) {
    return formatToolError(error);
  }
}

export function createMochiServer(options: MochiServerOptions = {}): McpServer {
  const getMochi = options.getClient ?? getDefaultMochiClient;
  const server = new McpServer({
    name: "mcp-server/mochi",
    version: "2.8.0",
  });

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
    async (args: z.infer<typeof CreateCardsRequestSchema>) =>
      handleJson(() => getMochi().createCards(args.cards))
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
    async (args: z.infer<typeof CreateCardsFromTemplateRequestSchema>) =>
      handleJson(() => getMochi().createCardsFromTemplate(args.cards))
  );

  server.registerTool(
    "update_flashcard",
    {
      title: "Update flashcard on Mochi",
      description:
        "Update an existing flashcard's content, deck, template, or fields. Returns the card id plus only the fields you changed (read back from Mochi) to confirm the write - not the whole card. Use delete_flashcard to delete or archive_flashcard to archive.",
      inputSchema: UpdateFlashcardToolSchema,
      outputSchema: UpdateFlashcardResponseSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof UpdateFlashcardToolSchema>) =>
      handleJson(async () => {
        const { cardId, ...updateArgs } = args;
        const card = await getMochi().updateCard(cardId, updateArgs);
        return pickChangedFields(updateArgs, card);
      })
  );

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
    async (args: z.infer<typeof DeleteFlashcardToolSchema>) =>
      handleJson(async () => {
        await getMochi().deleteCard(args.cardId);
        return { success: true, cardId: args.cardId };
      })
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
    async (args: z.infer<typeof ArchiveFlashcardToolSchema>) =>
      handleJson(() =>
        getMochi().updateCard(args.cardId, {
          archived: args.archived,
        })
      )
  );

  server.registerTool(
    "update_flashcards",
    {
      title: "Update flashcards on Mochi (batch)",
      description:
        "Update one or more flashcards, each with its own change (e.g. unique content per card). Pass an array even for one card. When the SAME change applies to every card (move/trash/re-template), prefer update_flashcards_bulk - it sends the change once instead of repeating it per card. Returns a success count plus itemized failures; partial success is supported.",
      inputSchema: UpdateFlashcardsRequestSchema,
      outputSchema: BatchMutationResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof UpdateFlashcardsRequestSchema>) =>
      handleJson(() => getMochi().updateCards(args.updates))
  );

  server.registerTool(
    "update_flashcards_bulk",
    {
      title: "Bulk-update flashcards on Mochi (one change, many cards)",
      description:
        "Apply ONE identical change to many cards at once: move them to a deck (deckId), re-template them (templateId), or soft-delete/restore them (trashed). Send the change once plus a list of cardIds - far cheaper than update_flashcards when the change is uniform. For different changes per card, use update_flashcards instead. Returns a success count plus itemized failures.",
      inputSchema: UpdateFlashcardsBulkToolSchema,
      outputSchema: BatchMutationResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof UpdateFlashcardsBulkToolSchema>) =>
      handleJson(() => {
        const { cardIds, ...patch } = args;
        return getMochi().updateCardsBulk(cardIds, patch);
      })
  );

  server.registerTool(
    "archive_flashcards",
    {
      title: "Archive flashcards on Mochi (batch)",
      description:
        "Archive or unarchive one or more flashcards in a single call. Pass an array even for one card. Returns a success count plus itemized failures; partial success is supported.",
      inputSchema: ArchiveFlashcardsRequestSchema,
      outputSchema: BatchMutationResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof ArchiveFlashcardsRequestSchema>) =>
      handleJson(() => getMochi().archiveCards(args.archives))
  );

  server.registerTool(
    "delete_flashcards",
    {
      title: "Delete flashcards on Mochi (batch)",
      description:
        "Permanently delete one or more flashcards. WARNING: cannot be undone. For soft delete, use update_flashcards with trashed: true. Returns a success count plus itemized failures; partial success is supported.",
      inputSchema: DeleteFlashcardsRequestSchema,
      outputSchema: BatchMutationResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof DeleteFlashcardsRequestSchema>) =>
      handleJson(() => getMochi().deleteCards(args.deletes))
  );

  server.registerTool(
    "list_flashcards",
    {
      title: "List flashcards on Mochi",
      description:
        "List flashcards, optionally filtered by deck. Returns the complete set of cards - results are auto-paginated for you, so there are no bookmarks to follow. The result is bounded by a safety cap: check `truncated` in the response (true means the cap was hit and some cards are omitted). Pass deckId alone for cards directly in that deck; add includeSubdecks: true to also pull cards from every nested subdeck. Any card Mochi returns that fails validation is set aside in `malformed` (with its id) instead of failing the whole call - repair those to make them listable.",
      inputSchema: ListFlashcardsToolSchema.shape,
      outputSchema: ListCardsResponseSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => handleJson(() => getMochi().listCards(args))
  );

  server.registerTool(
    "search_flashcards",
    {
      title: "Search flashcards on Mochi",
      description:
        "Find cards by content. Two modes: substring (case-insensitive default, cheap) and fuzzy (trigram Jaccard, for near-duplicate detection). Pass deckId to scope the scan - strongly recommended. Bounded by maxScanned; check `truncated` in the response.",
      inputSchema: SearchFlashcardsParamsSchema.shape,
      outputSchema: SearchFlashcardsResponseSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: z.infer<typeof SearchFlashcardsParamsSchema>) =>
      handleJson(() => getMochi().searchCards(args))
  );

  server.registerTool(
    "list_decks",
    {
      title: "List decks on Mochi",
      description:
        "List decks. Each deck carries `parent-id`, so you can reconstruct the hierarchy. No args returns all decks (paginated). Pass deckId to scope to one deck; add includeSubdecks: true to return that deck plus its full nested subtree - the way to enumerate a deck's subdecks.",
      inputSchema: ListDecksParamsSchema.shape,
      outputSchema: ListDecksResponseSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => handleJson(() => getMochi().listDecks(args))
  );

  server.registerTool(
    "create_deck",
    {
      title: "Create deck on Mochi",
      description:
        "Create a new deck. Pass parentId to nest it under an existing deck as a subdeck; omit parentId for a top-level deck. Useful during an audit to add a missing subdeck before moving cards into it.",
      inputSchema: CreateDeckRequestSchema.shape,
      outputSchema: DeckSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof CreateDeckRequestSchema>) =>
      handleJson(() => getMochi().createDeck(args))
  );

  server.registerTool(
    "update_deck",
    {
      title: "Update deck on Mochi",
      description:
        "Update a deck's name, parent, or trashed state. Set parentId to re-home a deck under a new parent (or null to move it to the top level) - the cheapest way to fix a mis-nested or stray subdeck. Use trashed: true to soft-delete.",
      inputSchema: UpdateDeckToolSchema.shape,
      outputSchema: DeckSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof UpdateDeckToolSchema>) =>
      handleJson(() => {
        const { deckId, ...updateArgs } = args;
        return getMochi().updateDeck(deckId, updateArgs);
      })
  );

  server.registerTool(
    "list_templates",
    {
      title: "List templates on Mochi",
      description:
        "List all templates. Use with create_cards_from_template for easy template-based card creation.",
      inputSchema: ListTemplatesParamsSchema.shape,
      outputSchema: ListTemplatesResponseSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => handleJson(() => getMochi().listTemplates(args))
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
    async (args: z.infer<typeof GetTemplateParamsSchema>) =>
      handleJson(() => getMochi().getTemplate(args.templateId))
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
    async (args) => handleJson(() => getMochi().getDueCards(args))
  );

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
              decks.map((deck) => ({
                id: deck.id,
                name: deck.name,
                "parent-id": deck["parent-id"] ?? null,
              })),
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
- Only use create_cards_from_template if the deck has a template-id defined. Otherwise use create_flashcards.
Input: ${input}
`,
          },
        },
      ],
    })
  );

  return server;
}
