# Mochi MCP Server

MCP server for [Mochi](https://mochi.cards) flashcard integration, allowing you to manage your flashcards through the Model Context Protocol.

## Features

- Create, update, and delete flashcards
- Create cards from templates with automatic field name-to-ID mapping
- Add attachments (images, audio) while creating cards
- Get cards due for review
- List flashcards, decks, and templates

## Usage with Claude Desktop

Add the following to your `claude_desktop_config.json`:

### NPX (recommended)

```json
{
  "mcpServers": {
    "mochi": {
      "command": "npx",
      "args": ["-y", "@jadelapuente/mcp-mochi"],
      "env": {
        "MOCHI_API_KEY": "<YOUR_TOKEN>"
      }
    }
  }
}
```

### Local Development

```json
{
  "mcpServers": {
    "mochi": {
      "command": "node",
      "args": ["/path/to/mcp-mochi/dist/index.js"],
      "env": {
        "MOCHI_API_KEY": "<YOUR_TOKEN>"
      }
    }
  }
}
```

## Local Development Setup

1. Clone and install dependencies:
   ```bash
   git clone https://github.com/jadelapuente/mcp-mochi.git
   cd mcp-mochi
   npm install
   ```

2. Build the project:
   ```bash
   npm run build
   ```

3. Test with MCP Inspector:
   ```bash
   MOCHI_API_KEY=<YOUR_TOKEN> npx @modelcontextprotocol/inspector node dist/index.js
   ```

## Rate limits and multi-agent use

The [Mochi API](https://mochi.cards/docs/api/) allows **one in-flight request per account**. This server enforces that in three layers:

1. **In-process queue** — all HTTP calls in a single MCP process are serialized.
2. **File lock** — multiple MCP processes on the **same machine** sharing one `MOCHI_API_KEY` coordinate via a lock file under `~/.cache/mcp-mochi/locks/` (or `$XDG_CACHE_HOME`). Different API keys do not block each other.
3. **Retry with backoff** — rate limits (`429`) and service unavailability (`503`) are retried for all requests. Read-only requests also retry transient transport/server failures such as `408`, `425`, `500`, `502`, `504`, connection resets, timeouts, and temporary DNS failures. Retry-After headers are honored when Mochi sends them.

Mutating requests do **not** broadly retry ambiguous network failures. For example, if card creation times out after Mochi already created the card, retrying could create a duplicate.

Set `MOCHI_DISABLE_ACCOUNT_LOCK=1` to skip the cross-process file lock (useful for tests or debugging). The in-process queue always applies when using a real API client.

Large batch operations (create/update many cards) run **serially** — correct, but slower than parallel would be.

## Available Tools

| Tool | Description |
|------|-------------|
| `create_flashcards` | Create one or more flashcards in Mochi |
| `create_cards_from_template` | Create one or more flashcards using a template with field names (auto-maps to IDs) |
| `update_flashcard` | Update a flashcard's content, deck, template, or fields. Returns only the changed fields (plus the card id), read back from Mochi to confirm the write. Can also soft-delete with `trashed` property |
| `update_flashcards` | Update one or more flashcards, each with its own change. Returns a success count + itemized failures |
| `update_flashcards_bulk` | Apply **one** identical change (move via `deckId`, re-template via `templateId`, or soft-delete/restore via `trashed`) to many cards at once. Send the change once plus a list of `cardIds` — far fewer request tokens than per-card updates. Returns a success count + itemized failures |
| `delete_flashcard` | Permanently delete a flashcard and its attachments (cannot be undone) |
| `delete_flashcards` | Permanently delete one or more flashcards. Returns a success count + itemized failures |
| `archive_flashcard` | Archive or unarchive a flashcard |
| `archive_flashcards` | Archive or unarchive one or more flashcards. Returns a success count + itemized failures |
| `list_flashcards` | List flashcards, optionally filtered by deck. Pass `includeSubdecks: true` with a `deckId` to also pull cards from every nested subdeck. A card that fails validation is set aside in `malformed` (with its id) instead of failing the whole call |
| `search_flashcards` | Find cards by content with substring or fuzzy matching |
| `list_decks` | List decks (each with `parent-id` for hierarchy). Scope to a deck with `deckId`, and add `includeSubdecks: true` to return its full nested subtree |
| `create_deck` | Create a deck, optionally nested under a parent via `parentId` |
| `update_deck` | Rename a deck, re-home it under a new `parentId` (or `null` for top level), or soft-delete with `trashed` |
| `list_templates` | List all templates with their field definitions |
| `get_template` | Get a single template by ID |
| `get_due_cards` | Get flashcards due for review |

## Resources

| URI | Description |
|-----|-------------|
| `mochi://decks` | List of all decks |
| `mochi://templates` | List of all templates |

## Prompts

| Prompt | Description |
|--------|-------------|
| `write-flashcard` | Generates a well-structured flashcard following best practices (atomic questions, cloze deletions, etc.) |

## Examples

### Create a simple flashcard

```json
{
  "tool": "create_flashcards",
  "params": {
    "cards": [
      {
        "content": "What is MCP?\n---\nModel Context Protocol - a protocol for providing context to LLMs",
        "deckId": "<DECK_ID>"
      }
    ]
  }
}
```

### Create a card from template

```json
{
  "tool": "create_cards_from_template",
  "params": {
    "cards": [
      {
        "templateId": "<TEMPLATE_ID>",
        "deckId": "<DECK_ID>",
        "fields": {
          "Front": "What is the capital of France?",
          "Back": "Paris"
        }
      }
    ]
  }
}
```

### Get today's due cards

```json
{
  "tool": "get_due_cards",
  "params": {}
}
```
