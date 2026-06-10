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

## Available Tools

| Tool | Description |
|------|-------------|
| `mochi_create_flashcard` | Create a new flashcard in Mochi |
| `mochi_create_card_from_template` | Create a flashcard using a template with field names (auto-maps to IDs) |
| `mochi_update_flashcard` | Update a flashcard's content, deck, template, or fields. Can also soft-delete with `trashed` property |
| `mochi_delete_flashcard` | Permanently delete a flashcard and its attachments (cannot be undone) |
| `mochi_archive_flashcard` | Archive or unarchive a flashcard |
| `mochi_add_attachment` | Add an attachment (image, audio, etc.) to a card using base64 data |
| `mochi_list_flashcards` | List flashcards, optionally filtered by deck. Pass `includeSubdecks: true` with a `deckId` to also pull cards from every nested subdeck |
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
