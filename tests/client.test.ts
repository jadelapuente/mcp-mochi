import { describe, it, expect, vi } from "vitest";
import type { AxiosInstance } from "axios";

import {
  MochiClient,
  MochiError,
  normalizeForSearch,
  trigrams,
  jaccard,
  extractSnippet,
  descendantDeckIds,
  pickChangedFields,
  summarizeArgs,
} from "../src/index.js";

// ---- Mock axios instance ----------------------------------------------------

type GetHandler = (url: string, config?: any) => any | Promise<any>;
type PostHandler = (url: string, data?: any, config?: any) => any | Promise<any>;
type DeleteHandler = (url: string, config?: any) => any | Promise<any>;

interface MockApi {
  api: AxiosInstance;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function mockApi(handlers: {
  get?: GetHandler;
  post?: PostHandler;
  delete?: DeleteHandler;
} = {}): MockApi {
  const get = vi.fn(async (url: string, config?: any) =>
    handlers.get ? await handlers.get(url, config) : { data: {} }
  );
  const post = vi.fn(async (url: string, data?: any, config?: any) =>
    handlers.post ? await handlers.post(url, data, config) : { data: {} }
  );
  const del = vi.fn(async (url: string, config?: any) =>
    handlers.delete ? await handlers.delete(url, config) : { data: {} }
  );
  return {
    api: { get, post, delete: del } as unknown as AxiosInstance,
    get,
    post,
    delete: del,
  };
}

function newClient(handlers: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi(handlers);
  return { client: new MochiClient("test-token", api.api), api };
}

const sampleCard = (overrides: Record<string, unknown> = {}) => ({
  id: "card-1",
  tags: [],
  content: "What is 2+2?\n---\n4",
  name: "card-1",
  "deck-id": "deck-1",
  ...overrides,
});

// ---- Pure helpers -----------------------------------------------------------

describe("normalizeForSearch", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeForSearch("  Hello   WORLD  ")).toBe("hello world");
  });

  it("replaces markdown punctuation with spaces", () => {
    expect(normalizeForSearch("**bold** and _italic_")).toBe("bold and italic");
  });
});

describe("trigrams", () => {
  it("returns sliding 3-char windows", () => {
    const t = trigrams("abcd");
    expect(t).toEqual(new Set(["abc", "bcd"]));
  });

  it("returns the whole string when shorter than 3 chars", () => {
    const t = trigrams("ab");
    expect(t).toEqual(new Set(["ab"]));
  });

  it("normalizes before tokenizing", () => {
    const t = trigrams("AB CD");
    // "ab cd" -> "ab ", "b c", " cd"
    expect(t).toEqual(new Set(["ab ", "b c", " cd"]));
  });
});

describe("jaccard", () => {
  it("is 1 when both sets are empty", () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it("is 0 when one set is empty", () => {
    expect(jaccard(new Set(["a"]), new Set())).toBe(0);
  });

  it("computes |A∩B| / |A∪B|", () => {
    const a = new Set(["x", "y", "z"]);
    const b = new Set(["y", "z", "w"]);
    // intersection = {y, z} = 2; union = {x, y, z, w} = 4
    expect(jaccard(a, b)).toBe(0.5);
  });

  it("ranks similar strings higher than dissimilar ones", () => {
    const q = trigrams("derivative of x squared");
    const close = trigrams("the derivative of x squared is 2x");
    const far = trigrams("capital of france");
    expect(jaccard(q, close)).toBeGreaterThan(jaccard(q, far));
  });
});

describe("extractSnippet", () => {
  it("returns a window centered around the match", () => {
    const content = "a".repeat(100) + "MATCH" + "b".repeat(100);
    const snippet = extractSnippet(content, 100, 40);
    expect(snippet).toContain("MATCH");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("omits ellipses at start/end of content", () => {
    const snippet = extractSnippet("short content", 0, 200);
    expect(snippet).toBe("short content");
  });
});

// ---- update_flashcard changed-only confirmation -----------------------------

describe("pickChangedFields", () => {
  it("returns only the id when nothing was requested to change", () => {
    expect(pickChangedFields({}, sampleCard() as any)).toEqual({ id: "card-1" });
  });

  it("echoes only the changed fields, sourced from the server response", () => {
    const card = sampleCard({
      id: "c1",
      content: "stored content\n---\nstored answer",
      "deck-id": "deck-new",
    });
    const changed = pickChangedFields(
      { content: "ignored input", deckId: "ignored input" } as any,
      card as any
    );
    expect(changed).toEqual({
      id: "c1",
      content: "stored content\n---\nstored answer",
      "deck-id": "deck-new",
    });
  });

  it("does not leak fields that were not part of the update", () => {
    const card = sampleCard({ id: "c1", "deck-id": "deck-new" });
    const changed = pickChangedFields({ deckId: "deck-new" } as any, card as any);
    expect(changed).toEqual({ id: "c1", "deck-id": "deck-new" });
    expect(changed).not.toHaveProperty("content");
    expect(changed).not.toHaveProperty("name");
  });

  it("reports trashed as a boolean derived from the response", () => {
    const trashed = pickChangedFields(
      { trashed: true } as any,
      sampleCard({ "trashed?": { date: "2026-06-14T00:00:00.000Z" } }) as any
    );
    expect(trashed).toEqual({ id: "card-1", trashed: true });

    const restored = pickChangedFields(
      { trashed: false } as any,
      sampleCard() as any
    );
    expect(restored).toEqual({ id: "card-1", trashed: false });
  });

  it("confirms templateId, normalizing an absent template-id to null", () => {
    const withTemplate = pickChangedFields(
      { templateId: "t1" } as any,
      sampleCard({ "template-id": "t1" }) as any
    );
    expect(withTemplate).toEqual({ id: "card-1", "template-id": "t1" });

    const cleared = pickChangedFields(
      { templateId: "t1" } as any,
      sampleCard() as any
    );
    expect(cleared).toEqual({ id: "card-1", "template-id": null });
  });
});

// ---- Batch mutation result is a count + itemized failures ------------------

describe("updateCards batch result", () => {
  it("returns a success count and itemizes only the failures", async () => {
    const { client } = newClient({
      post: (url) => {
        if (url === "/cards/bad") throw new MochiError(["boom"], 500);
        return { data: sampleCard() };
      },
    });
    const res = await client.updateCards([
      { cardId: "good1", content: "x" },
      { cardId: "bad", content: "y" },
      { cardId: "good2", deckId: "d" },
    ]);
    expect(res.succeeded).toBe(2);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]).toMatchObject({ index: 1, cardId: "bad" });
    expect(res.failed[0].error).toContain("boom");
  });

  it("reports an empty failures array when everything succeeds", async () => {
    const { client } = newClient({ post: () => ({ data: sampleCard() }) });
    const res = await client.deleteCards([
      { cardId: "a" },
      { cardId: "b" },
    ]);
    // deleteCards uses DELETE, not POST; default mock returns {} which is fine.
    expect(res.succeeded).toBe(2);
    expect(res.failed).toEqual([]);
  });
});

// ---- Degraded cards don't blind the whole page -----------------------------

describe("CardSchema tolerates a null fields value", () => {
  it("lists a deck even when one card has fields: null", async () => {
    const { client } = newClient({
      get: () => ({
        data: {
          bookmark: "",
          docs: [
            sampleCard({ id: "ok" }),
            sampleCard({ id: "broken", fields: null }),
          ],
        },
      }),
    });
    const res = await client.listCards();
    // Without nullable fields, this whole parse throws and the deck can't list.
    expect(res.docs.map((c) => c.id).sort()).toEqual(["broken", "ok"]);
  });

  it("search scans past a card with fields: null instead of erroring", async () => {
    const { client } = newClient({
      get: () => ({
        data: {
          bookmark: "",
          docs: [
            sampleCard({ id: "hit", content: "derivative of x" }),
            sampleCard({ id: "broken", fields: null }),
          ],
        },
      }),
    });
    const res = await client.searchCards({ query: "derivative" });
    expect(res.matches.map((m) => m.id)).toEqual(["hit"]);
    expect(res.scanned).toBe(2);
  });

  it("keeps a card whose content is null (still listable for repair)", async () => {
    const { client } = newClient({
      get: () => ({
        data: {
          bookmark: "",
          docs: [sampleCard({ id: "degraded", content: null, fields: null })],
        },
      }),
    });
    const res = await client.listCards();
    expect(res.docs.map((c) => c.id)).toEqual(["degraded"]);
    expect(res.malformed).toBeUndefined();
  });
});

// ---- Per-card resilience: one bad card can't blind a deck -------------------

describe("fetchCardsPage quarantines unparseable cards", () => {
  it("sets aside a malformed card and still returns the good ones", async () => {
    const { client } = newClient({
      get: () => ({
        data: {
          bookmark: "",
          docs: [
            sampleCard({ id: "good" }),
            // deck-id is a number — violates CardSchema, can't be salvaged
            { id: "bad", content: "x", name: "n", tags: [], "deck-id": 123 },
          ],
        },
      }),
    });
    const res = await client.listCards();
    expect(res.docs.map((c) => c.id)).toEqual(["good"]);
    expect(res.malformed).toHaveLength(1);
    expect(res.malformed![0].id).toBe("bad");
    expect(res.malformed![0].error).toContain("deck-id");
  });

  it("reports (unknown id) when even the id can't be read", async () => {
    const { client } = newClient({
      get: () => ({
        data: { bookmark: "", docs: [{ name: "no id here" }] },
      }),
    });
    const res = await client.listCards();
    expect(res.docs).toHaveLength(0);
    expect(res.malformed![0].id).toBe("(unknown id)");
  });

  it("does not treat an all-malformed page as the end of the list", async () => {
    const pages: any[] = [
      // Page 1: only a malformed card, but a live bookmark — must keep paging.
      { bookmark: "b1", docs: [{ id: "bad", "deck-id": 1 }] },
      { bookmark: "b2", docs: [sampleCard({ id: "good" })] },
      { bookmark: "", docs: [] },
    ];
    let i = 0;
    const { client, api } = newClient({ get: () => ({ data: pages[i++] }) });
    const res = await client.listCards();
    expect(res.docs.map((c) => c.id)).toEqual(["good"]);
    expect(res.malformed!.map((m) => m.id)).toEqual(["bad"]);
    expect(api.get).toHaveBeenCalledTimes(3);
  });
});

// ---- Bulk same-change update ------------------------------------------------

describe("updateCardsBulk", () => {
  it("applies one shared patch to every id and dedupes", async () => {
    const { client, api } = newClient({ post: () => ({ data: sampleCard() }) });
    const res = await client.updateCardsBulk(["a", "b", "a"], { deckId: "X" });
    expect(res.succeeded).toBe(2); // "a" collapsed
    expect(res.failed).toEqual([]);
    // One POST per unique id, each carrying the shared change.
    expect(api.post).toHaveBeenCalledTimes(2);
    const urls = api.post.mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual(["/cards/a", "/cards/b"]);
    expect(api.post.mock.calls.every((c) => c[1]["deck-id"] === "X")).toBe(true);
  });

  it("itemizes only the failures, keyed by card id", async () => {
    const { client } = newClient({
      post: (url) => {
        if (url === "/cards/b") throw new MochiError(["boom"], 500);
        return { data: sampleCard() };
      },
    });
    const res = await client.updateCardsBulk(["a", "b", "c"], { trashed: true });
    expect(res.succeeded).toBe(2);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]).toMatchObject({ cardId: "b" });
  });

  it("refuses a no-op patch before making any request", async () => {
    const { client, api } = newClient();
    await expect(
      client.updateCardsBulk(["a", "b"], {})
    ).rejects.toMatchObject({ name: "MochiError", statusCode: 400 });
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ---- URL encoding -----------------------------------------------------------

describe("URL encoding of path params", () => {
  it("encodes cardId in updateCard", async () => {
    const { client, api } = newClient({
      post: () => ({ data: sampleCard({ id: "weird/id" }) }),
    });
    await client.updateCard("weird/id", { content: "x" });
    expect(api.post.mock.calls[0][0]).toBe("/cards/weird%2Fid");
  });

  it("encodes cardId in deleteCard", async () => {
    const { client, api } = newClient({ delete: () => ({ data: null }) });
    await client.deleteCard("a b/c");
    expect(api.delete.mock.calls[0][0]).toBe("/cards/a%20b%2Fc");
  });

  it("encodes templateId in getTemplate", async () => {
    const { client, api } = newClient({
      get: () => ({
        data: { id: "t/1", name: "T", content: "", pos: "0", fields: {} },
      }),
    });
    await client.getTemplate("t/1");
    expect(api.get.mock.calls[0][0]).toBe("/templates/t%2F1");
  });

  it("encodes deckId in getDueCards when scoped", async () => {
    const { client, api } = newClient({ get: () => ({ data: { cards: [] } }) });
    await client.getDueCards({ deckId: "deck/special" });
    expect(api.get.mock.calls[0][0]).toBe("/due/deck%2Fspecial");
  });

  it("encodes cardId and filename in addAttachment", async () => {
    const { client, api } = newClient({ post: () => ({ data: null }) });
    await client.addAttachment({
      cardId: "card/1",
      filename: "hello world.png",
      data: Buffer.from("png").toString("base64"),
    });
    expect(api.post.mock.calls[0][0]).toBe(
      "/cards/card%2F1/attachments/hello%20world.png"
    );
  });
});

// ---- Attachment size cap ----------------------------------------------------

describe("addAttachment size cap", () => {
  it("rejects oversized base64 before allocating a Buffer", async () => {
    const { client, api } = newClient();
    // 12 MB of base64 (decodes to ~9MB? actually 12M*3/4 = 9MB). Need >10MB.
    // 15M chars of base64 = 11.25MB decoded > 10MB cap.
    const bigBase64 = "A".repeat(15_000_000);
    await expect(
      client.addAttachment({ cardId: "c", filename: "f.bin", data: bigBase64 })
    ).rejects.toMatchObject({
      name: "MochiError",
      statusCode: 413,
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("accepts attachments under the cap", async () => {
    const { client, api } = newClient({ post: () => ({ data: null }) });
    const ok = Buffer.from("hello").toString("base64");
    await client.addAttachment({ cardId: "c", filename: "f.txt", data: ok });
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});

// ---- Batch create runs serially (Mochi: 1 in-flight / account) --------------

describe("createCards serial HTTP", () => {
  it("issues card POSTs one at a time, never overlapping", async () => {
    const inFlight: number[] = [];
    let peak = 0;
    const { client } = newClient({
      post: async (url) => {
        if (url !== "/cards") return { data: sampleCard() };
        inFlight.push(1);
        peak = Math.max(peak, inFlight.length);
        await new Promise((r) => setTimeout(r, 10));
        inFlight.pop();
        return { data: sampleCard({ id: `c-${Math.random()}` }) };
      },
    });

    await client.createCards([
      { content: "a\n---\nb", deckId: "d", templateId: null },
      { content: "c\n---\nd", deckId: "d", templateId: null },
      { content: "e\n---\nf", deckId: "d", templateId: null },
    ]);

    expect(peak).toBe(1);
  });
});

// ---- Direct createCard refuses attachments ---------------------------------

describe("createCard direct attachment guard", () => {
  it("throws when called directly with attachments", async () => {
    const { client, api } = newClient();
    await expect(
      client.createCard({
        content: "x\n---\ny",
        deckId: "d",
        attachments: { "x.png": "abc" },
      } as any)
    ).rejects.toMatchObject({ name: "MochiError" });
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ---- Empty content guard ----------------------------------------------------

describe("createCardFromTemplate empty-content guard", () => {
  it("throws before POST when all fields are blank", async () => {
    const { client, api } = newClient({
      get: () => ({
        data: {
          id: "t1",
          name: "Vocab",
          content: "",
          pos: "0",
          fields: { f1: { id: "f1", name: "Word", pos: "0" } },
        },
      }),
    });
    await expect(
      client.createCardFromTemplate({
        templateId: "t1",
        deckId: "d1",
        fields: { Word: "   " },
      })
    ).rejects.toThrow(/empty card/i);
    // GET /templates/:id happened, but POST /cards must not have
    expect(api.post).not.toHaveBeenCalled();
  });

  it("rejects unknown field names with a helpful error", async () => {
    const { client } = newClient({
      get: () => ({
        data: {
          id: "t1",
          name: "Vocab",
          content: "",
          pos: "0",
          fields: { f1: { id: "f1", name: "Word", pos: "0" } },
        },
      }),
    });
    await expect(
      client.createCardFromTemplate({
        templateId: "t1",
        deckId: "d1",
        fields: { Bogus: "x" },
      })
    ).rejects.toThrow(/Unknown field name.*Bogus.*Word/);
  });
});

// ---- Template caching across a batch ---------------------------------------

describe("createCardsFromTemplate template caching", () => {
  it("fetches each unique template exactly once across the batch", async () => {
    const template = {
      id: "t1",
      name: "T",
      content: "",
      pos: "0",
      fields: { f1: { id: "f1", name: "Word", pos: "0" } },
    };
    let postCount = 0;
    const { client, api } = newClient({
      get: () => ({ data: template }),
      post: () => ({ data: sampleCard({ id: `c${++postCount}` }) }),
    });

    await client.createCardsFromTemplate([
      { templateId: "t1", deckId: "d", fields: { Word: "a" } },
      { templateId: "t1", deckId: "d", fields: { Word: "b" } },
      { templateId: "t1", deckId: "d", fields: { Word: "c" } },
    ]);

    const templateFetches = api.get.mock.calls.filter((c) =>
      String(c[0]).startsWith("/templates/")
    );
    expect(templateFetches).toHaveLength(1);
  });

  it("fetches each distinct template once when batch mixes templates", async () => {
    const tmpl = (id: string) => ({
      id,
      name: `T-${id}`,
      content: "",
      pos: "0",
      fields: { f1: { id: "f1", name: "Word", pos: "0" } },
    });
    const { client, api } = newClient({
      get: (url) => ({ data: tmpl(url.split("/").pop()!) }),
      post: () => ({ data: sampleCard() }),
    });
    await client.createCardsFromTemplate([
      { templateId: "tA", deckId: "d", fields: { Word: "1" } },
      { templateId: "tB", deckId: "d", fields: { Word: "2" } },
      { templateId: "tA", deckId: "d", fields: { Word: "3" } },
    ]);
    const templateFetches = api.get.mock.calls.filter((c) =>
      String(c[0]).startsWith("/templates/")
    );
    expect(templateFetches).toHaveLength(2);
  });
});

// ---- Attachment partitioning in batch create -------------------------------

describe("createCards attachment partitioning", () => {
  it("reports attachment failures separately from card creation", async () => {
    let cardCounter = 0;
    const { client } = newClient({
      post: (url) => {
        if (url === "/cards") {
          return { data: sampleCard({ id: `c${++cardCounter}` }) };
        }
        // attachment upload
        throw new MochiError(["upload boom"], 500);
      },
    });
    const result = await client.createCards([
      {
        content: "q\n---\na",
        deckId: "d",
        templateId: null,
        attachments: { "x.png": Buffer.from("img").toString("base64") },
      },
    ]);
    expect(result.created).toHaveLength(1);
    expect(result.created[0].id).toBe("c1");
    expect(result.failed).toHaveLength(0);
    expect(result.attachmentErrors).toHaveLength(1);
    expect(result.attachmentErrors[0]).toMatchObject({
      cardId: "c1",
      filename: "x.png",
    });
  });

  it("puts card-creation failures in `failed` (not attachmentErrors)", async () => {
    const { client } = newClient({
      post: () => {
        throw new MochiError(["card boom"], 500);
      },
    });
    const result = await client.createCards([
      {
        content: "q\n---\na",
        deckId: "d",
        templateId: null,
        attachments: { "x.png": "AAAA" },
      },
    ]);
    expect(result.created).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.attachmentErrors).toHaveLength(0);
  });
});

// ---- listTemplates slim/verbose --------------------------------------------

describe("listTemplates", () => {
  const fakeTemplates = {
    bookmark: "next",
    docs: [
      {
        id: "t1",
        name: "Vocab",
        content: "## big body of markdown".repeat(100),
        pos: "0",
        fields: {
          f1: { id: "f1", name: "Word", pos: "0" },
          f2: { id: "f2", name: "Definition", pos: "1" },
        },
      },
    ],
  };

  it("slims response by default", async () => {
    const { client } = newClient({ get: () => ({ data: fakeTemplates }) });
    const res = await client.listTemplates();
    const doc = res.docs[0] as any;
    expect(doc).toEqual({
      id: "t1",
      name: "Vocab",
      pos: "0",
      fields: [
        { id: "f1", name: "Word" },
        { id: "f2", name: "Definition" },
      ],
    });
    expect(doc.content).toBeUndefined();
  });

  it("returns full content when verbose: true", async () => {
    const { client } = newClient({ get: () => ({ data: fakeTemplates }) });
    const res = await client.listTemplates({ verbose: true });
    const doc = res.docs[0] as any;
    expect(doc.content).toContain("## big body");
    // fields stay as a map when verbose
    expect(doc.fields.f1.name).toBe("Word");
  });
});

// ---- Search -----------------------------------------------------------------

describe("searchCards", () => {
  const page = (cards: any[], bookmark = "") => ({
    data: { bookmark, docs: cards },
  });

  it("finds case-insensitive substring matches with snippets", async () => {
    const { client } = newClient({
      get: () =>
        page([
          sampleCard({ id: "a", content: "Derivative of x squared is 2x." }),
          sampleCard({ id: "b", content: "Capital of France is Paris." }),
        ]),
    });
    const res = await client.searchCards({ query: "DERIVATIVE" });
    expect(res.matches.map((m) => m.id)).toEqual(["a"]);
    expect(res.matches[0].snippet.toLowerCase()).toContain("derivative");
    expect(res.scanned).toBe(2);
    expect(res.truncated).toBe(false);
  });

  it("returns fuzzy matches sorted by score desc, filtered by threshold", async () => {
    const { client } = newClient({
      get: () =>
        page([
          sampleCard({ id: "very-close", content: "the derivative of x squared" }),
          sampleCard({ id: "kinda-close", content: "x squared" }),
          sampleCard({ id: "unrelated", content: "capital of france is paris" }),
        ]),
    });
    const res = await client.searchCards({
      query: "derivative of x squared",
      mode: "fuzzy",
      threshold: 0.2,
    });
    expect(res.matches[0].id).toBe("very-close");
    expect(res.matches[0].score!).toBeGreaterThan(
      res.matches[res.matches.length - 1].score ?? 0
    );
    expect(res.matches.find((m) => m.id === "unrelated")).toBeUndefined();
  });

  it("respects maxScanned and sets truncated", async () => {
    let callIdx = 0;
    const { client } = newClient({
      get: () => {
        callIdx++;
        // Always returns a full page of 100 with a bookmark so the client
        // would keep paging if not capped.
        const docs = Array.from({ length: 100 }, (_, i) =>
          sampleCard({ id: `p${callIdx}-c${i}`, content: "filler content xyz" })
        );
        return page(docs, "next-page");
      },
    });
    const res = await client.searchCards({
      query: "MATCH",
      maxScanned: 150,
    });
    expect(res.scanned).toBe(150);
    expect(res.truncated).toBe(true);
    expect(res.matches).toHaveLength(0);
  });

  it("respects limit", async () => {
    const { client } = newClient({
      get: () =>
        page(
          Array.from({ length: 10 }, (_, i) =>
            sampleCard({ id: `c${i}`, content: `match ${i}` })
          )
        ),
    });
    const res = await client.searchCards({ query: "match", limit: 3 });
    expect(res.matches).toHaveLength(3);
  });
});

// ---- Resource pagination ---------------------------------------------------

describe("listAllDecks pagination", () => {
  it("follows bookmarks until exhausted", async () => {
    const pages: any[] = [
      {
        bookmark: "b1",
        docs: [{ id: "d1", sort: 1, name: "One" }],
      },
      {
        bookmark: "b2",
        docs: [{ id: "d2", sort: 2, name: "Two" }],
      },
      {
        // empty docs ends the loop
        bookmark: "",
        docs: [],
      },
    ];
    let i = 0;
    const { client, api } = newClient({
      get: () => ({ data: pages[i++] }),
    });
    const all = await client.listAllDecks();
    expect(all.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it("stops at the page cap", async () => {
    const { client, api } = newClient({
      get: () => ({
        data: {
          bookmark: "next",
          docs: [{ id: `d-${Math.random()}`, sort: 1, name: "x" }],
        },
      }),
    });
    await client.listAllDecks(3);
    expect(api.get).toHaveBeenCalledTimes(3);
  });
});

// ---- Deck hierarchy ---------------------------------------------------------

describe("descendantDeckIds", () => {
  const decks = [
    { id: "root", "parent-id": null },
    { id: "a", "parent-id": "root" },
    { id: "b", "parent-id": "a" }, // grandchild
    { id: "c", "parent-id": "root" },
    { id: "other", "parent-id": null }, // unrelated top-level
    { id: "other-child", "parent-id": "other" },
  ];

  it("includes the root first, then all descendants at any depth", () => {
    const ids = descendantDeckIds(decks, "root");
    expect(ids[0]).toBe("root");
    expect(new Set(ids)).toEqual(new Set(["root", "a", "b", "c"]));
  });

  it("excludes unrelated subtrees", () => {
    const ids = descendantDeckIds(decks, "root");
    expect(ids).not.toContain("other");
    expect(ids).not.toContain("other-child");
  });

  it("returns just the root when it has no children", () => {
    expect(descendantDeckIds(decks, "b")).toEqual(["b"]);
  });

  it("returns the root id even when the deck set is empty", () => {
    expect(descendantDeckIds([], "ghost")).toEqual(["ghost"]);
  });

  it("does not loop forever on a parent-id cycle", () => {
    const cyclic = [
      { id: "x", "parent-id": "y" },
      { id: "y", "parent-id": "x" },
    ];
    const ids = descendantDeckIds(cyclic, "x");
    expect(new Set(ids)).toEqual(new Set(["x", "y"]));
  });
});

// ---- Deck schema parses parent-id ------------------------------------------

describe("listDecks parent-id", () => {
  it("surfaces parent-id from the API response", async () => {
    const { client } = newClient({
      get: () => ({
        data: {
          bookmark: "",
          docs: [
            { id: "p", sort: 1, name: "Parent" },
            { id: "c", sort: 2, name: "Child", "parent-id": "p" },
          ],
        },
      }),
    });
    const res = await client.listDecks();
    expect(res.docs.find((d) => d.id === "c")?.["parent-id"]).toBe("p");
  });
});

// ---- Scoped deck subtree queries -------------------------------------------

describe("listDecks scoped to a subtree", () => {
  const deckPage = {
    bookmark: "",
    docs: [
      { id: "unit", sort: 1, name: "Python" },
      { id: "sub1", sort: 2, name: "Functions", "parent-id": "unit" },
      { id: "sub2", sort: 3, name: "OOP", "parent-id": "unit" },
      { id: "nested", sort: 4, name: "Dataclasses", "parent-id": "sub2" },
      { id: "stray", sort: 5, name: "Unrelated" },
    ],
  };

  it("returns just the deck when includeSubdecks is not set", async () => {
    const { client } = newClient({ get: () => ({ data: deckPage }) });
    const res = await client.listDecks({ deckId: "unit" });
    expect(res.docs.map((d) => d.id)).toEqual(["unit"]);
    expect(res.bookmark).toBe("");
  });

  it("returns the deck plus its full nested subtree with includeSubdecks", async () => {
    const { client } = newClient({ get: () => ({ data: deckPage }) });
    const res = await client.listDecks({
      deckId: "unit",
      includeSubdecks: true,
    });
    expect(new Set(res.docs.map((d) => d.id))).toEqual(
      new Set(["unit", "sub1", "sub2", "nested"])
    );
    expect(res.docs.map((d) => d.id)).not.toContain("stray");
  });

  it("never forwards scoping params to the /decks query string", async () => {
    const { client, api } = newClient({ get: () => ({ data: deckPage }) });
    await client.listDecks({ deckId: "unit", includeSubdecks: true });
    for (const call of api.get.mock.calls) {
      const params = call[1]?.params ?? {};
      expect(params).not.toHaveProperty("deckId");
      expect(params).not.toHaveProperty("includeSubdecks");
    }
  });
});

// ---- Card cascade across subdecks ------------------------------------------

describe("listCards includeSubdecks cascade", () => {
  const decks = {
    bookmark: "",
    docs: [
      { id: "unit", sort: 1, name: "Python" },
      { id: "sub", sort: 2, name: "Functions", "parent-id": "unit" },
      { id: "stray", sort: 3, name: "Unrelated" },
    ],
  };

  it("aggregates cards from the deck and its subdecks, excluding unrelated decks", async () => {
    const { client } = newClient({
      get: (url, config) => {
        if (url === "/decks") return { data: decks };
        const deckId = config?.params?.["deck-id"];
        const byDeck: Record<string, any[]> = {
          unit: [sampleCard({ id: "u1", "deck-id": "unit" })],
          sub: [sampleCard({ id: "s1", "deck-id": "sub" })],
          stray: [sampleCard({ id: "x1", "deck-id": "stray" })],
        };
        return { data: { bookmark: "", docs: byDeck[deckId] ?? [] } };
      },
    });
    const res = await client.listCards({
      deckId: "unit",
      includeSubdecks: true,
    });
    expect(res.docs.map((c) => c.id).sort()).toEqual(["s1", "u1"]);
    expect(res.truncated).toBe(false);
    expect(res.bookmark).toBeNull();
  });

  it("throws when includeSubdecks is set without a deckId", async () => {
    const { client, api } = newClient();
    await expect(
      client.listCards({ includeSubdecks: true })
    ).rejects.toMatchObject({ name: "MochiError", statusCode: 400 });
    expect(api.get).not.toHaveBeenCalled();
  });

  it("sets truncated when the card cap is exceeded", async () => {
    const { client } = newClient({
      get: (url) => {
        if (url === "/decks")
          return { data: { bookmark: "", docs: [{ id: "unit", sort: 1, name: "U" }] } };
        // Always a full page with a bookmark, so the walk keeps paging.
        const docs = Array.from({ length: 100 }, (_, i) =>
          sampleCard({ id: `c-${Math.random()}-${i}`, "deck-id": "unit" })
        );
        return { data: { bookmark: "next", docs } };
      },
    });
    const res = await client.listCards({
      deckId: "unit",
      includeSubdecks: true,
    });
    expect(res.truncated).toBe(true);
    expect(res.docs).toHaveLength(2000);
  });
});

// ---- Default card list auto-pagination -------------------------------------

describe("listCards auto-paginates by default", () => {
  it("follows bookmarks to exhaustion and returns a null bookmark", async () => {
    const pages: any[] = [
      { bookmark: "b1", docs: [sampleCard({ id: "c1" })] },
      { bookmark: "b2", docs: [sampleCard({ id: "c2" })] },
      // Mochi keeps the bookmark truthy even on the empty final page.
      { bookmark: "b3", docs: [] },
    ];
    let i = 0;
    const { client, api } = newClient({
      get: () => ({ data: pages[i++] }),
    });

    const res = await client.listCards();
    expect(res.docs.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(res.bookmark).toBeNull();
    expect(res.truncated).toBe(false);
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it("forwards the bookmark cursor on each follow-up page", async () => {
    const seen: (string | undefined)[] = [];
    const pages: any[] = [
      { bookmark: "b1", docs: [sampleCard({ id: "c1" })] },
      { bookmark: "", docs: [] },
    ];
    let i = 0;
    const { client } = newClient({
      get: (_url, config) => {
        seen.push(config?.params?.bookmark);
        return { data: pages[i++] };
      },
    });

    await client.listCards({ deckId: "unit" });
    expect(seen).toEqual([undefined, "b1"]);
  });

  it("sets truncated when the card cap is exceeded", async () => {
    const { client } = newClient({
      get: () => {
        // Always a full page with a bookmark, so the walk keeps paging.
        const docs = Array.from({ length: 100 }, (_, i) =>
          sampleCard({ id: `c-${Math.random()}-${i}` })
        );
        return { data: { bookmark: "next", docs } };
      },
    });

    const res = await client.listCards({ deckId: "unit" });
    expect(res.truncated).toBe(true);
    expect(res.docs).toHaveLength(2000);
  });
});

// ---- Deck create / update ---------------------------------------------------

describe("createDeck", () => {
  it("maps parentId to parent-id and posts to /decks", async () => {
    const { client, api } = newClient({
      post: () => ({ data: { id: "new", sort: 1, name: "Sub", "parent-id": "p" } }),
    });
    const deck = await client.createDeck({ name: "Sub", parentId: "p" });
    expect(api.post.mock.calls[0][0]).toBe("/decks");
    expect(api.post.mock.calls[0][1]).toEqual({ name: "Sub", "parent-id": "p" });
    expect(deck.id).toBe("new");
  });

  it("omits parent-id for a top-level deck", async () => {
    const { client, api } = newClient({
      post: () => ({ data: { id: "new", sort: 1, name: "Top" } }),
    });
    await client.createDeck({ name: "Top" });
    expect(api.post.mock.calls[0][1]).toEqual({ name: "Top" });
  });
});

describe("updateDeck", () => {
  it("re-homes a deck and encodes the deckId", async () => {
    const { client, api } = newClient({
      post: () => ({ data: { id: "d/1", sort: 1, name: "X", "parent-id": "new" } }),
    });
    await client.updateDeck("d/1", { parentId: "new" });
    expect(api.post.mock.calls[0][0]).toBe("/decks/d%2F1");
    expect(api.post.mock.calls[0][1]).toEqual({ "parent-id": "new" });
  });

  it("passes null parent-id to move a deck to the top level", async () => {
    const { client, api } = newClient({
      post: () => ({ data: { id: "d1", sort: 1, name: "X" } }),
    });
    await client.updateDeck("d1", { parentId: null });
    expect(api.post.mock.calls[0][1]).toEqual({ "parent-id": null });
  });

  it("maps trashed to the trashed? flag", async () => {
    const { client, api } = newClient({
      post: () => ({ data: { id: "d1", sort: 1, name: "X" } }),
    });
    await client.updateDeck("d1", { trashed: true });
    expect(api.post.mock.calls[0][1]).toEqual({ "trashed?": true });
  });
});

// ---- Diagnostics: request arg summary --------------------------------------

describe("summarizeArgs", () => {
  it("reports body length and per-field string lengths", () => {
    const s = summarizeArgs({ content: "hello", "deck-id": "abc" });
    expect(s.bodyLen).toBe(JSON.stringify({ content: "hello", "deck-id": "abc" }).length);
    expect(s.fieldLens).toEqual({ content: 5, "deck-id": 3 });
  });

  it("flags non-ASCII / special characters", () => {
    expect(summarizeArgs({ content: "plain ascii" }).hasSpecialChars).toBe(false);
    // accents, em dash, smart quotes, emoji
    expect(summarizeArgs({ content: "Qué — “x”" }).hasSpecialChars).toBe(true);
    expect(summarizeArgs({ content: "card 🎴" }).hasSpecialChars).toBe(true);
  });

  it("does not flag tabs/newlines as special", () => {
    expect(summarizeArgs({ content: "q\n---\na\t" }).hasSpecialChars).toBe(false);
  });

  it("notes multipart bodies without serializing the buffer", () => {
    const formData = { getHeaders: () => ({}), append: () => {} };
    expect(summarizeArgs(formData)).toEqual({ body: "multipart" });
  });

  it("returns an empty summary for no body", () => {
    expect(summarizeArgs(undefined)).toEqual({});
    expect(summarizeArgs(null)).toEqual({});
  });
});

// ---- MochiError message serialization --------------------------------------

describe("MochiError message", () => {
  it("renders nested object error values as JSON, not [object Object]", () => {
    const err = new MochiError({ "trashed?": "must be a boolean" }, 422);
    expect(err.message).toBe("must be a boolean");

    const nested = new MochiError(
      { errors: { content: "required" } } as any,
      422
    );
    expect(nested.message).toBe('{"content":"required"}');
    expect(nested.message).not.toContain("[object Object]");
  });

  it("joins string arrays plainly", () => {
    expect(new MochiError(["a", "b"], 400).message).toBe("a, b");
  });
});
