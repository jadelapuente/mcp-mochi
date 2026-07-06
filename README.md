# Mochi MCP Server

MCP server for [Mochi](https://mochi.cards) flashcard integration, allowing you to manage your flashcards through the Model Context Protocol.

## Features

- Create, update, and delete flashcards
- Create cards from templates with automatic field name-to-ID mapping
- Add attachments (images, audio) to cards
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
      "args": ["-y", "@fredrika/mcp-mochi"],
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
   git clone https://github.com/fredrika/mcp-mochi.git
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
3. **429 retry** — if a rate limit still occurs (e.g. the Mochi desktop app is using the API at the same time), requests are retried with backoff.

Set `MOCHI_DISABLE_ACCOUNT_LOCK=1` to skip the cross-process file lock (useful for tests or debugging). The in-process queue always applies when using a real API client.

Large batch operations (create/update many cards) run **serially** — correct, but slower than parallel would be.

## Available Tools

| Tool | Description |
|------|-------------|
| `mochi_create_flashcard` | Create a new flashcard in Mochi |
| `mochi_create_card_from_template` | Create a flashcard using a template with field names (auto-maps to IDs) |
| `mochi_update_flashcard` | Update a flashcard's content, deck, template, or fields. Returns only the changed fields (plus the card id), read back from Mochi to confirm the write. Can also soft-delete with `trashed` property |
| `mochi_update_flashcards_bulk` | Apply **one** identical change (move via `deckId`, re-template via `templateId`, or soft-delete/restore via `trashed`) to many cards at once. Send the change once plus a list of `cardIds` — far fewer request tokens than per-card updates. Returns a success count + itemized failures |
| `mochi_delete_flashcard` | Permanently delete a flashcard and its attachments (cannot be undone) |
| `mochi_archive_flashcard` | Archive or unarchive a flashcard |
| `mochi_add_attachment` | Add an attachment (image, audio, etc.) to a card using base64 data |
| `mochi_list_flashcards` | List flashcards, optionally filtered by deck. Pass `includeSubdecks: true` with a `deckId` to also pull cards from every nested subdeck. A card that fails validation is set aside in `malformed` (with its id) instead of failing the whole call |
| `mochi_list_decks` | List decks (each with `parent-id` for hierarchy). Scope to a deck with `deckId`, and add `includeSubdecks: true` to return its full nested subtree |
| `mochi_create_deck` | Create a deck, optionally nested under a parent via `parentId` |
| `mochi_update_deck` | Rename a deck, re-home it under a new `parentId` (or `null` for top level), or soft-delete with `trashed` |
| `mochi_list_templates` | List all templates with their field definitions |
| `mochi_get_template` | Get a single template by ID |
| `mochi_get_due_cards` | Get flashcards due for review |

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
  "tool": "mochi_create_flashcard",
  "params": {
    "content": "What is MCP?\n---\nModel Context Protocol - a protocol for providing context to LLMs",
    "deckId": "<DECK_ID>"
  }
}
```

### Create a card from template

```json
{
  "tool": "mochi_create_card_from_template",
  "params": {
    "templateId": "<TEMPLATE_ID>",
    "deckId": "<DECK_ID>",
    "fields": {
      "Front": "What is the capital of France?",
      "Back": "Paris"
    }
  }
}
```

### Get today's due cards

```json
{
  "tool": "mochi_get_due_cards",
  "params": {}
}
```
