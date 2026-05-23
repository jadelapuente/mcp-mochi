import { describe, it, expect, vi } from "vitest";
import type { AxiosInstance } from "axios";

import {
  MochiClient,
  MochiError,
  normalizeForSearch,
  trigrams,
  jaccard,
  extractSnippet,
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
