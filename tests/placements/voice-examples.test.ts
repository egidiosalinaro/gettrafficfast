import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PUBLISHED_TEXT_READS,
  VOICE_EXAMPLE_LIMIT,
  VOICE_EXAMPLE_REPLY_CHARS,
  VOICE_EXAMPLE_THREAD_CHARS,
  loadVoiceExamples,
  pickVoiceExamples,
  type PostedDraft,
  type PostedTarget,
} from "@/lib/placements/voice-examples";
import { ensurePublishedText } from "@/lib/placements/published-text";
import { FakeSupabase } from "../support/fake-supabase";

// The real function, watched: no row in these tests has an X link unless a
// test says so, and the one that does replaces the X read, so nothing here
// reaches the network.
vi.mock("@/lib/placements/published-text", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/placements/published-text")>();
  return { ...actual, ensurePublishedText: vi.fn(actual.ensurePublishedText) };
});

/**
 * The replies the owner posted, handed back as the voice to match. The rows
 * are the production ones of 9 November 2026, newest first: the reply he
 * fixed by adding his own line, the reply he liked, and the advert-shaped
 * replies of October that named the product with its link.
 */

const NAMES = ["GetTrafficFast"];

const ALEX_POSTED =
  "It's tough to tell if these tools work without knowing if the audience is actually ready to buy. Finding them is one thing, but are they actively looking for a solution? That's the real test. I’m not good at doing the test I’m just thinking out loud ahahah";
const DANIEL_REPLY =
  "Not naive at all. I'm getting 200+ impressions on my blog now, still zero clicks. Honest numbers take time to compound. What kind of numbers are you seeing?";

const target = (over: Partial<PostedTarget> & { id: string }): PostedTarget => ({
  surface: "x",
  title: "a post",
  excerpt: "a post",
  published_at: "2026-11-09T12:00:00.000Z",
  selected_placement_id: `p-${over.id}`,
  ...over,
});

const PRODUCTION: PostedTarget[] = [
  target({
    id: "alex",
    published_at: "2026-11-09T12:33:54.710Z",
    excerpt: 'i saw review on X about one tool to find customers\nand i was like "WTF?? boolshit! does it even work???"\n\nso i decided to run the experiment',
  }),
  target({ id: "daniel", published_at: "2026-11-09T12:22:07.555Z", excerpt: "Honest numbers might be holding my product back.\n\nKind of sad, but it seems true." }),
  target({ id: "toolkit", published_at: "2026-10-08T13:27:02.396Z", excerpt: "Must-Have AI Tools for Professionals" }),
  target({ id: "claude", published_at: "2026-10-08T12:51:13.625Z", excerpt: "My Claude content writing skill takes one keyword" }),
  target({ id: "reddit", surface: "reddit", published_at: "2026-10-05T16:05:21.355Z", excerpt: "I'm trying to launch a 90-100% automated SEO workflow" }),
  // Marked posted before the draft was chosen: no text to read, nothing guessed.
  target({ id: "unselected", surface: "linkedin", published_at: "2026-09-29T15:54:31.630Z", selected_placement_id: null }),
];

const DRAFTS: PostedDraft[] = [
  { id: "p-alex", variant: "short_comment", body: ALEX_POSTED },
  { id: "p-daniel", variant: "short_comment", body: DANIEL_REPLY },
  {
    id: "p-toolkit",
    variant: "short_comment",
    body: "Even with a great AI toolkit, professionals still need to factor in human review for brand voice. I make sure to do that for my own site's blog posts, which I publish through GetTrafficFast (https://gettrafficfa.st/). It helps ensure factual accuracy.",
  },
  {
    id: "p-claude",
    variant: "short_comment",
    body: "Does your Claude skill check uniqueness across those five sites? Tailoring each article for its audience and SEO intent prevents dilution. GetTrafficFast (https://gettrafficfa.st/) is what I use for that.",
  },
  {
    id: "p-reddit",
    variant: "short_comment",
    body: "Full 90-100% SEO automation is tough once you go beyond initial content generation. GetTrafficFast is what I use for that. You can't fully automate the strategic thinking part of SEO yet.",
  },
];

describe("pickVoiceExamples", () => {
  it("keeps what he wrote and leaves out the adverts and the sentences a model wrote", () => {
    const examples = pickVoiceExamples(PRODUCTION, DRAFTS, { surface: "x", names: NAMES });
    expect(examples.map((example) => example.reply)).toEqual([
      // The AI half of the reply he fixed is deleted, as the gate deletes it; his line stays.
      "I’m not good at doing the test I’m just thinking out loud ahahah",
      DANIEL_REPLY,
    ]);
    // The thread is the post's own words, on one line.
    expect(examples[0].thread).toBe(
      'i saw review on X about one tool to find customers and i was like "WTF?? boolshit! does it even work???" so i decided to run the experiment'
    );
    expect(examples[1].thread).toBe("Honest numbers might be holding my product back. Kind of sad, but it seems true.");
  });

  it("prefers the text he really posted, when the reply link captured it, over the draft he chose", () => {
    const posted = "honestly no idea if it works yet, i'm 3 weeks in and still at zero clicks";
    const examples = pickVoiceExamples(
      [target({ id: "alex", published_text: posted }), target({ id: "daniel", published_text: null })],
      DRAFTS,
      { surface: "x", names: NAMES }
    );
    expect(examples.map((example) => example.reply)).toEqual([posted, DANIEL_REPLY]);
    // Posted text that names the product is still an advert.
    expect(
      pickVoiceExamples([target({ id: "alex", published_text: "GetTrafficFast is what I use for that, works fine" })], DRAFTS, {
        surface: "x",
        names: NAMES,
      })
    ).toEqual([]);
  });

  it("puts the thread's own surface first, then the most recent, and stops at five", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      target({
        id: `t${i}`,
        surface: i % 2 === 0 ? "reddit" : "x",
        published_at: `2026-11-0${i + 1}T10:00:00.000Z`,
        excerpt: `thread ${i}`,
      })
    );
    const drafts = many.map((row, i) => ({ id: `p-${row.id}`, variant: "short_comment", body: `reply number ${i} typed on a phone` }));
    const examples = pickVoiceExamples(many, drafts, { surface: "reddit", names: NAMES });
    expect(examples).toHaveLength(VOICE_EXAMPLE_LIMIT);
    expect(examples.map((example) => example.thread)).toEqual(["thread 6", "thread 4", "thread 2", "thread 0", "thread 7"]);
    // The same rows in another order give the same examples.
    expect(pickVoiceExamples([...many].reverse(), [...drafts].reverse(), { surface: "reddit", names: NAMES })).toEqual(examples);
  });

  it("caps each reply at 280 characters and each thread at 200", () => {
    // Short sentences: one of forty words would be deleted as a tell.
    const long = "still zero clicks on the blog this week. ".repeat(12).trim();
    const [example] = pickVoiceExamples(
      [target({ id: "long", excerpt: "thread ".repeat(80) })],
      [{ id: "p-long", variant: "short_comment", body: long }],
      { surface: "x", names: NAMES }
    );
    expect(example.reply.length).toBeLessThanOrEqual(VOICE_EXAMPLE_REPLY_CHARS);
    expect(example.thread.length).toBeLessThanOrEqual(VOICE_EXAMPLE_THREAD_CHARS);
    expect(example.reply).toMatch(/…$/);
  });

  it("skips the article and the list entry, the target being drafted, and a reply with nothing of his left", () => {
    const rows = [target({ id: "article" }), target({ id: "self" }), target({ id: "alltells" })];
    const drafts = [
      { id: "p-article", variant: "article_draft", body: "why nobody clicks on page three of google" },
      { id: "p-self", variant: "short_comment", body: "a reply to the post being drafted right now" },
      { id: "p-alltells", variant: "short_comment", body: "It's tough to tell if it works. Here's the thing: nobody knows." },
    ];
    expect(pickVoiceExamples(rows, drafts, { surface: "x", names: NAMES, excludeTargetId: "self" })).toEqual([]);
  });
});

describe("loadVoiceExamples", () => {
  beforeEach(() => {
    vi.mocked(ensurePublishedText).mockClear();
  });

  const seed = () =>
    new FakeSupabase({
      placement_targets: [
        ...PRODUCTION.map((row) => ({ ...row, business_id: "biz-1", status: "published_manually" })),
        // Another business's posted reply, and this business's reply still in review.
        { ...target({ id: "other-biz" }), business_id: "biz-2", status: "published_manually" },
        { ...target({ id: "drafted" }), business_id: "biz-1", status: "drafted" },
      ],
      placements: [
        ...DRAFTS.map((draft) => ({ ...draft, business_id: "biz-1" })),
        { id: "p-other-biz", variant: "short_comment", body: "not this business's voice", business_id: "biz-2" },
        { id: "p-drafted", variant: "short_comment", body: "not posted yet, so not his voice", business_id: "biz-1" },
      ],
    });

  it("reads this business's posted replies and their chosen drafts, the column for the posted text optional", async () => {
    const db = seed();
    const examples = await loadVoiceExamples(db as unknown as SupabaseClient, {
      businessId: "biz-1",
      targetId: "new",
      surface: "x",
      names: NAMES,
    });
    expect(examples.map((example) => example.reply)).toEqual([
      "I’m not good at doing the test I’m just thinking out loud ahahah",
      DANIEL_REPLY,
    ]);
    // Two reads, no more: the posted targets, then their drafts.
    expect(db.calls).toEqual(["select:placement_targets", "select:placements"]);
  });

  it("reads back from X, before picking, at most two posted replies that have a link and no text, with the job's client", async () => {
    const db = seed();
    // His newest reply: posted with its link, edited on X, its text not read yet.
    const alex = db.tables.placement_targets.find((row) => row.id === "alex")!;
    Object.assign(alex, { published_url: "https://x.com/samriv/status/1987654321098765432", published_text: null });
    const edited = "i'm not good at doing the test, just thinking out loud ahahah";
    vi.mocked(ensurePublishedText).mockImplementationOnce(async (_client, rows) =>
      rows.map((row) => (row.id === "alex" ? { ...row, published_text: edited } : row))
    );

    const examples = await loadVoiceExamples(db as unknown as SupabaseClient, {
      businessId: "biz-1",
      targetId: "new",
      surface: "x",
      names: NAMES,
    });

    expect(PUBLISHED_TEXT_READS).toBe(2);
    expect(ensurePublishedText).toHaveBeenCalledTimes(1);
    const [client, rows, options] = vi.mocked(ensurePublishedText).mock.calls[0];
    expect(client).toBe(db);
    expect(options).toEqual({ max: 2 });
    // This business's posted rows, newest first, each with what the reader needs.
    expect(rows.map((row) => row.id)).toEqual(["alex", "daniel", "toolkit", "claude", "reddit", "unselected"]);
    expect(rows[0]).toMatchObject({ id: "alex", status: "published_manually", published_url: alex.published_url, published_text: null });
    expect(rows[1]).toMatchObject({ published_url: null, published_text: null });
    // What he posted, edited on X, is the example; not the draft he chose.
    expect(examples.map((example) => example.reply)).toEqual([edited, DANIEL_REPLY]);
  });

  it("leaves out a reply marked as removed from the site, in the read and in the pick", async () => {
    const db = seed();
    const daniel = db.tables.placement_targets.find((row) => row.id === "daniel")!;
    Object.assign(daniel, { removed_at: "2026-11-10T09:00:00Z", removed_reason: "Hidden because my account is new" });
    const examples = await loadVoiceExamples(db as unknown as SupabaseClient, {
      businessId: "biz-1",
      targetId: "new",
      surface: "x",
      names: NAMES,
    });
    expect(examples.map((example) => example.reply)).not.toContain(DANIEL_REPLY);
    expect(examples.map((example) => example.reply)).toContain(
      "I’m not good at doing the test I’m just thinking out loud ahahah"
    );
    // Not read back from X either: nobody can read a removed reply.
    const rows = vi.mocked(ensurePublishedText).mock.calls[0]?.[1] ?? [];
    expect(rows.map((row) => row.id)).not.toContain("daniel");
  });

  it("pickVoiceExamples never picks a removed reply, whatever its text", () => {
    const rows = [
      target({ id: "up", published_text: DANIEL_REPLY, published_at: "2026-11-09T10:00:00Z" }),
      target({ id: "gone", published_text: DANIEL_REPLY + " again", published_at: "2026-11-09T11:00:00Z", removed_at: "2026-11-10T00:00:00Z" }),
    ];
    expect(pickVoiceExamples(rows, [], { surface: "x", names: NAMES }).map((example) => example.reply)).toEqual([DANIEL_REPLY]);
  });

  it("returns nothing, and reads no drafts, when nothing was posted", async () => {
    const db = new FakeSupabase({ placement_targets: [], placements: [] });
    const examples = await loadVoiceExamples(db as unknown as SupabaseClient, {
      businessId: "biz-1",
      targetId: "new",
      surface: "x",
      names: NAMES,
    });
    expect(examples).toEqual([]);
    expect(db.calls).toEqual(["select:placement_targets"]);
  });

  it("falls back to the chosen draft when the database has no posted-text column yet, and never throws", async () => {
    const db = seed();
    // A database from before both columns: any read naming one fails whole.
    const withoutColumns = {
      from(table: string) {
        const builder = db.from(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
        if (table !== "placement_targets") return builder;
        let missing = false;
        const chain: Record<string, (...args: unknown[]) => unknown> = {
          select: (columns: unknown) => {
            missing = /published_text|removed_at/.test(String(columns));
            builder.select(columns);
            return chain;
          },
          eq: (...args) => (builder.eq(...args), chain),
          is: (...args) => (builder.is(...args), chain),
          order: (...args) => (builder.order(...args), chain),
          limit: (...args) =>
            missing
              ? Promise.resolve({ data: null, error: { message: "column placement_targets.published_text does not exist" } })
              : builder.limit(...args),
        };
        return chain;
      },
    };
    const failingOnce = withoutColumns;
    const examples = await loadVoiceExamples(failingOnce as unknown as SupabaseClient, {
      businessId: "biz-1",
      targetId: "new",
      surface: "x",
      names: NAMES,
    });
    expect(examples).toHaveLength(2);
    // No column to store the text in: nothing is read from X.
    expect(ensurePublishedText).not.toHaveBeenCalled();

    const broken = {
      from: () => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          order: () => chain,
          limit: () => Promise.resolve({ data: null, error: { message: "down" } }),
        };
        return chain;
      },
    };
    await expect(
      loadVoiceExamples(broken as unknown as SupabaseClient, { businessId: "biz-1", targetId: "new", surface: "x", names: NAMES })
    ).resolves.toEqual([]);
  });
});
