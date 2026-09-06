import { z } from "zod";

export const CreateCardFieldSchema = z.object({
  id: z.string().describe("Unique identifier for the field"),
  value: z.string().describe("Value of the field"),
});

export const CreateCardRequestSchema = z.object({
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

export const UpdateCardRequestSchema = z.object({
  content: z.string().optional().describe("Updated markdown content of the card"),
  deckId: z.string().optional().describe("ID of the deck to move the card to"),
  templateId: z.string().optional().describe("Template ID to use for the card"),
  archived: z.boolean().optional().describe("Whether the card is archived"),
  trashed: z.boolean().optional().describe("Whether the card is trashed"),
  fields: z
    .record(z.string(), CreateCardFieldSchema)
    .optional()
    .describe("Updated map of field IDs to field values"),
});

export const CreateDeckRequestSchema = z.object({
  name: z.string().min(1).describe("Display name of the deck"),
  parentId: z
    .string()
    .optional()
    .describe(
      "Optional ID of a parent deck to nest this deck under as a subdeck. Omit to create a top-level deck."
    ),
});

export const UpdateDeckRequestSchema = z.object({
  name: z.string().min(1).optional().describe("New display name for the deck"),
  parentId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "New parent deck ID to re-home this deck under as a subdeck. Pass null to move it to the top level."
    ),
  trashed: z
    .boolean()
    .optional()
    .describe("Set true to soft-delete (trash) the deck, false to restore it."),
});

export const ListDecksParamsSchema = z.object({
  bookmark: z
    .string()
    .optional()
    .describe("Pagination bookmark for fetching next page of results"),
  deckId: z
    .string()
    .optional()
    .describe(
      "Scope results to a single deck. Without includeSubdecks, returns just that deck. With includeSubdecks: true, returns the deck plus its full nested subtree. When set, results are not paginated (bookmark is empty)."
    ),
  includeSubdecks: z
    .boolean()
    .optional()
    .describe(
      "When deckId is set, also return all descendant subdecks (the full subtree, any depth). Ignored when deckId is not set."
    ),
});

export const ListCardsParamsSchema = z.object({
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
  includeSubdecks: z
    .boolean()
    .optional()
    .describe(
      "When true (requires deckId), also return cards from every descendant subdeck, grouped together. Results are aggregated (not paginated) and bounded by a cap - check `truncated` in the response. Plain deckId without this flag returns only cards directly in that deck."
    ),
});

export const ListFlashcardsToolSchema = z.object({
  deckId: z
    .string()
    .optional()
    .describe("Scope results to a single deck. Omit to list every card."),
  includeSubdecks: ListCardsParamsSchema.shape.includeSubdecks,
});

export const ListTemplatesParamsSchema = z.object({
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

export const GetTemplateParamsSchema = z.object({
  templateId: z.string().min(1).describe("ID of the template to fetch"),
});

export const GetDueCardsParamsSchema = z.object({
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

export const CreateCardFromTemplateSchema = z.object({
  templateId: z
    .string()
    .min(1)
    .describe("ID of the template to use. Get this from list_templates."),
  deckId: z
    .string()
    .min(1)
    .describe("ID of the deck to create the card in. Get this from list_decks."),
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

export const CreateCardsRequestSchema = z.object({
  cards: z
    .array(CreateCardRequestSchema)
    .min(1)
    .describe("Array of cards to create. Pass an array even for a single card."),
});

export const CreateCardsFromTemplateRequestSchema = z.object({
  cards: z
    .array(CreateCardFromTemplateSchema)
    .min(1)
    .describe(
      "Array of template-based cards to create. Pass an array even for a single card."
    ),
});

export const TemplateFieldSchema = z.object({
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

export const TemplateSchema = z
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

export const SlimTemplateFieldSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const SlimTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  pos: z.string(),
  fields: z.array(SlimTemplateFieldSchema),
});

export const ListTemplatesResponseSchema = z
  .object({
    bookmark: z.string().describe("Pagination bookmark for fetching next page"),
    docs: z
      .array(z.union([TemplateSchema, SlimTemplateSchema]))
      .describe(
        "Array of templates. Slim by default (id, name, pos, field id+name). Pass verbose:true to get full template content and field details."
      ),
  })
  .strip();

export const CardSchema = z
  .object({
    id: z.string().describe("Unique identifier for the card"),
    tags: z.array(z.string()).describe("Array of tags associated with the card"),
    content: z
      .string()
      .nullable()
      .describe(
        'Markdown content of the card. Separate the question and answer with "---". Can be null for a degraded/broken card - tolerated so one bad card does not fail the whole page.'
      ),
    name: z.string().describe("Display name of the card"),
    "deck-id": z.string().describe("ID of the deck containing the card"),
    "template-id": z
      .string()
      .optional()
      .nullable()
      .describe("ID of the template this card uses, if any"),
    "archived?": z.boolean().optional().nullable(),
    "trashed?": z.object({ date: z.string() }).optional().nullable(),
    fields: z
      .record(z.string(), z.unknown())
      .optional()
      .nullable()
      .describe(
        "Map of field IDs to field values. Need to match the field IDs in the template. Mochi can return null for a degraded/broken card - tolerated here so one bad card doesn't fail the whole page."
      ),
  })
  .strip();

export const CreateCardResponseSchema = CardSchema.strip();
export const UpdateCardResponseSchema = CardSchema.strip();

export const ListCardsResponseSchema = z
  .object({
    bookmark: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Always null from list_flashcards - results are fully auto-paginated, so there is no next page to fetch."
      ),
    docs: z.array(CardSchema).describe("Array of cards"),
    truncated: z
      .boolean()
      .optional()
      .describe(
        "True when the card cap was reached and the result is incomplete (some cards omitted). Applies to both the default list and subdeck-cascade queries (includeSubdecks: true)."
      ),
    malformed: z
      .array(
        z.object({
          id: z
            .string()
            .describe("Best-effort ID of the card that failed to parse"),
          error: z.string().describe("Why the card failed schema validation"),
        })
      )
      .optional()
      .describe(
        "Cards Mochi returned that failed schema validation and were set aside so the rest of the page could still load. Omitted from docs; repair them (re-save in Mochi, or update_flashcard) to make them listable. Absent when every card parsed."
      ),
  })
  .strip();

export const CardsPageEnvelopeSchema = z
  .object({
    bookmark: z.string().nullable().optional(),
    docs: z.array(z.unknown()),
  })
  .strip();

export const SlimCreatedCardSchema = z.object({
  id: z.string().describe("Mochi card ID"),
  "deck-id": z.string().describe("ID of the deck the card was created in"),
});

export const BatchCreateResultSchema = z.object({
  created: z
    .array(SlimCreatedCardSchema)
    .describe(
      "Successfully created cards (id + deck-id only - content was supplied by the caller and is not echoed back). These cards exist on Mochi - do NOT retry creating them, even if attachmentErrors references them."
    ),
  failed: z
    .array(
      z.object({
        index: z.number().describe("Zero-based index in the input array that failed"),
        error: z.string().describe("Error message for the failed card"),
      })
    )
    .describe("Cards that failed to create. Safe to retry."),
  attachmentErrors: z
    .array(
      z.object({
        index: z.number().describe("Zero-based index in the input array"),
        cardId: z
          .string()
          .describe("ID of the card that was created without its attachment"),
        filename: z.string().describe("Attachment filename that failed to upload"),
        error: z.string().describe("Error message for the failed attachment"),
      })
    )
    .describe(
      "Attachments that failed AFTER the card was already created. The card exists in `created` - retry only the attachment, do not recreate the card."
    ),
});

export const DeckSchema = z
  .object({
    id: z.string().describe("Unique identifier for the deck"),
    sort: z.number().describe("Sort order of the deck"),
    name: z.string().describe("Display name of the deck"),
    "parent-id": z
      .string()
      .optional()
      .nullable()
      .describe(
        "ID of the parent deck this deck is nested under, if any. null/absent means it is a top-level deck. Use this to reconstruct the deck hierarchy."
      ),
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

export const ListDecksResponseSchema = z
  .object({
    bookmark: z.string().describe("Pagination bookmark for fetching next page"),
    docs: z.array(DeckSchema).describe("Array of decks"),
  })
  .strip();

export const DueCardSchema = z
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

export const GetDueCardsResponseSchema = z.object({
  cards: z.array(DueCardSchema).describe("Array of cards due for review"),
});

export const SearchFlashcardsParamsSchema = z.object({
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
      "substring: case-insensitive substring match (default). fuzzy: trigram Jaccard similarity - use for near-duplicate detection."
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

export const SearchMatchSchema = z.object({
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

export const SearchFlashcardsResponseSchema = z.object({
  matches: z.array(SearchMatchSchema),
  scanned: z.number().describe("Number of cards scanned"),
  truncated: z
    .boolean()
    .describe(
      "True if the scan hit maxScanned before finishing. Re-run with a higher maxScanned or scope by deckId to be exhaustive."
    ),
});

export const BatchMutationResultSchema = z.object({
  succeeded: z
    .number()
    .int()
    .describe(
      "Count of cards mutated successfully. The caller supplied the ids, so success is just a tally - only failures are itemized."
    ),
  failed: z
    .array(
      z.object({
        index: z.number().describe("Zero-based index in the input array"),
        cardId: z.string().describe("ID of the card that failed"),
        error: z.string().describe("Error message"),
      })
    )
    .describe("Cards that failed to mutate. Empty when everything succeeded."),
});

export const UpdateFlashcardToolSchema = z.object({
  cardId: z.string().describe("ID of the card to update"),
  content: z.string().optional().describe("Updated markdown content of the card"),
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

export const UpdateFlashcardResponseSchema = z
  .object({
    id: z.string().describe("ID of the updated card"),
    content: z
      .string()
      .optional()
      .nullable()
      .describe("Stored content - present only when content was updated"),
    "deck-id": z
      .string()
      .optional()
      .describe("Current deck - present only when deckId was updated"),
    "template-id": z
      .string()
      .nullable()
      .optional()
      .describe("Current template - present only when templateId was updated"),
    fields: z
      .record(z.string(), z.unknown())
      .optional()
      .nullable()
      .describe("Stored fields - present only when fields were updated"),
    trashed: z
      .boolean()
      .optional()
      .describe(
        "Current trashed state - present only when trashed was updated (true if the card is now trashed)"
      ),
  })
  .strip();

export const UpdateDeckToolSchema = z.object({
  deckId: z.string().describe("ID of the deck to update"),
  name: z.string().min(1).optional().describe("New display name for the deck"),
  parentId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "New parent deck ID to re-home this deck under as a subdeck. Pass null to move it to the top level."
    ),
  trashed: z
    .boolean()
    .optional()
    .describe("Set true to soft-delete (move the deck to trash), false to restore."),
});

export const DeleteFlashcardToolSchema = z.object({
  cardId: z
    .string()
    .describe("ID of the card to permanently delete. This cannot be undone."),
});

export const ArchiveFlashcardToolSchema = z.object({
  cardId: z.string().describe("ID of the card to archive"),
  archived: z
    .boolean()
    .default(true)
    .describe("Set to true to archive, false to unarchive"),
});

export const UpdateFlashcardsRequestSchema = z.object({
  updates: z
    .array(UpdateFlashcardToolSchema)
    .min(1)
    .describe(
      "Array of update operations. Each item must include cardId plus the fields to change. Use trashed: true here to soft-delete in bulk."
    ),
});

export const UpdateFlashcardsBulkToolSchema = z.object({
  cardIds: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "IDs of the cards to apply the same change to. Get these from list_flashcards or search_flashcards. Duplicates are collapsed."
    ),
  deckId: z.string().optional().describe("Move every listed card into this deck."),
  templateId: z
    .string()
    .optional()
    .describe("Set every listed card to use this template."),
  trashed: z
    .boolean()
    .optional()
    .describe(
      "Set true to soft-delete every listed card (move to trash), false to restore them."
    ),
});

export const ArchiveFlashcardsRequestSchema = z.object({
  archives: z
    .array(ArchiveFlashcardToolSchema)
    .min(1)
    .describe(
      "Array of archive/unarchive operations. Each item must include cardId; archived defaults to true."
    ),
});

export const DeleteFlashcardsRequestSchema = z.object({
  deletes: z
    .array(DeleteFlashcardToolSchema)
    .min(1)
    .describe(
      "Array of cards to permanently delete. Cannot be undone. Use update_flashcards with trashed: true for soft delete."
    ),
});

export const DeleteFlashcardResponseSchema = z
  .object({
    success: z.boolean().describe("Whether the deletion was successful"),
    cardId: z.string().describe("ID of the deleted card"),
  })
  .strict();

export type ListTemplatesParams = z.infer<typeof ListTemplatesParamsSchema>;
export type ListTemplatesResponse = z.infer<typeof ListTemplatesResponseSchema>;
export type ListCardsParams = z.infer<typeof ListCardsParamsSchema>;
export type ListDecksParams = z.infer<typeof ListDecksParamsSchema>;
export type CreateCardRequest = z.infer<typeof CreateCardRequestSchema>;
export type UpdateCardRequest = z.infer<typeof UpdateCardRequestSchema>;
export type CreateDeckRequest = z.infer<typeof CreateDeckRequestSchema>;
export type UpdateDeckRequest = z.infer<typeof UpdateDeckRequestSchema>;
export type GetDueCardsParams = z.infer<typeof GetDueCardsParamsSchema>;
export type CreateCardFromTemplateParams = z.infer<
  typeof CreateCardFromTemplateSchema
>;
export type CreateCardResponse = z.infer<typeof CreateCardResponseSchema>;
export type ListDecksResponse = z.infer<typeof ListDecksResponseSchema>;
export type ListCardsResponse = z.infer<typeof ListCardsResponseSchema>;
export type BatchCreateResult = z.infer<typeof BatchCreateResultSchema>;
export type SearchFlashcardsParams = z.infer<
  typeof SearchFlashcardsParamsSchema
>;
export type SearchFlashcardsResponse = z.infer<
  typeof SearchFlashcardsResponseSchema
>;
export type SearchMatch = z.infer<typeof SearchMatchSchema>;
export type GetDueCardsResponse = z.infer<typeof GetDueCardsResponseSchema>;
export type UpdateFlashcardResponse = z.infer<
  typeof UpdateFlashcardResponseSchema
>;
export type BatchMutationResult = z.infer<typeof BatchMutationResultSchema>;
export type BatchUpdateItem = z.infer<typeof UpdateFlashcardToolSchema>;
export type BatchArchiveItem = z.infer<typeof ArchiveFlashcardToolSchema>;
export type BatchDeleteItem = z.infer<typeof DeleteFlashcardToolSchema>;
export type Deck = z.infer<typeof DeckSchema>;
export type Template = z.infer<typeof TemplateSchema>;
export type CardMalformedEntry = { id: string; error: string };

/** Best-effort id for a card that failed full validation. */
export function extractCardId(raw: unknown): string {
  const parsed = z.object({ id: z.string() }).safeParse(raw);
  return parsed.success ? parsed.data.id : "(unknown id)";
}

/** Flatten Zod issues into a compact "path: message; ..." string. */
export function summarizeCardError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
