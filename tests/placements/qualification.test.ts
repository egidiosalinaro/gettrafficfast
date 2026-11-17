import { describe, expect, it, vi } from "vitest";
import type { PlacementVerdict } from "@/lib/agents/placement-qualify";
import {
  QUALIFY_SCORE_FLOOR,
  ageInDays,
  angleFromVerdict,
  angleIsPitch,
  applyVerdicts,
  decide,
  pickFairShare,
  toThreads,
  type TargetRow,
} from "@/lib/placements/qualification";

/**
 * Qualification exists to reject. Everything here is about the cases where the
 * model's answer must NOT be taken at face value, because a wrongly accepted
 * thread costs a person an hour writing an answer nobody needed.
 */

const verdict = (over: Partial<PlacementVerdict> = {}): PlacementVerdict => ({
  index: 0,
  verdict: "qualified",
  score: 80,
  reason: "Right in their domain and the top answers are all guesses.",
  angle: "They have the actual numbers from running this for two years.",
  topic: "cast iron care",
  intent: "question",
  ...over,
});

const row = (over: Partial<TargetRow> = {}): TargetRow => ({
  id: "row-1",
  surface: "reddit",
  kind: "thread",
  url: "https://www.reddit.com/r/cooking/comments/abc/",
  found_for: "cast iron seasoning",
  community: "r/cooking",
  title: "How do you season a cast iron pan properly?",
  excerpt: "I keep ruining mine.",
  posted_at: "2026-08-20T00:00:00Z",
  score: 42,
  comment_count: 17,
  ...over,
});

describe("decide", () => {
  it("keeps a qualified verdict that scores above the floor and names an angle", () => {
    expect(decide(verdict())).toMatchObject({ status: "qualified", score: 80 });
  });

  it("rejects a qualified verdict with no angle, whatever it scored", () => {
    // The failure mode that matters: a decision that tells the drafting step
    // nothing produces a generic answer, which is what this phase exists to
    // not produce.
    const decision = decide(verdict({ score: 99, angle: null }));
    expect(decision.status).toBe("rejected");
    expect(decision.reason).toMatch(/nothing specific/i);
  });

  it("rejects a qualified verdict below the floor", () => {
    const decision = decide(verdict({ score: QUALIFY_SCORE_FLOOR - 1 }));
    expect(decision.status).toBe("rejected");
    // The model's own reason survives: the customer sees why, not just that.
    expect(decision.reason).toBe(verdict().reason);
  });

  it("keeps the model's reason on a rejection and drops the angle", () => {
    const decision = decide(
      verdict({ verdict: "rejected", reason: "Adjacent at best.", angle: "something" })
    );
    expect(decision).toMatchObject({ status: "rejected", reason: "Adjacent at best.", angle: null });
  });

  it("rejects a qualified verdict whose angle is a brief to present the product", () => {
    // The production failure: the drafter builds on the angle, and this
    // angle told it to write an advert. Whatever the score, no placement.
    const decision = decide(
      verdict({ score: 92, angle: "Explain how GetTrafficFast stands out as a complete AI agent that automates the entire SEO content workflow." }),
      ["GetTrafficFast"]
    );
    expect(decision.status).toBe("rejected");
    expect(decision.angle).toBeNull();
    expect(decision.reason).toMatch(/advert, not an answer/);
  });
});

describe("angleIsPitch", () => {
  const brands = ["GetTrafficFast", "Get Traffic Fast"];

  it("recognises the briefs the qualifier used to write", () => {
    for (const angle of [
      "Explain how GetTrafficFast stands out as a complete AI agent that automates the entire SEO content workflow, from keyword research and content calendar generation to publishing.",
      "Detail how an AI agent can help brands adapt by automating the creation and publishing of high-volume, SEO-optimized content.",
      "Articulate how a sophisticated AI agent, through integrated keyword research, E-E-A-T principles, and automated publishing, consistently generates authentic content.",
      "Introduce the paradigm of an AI agent that fully automates content creation, from keyword research and article generation to SEO optimization and publishing.",
      "Explain how an all-in-one AI agent like GetTrafficFast automates the entire content workflow from keyword research to publishing.",
      "Discuss specific content strategies and structural optimizations that an AI agent can implement to increase the likelihood of a brand being cited.",
      "Position Get Traffic Fast as the answer to their publishing bottleneck.",
      "The workflow is best handled by a platform that automates the calendar and the publishing.",
      // The first re-judgement in production: the same pitch as a category.
      "While many tools focus on generating content or optimizing it, a new category of AI agents automates the entire content lifecycle, from keyword research and content calendar generation to writing and direct publishing to your website, effectively replacing multiple tools and manual steps.",
      "There is a newer class of tools that handles the whole publishing process for you.",
      "Beyond individual task automation, the realistic future of AI in SEO content lies in autonomous agents that integrate keyword research, content generation, and publishing into a continuous, self-optimizing loop.",
      // The angles behind the blocked drafts of 23 September: the product
      // as "a fully automated agent", the product as "end-to-end solutions".
      "The challenge with piecing together multiple AI tools for content creation is often the integration overhead and maintaining a consistent voice and strategy across different platforms; a fully automated agent addresses this by centralizing the entire process.",
      "The most impactful AI agents for content automation distinguish themselves by offering end-to-end solutions, from autonomous keyword research and content calendar generation to daily article writing and direct publishing.",
      "An all-in-one platform replaces the stack of tools an agency pieces together.",
      // The brief in its polite form, sitting on a qualified row on 24 September.
      "You can explain how a dedicated AI agent automates the entire SEO content creation and publishing workflow, integrating the strengths of various AI models for research, writing, and optimization, rather than relying on manual orchestration of individual LLMs.",
    ]) {
      expect(angleIsPitch(angle, brands), angle).toBe(true);
    }
  });

  it("reads the angle out of an angle-mode verdict without judging the thread", () => {
    const knowledge = "Answer engines retrieve passages, not pages.";
    const verdict = (over: Partial<PlacementVerdict>): PlacementVerdict => ({
      index: 0,
      verdict: "qualified",
      score: 50,
      reason: "ok",
      angle: knowledge,
      topic: null,
      intent: null,
      ...over,
    });
    // No score floor: the person decided the thread was worth it.
    expect(angleFromVerdict(verdict({ score: 5 }), brands)).toBe(knowledge);
    expect(angleFromVerdict(verdict({ verdict: "rejected", angle: null }), brands)).toBeNull();
    expect(angleFromVerdict(verdict({ angle: "Introduce GetTrafficFast as the answer." }), brands)).toBeNull();
    expect(angleFromVerdict(undefined, brands)).toBeNull();
  });

  it("leaves knowledge alone, even when it is about tools or starts with a verb", () => {
    for (const angle of [
      "They have the actual numbers from running this for two years.",
      "Answer engines retrieve passages, not pages: every section has to answer its own question in the first two sentences.",
      "Passage-level structure and how to measure citations.",
      "The workflow around the pieces is where the time goes, not the writing of any one piece.",
      "Explain why question-shaped headings match how people actually ask.",
      "Surfer's content score rewards term coverage, which is not what answer engines retrieve on; the two goals pull in different directions.",
      "Describe the three-day settling delay in Search Console data and why the newest days always look worse.",
      "The tasks agents automate well are the ones with a checkable output: clustering is one, intent detection is not.",
      "Measuring AI visibility requires tracking direct citations and mentions within AI answer outputs, which often don't generate a click back to the source, necessitating a shift from traditional traffic-based metrics.",
      "The integration overhead between five tools is usually the hour a day nobody budgeted for: moving text, re-checking tone, re-entering the same brief.",
      // The angle-mode answer of 29 September that stopped a draft as a
      // pitch: an opinion about where the time goes, with nothing as its
      // subject but the topic.
      "Many AI SEO tools excel at content generation, but the biggest impact on organic traffic often comes from automating the entire publishing workflow, including content calendaring and direct posting.",
      "Most of the gain is in automating the whole publish step, not in writing faster.",
    ]) {
      expect(angleIsPitch(angle, brands), angle).toBe(false);
    }
    expect(angleIsPitch(null, brands)).toBe(false);
  });
});

describe("ageInDays", () => {
  const now = new Date("2026-08-28T12:00:00Z");

  it("counts whole days", () => {
    expect(ageInDays("2026-08-21T12:00:00Z", now)).toBe(7);
  });

  it("never goes negative for a thread posted in the future", () => {
    expect(ageInDays("2026-09-01T00:00:00Z", now)).toBe(0);
  });

  it("reports a missing or unparsable date as unknown rather than as today", () => {
    expect(ageInDays(null, now)).toBeNull();
    expect(ageInDays("not a date", now)).toBeNull();
  });
});

describe("toThreads", () => {
  it("indexes by position and fills the gaps a row is allowed to have", () => {
    const threads = toThreads([row(), row({ id: "row-2", community: null, excerpt: null, score: null, comment_count: null })], new Date("2026-08-28T00:00:00Z"));
    expect(threads[0]).toMatchObject({ index: 0, community: "r/cooking", ageDays: 8 });
    // Unknown engagement is passed as unknown, not as a fake zero.
    expect(threads[1]).toMatchObject({ index: 1, community: "", excerpt: "", score: null, commentCount: null });
  });
});

describe("pickFairShare", () => {
  const dated = (surface: string, i: number) => ({
    id: `${surface}-${i}`,
    surface,
    posted_at: new Date(Date.UTC(2026, 8, 1 + (i % 20))).toISOString(),
  });
  const undated = (surface: string, i: number) => ({ id: `${surface}-${i}`, surface, posted_at: null });

  it("does not let a surface whose API knows dates starve the ones a web search found", () => {
    // The production failure: every GitHub issue has a date, no Reddit,
    // LinkedIn or X thread from a search result does, so newest-first judged
    // GitHub alone for as many runs as it took to notice.
    const rows = [
      ...Array.from({ length: 100 }, (_, i) => dated("github", i)),
      ...Array.from({ length: 100 }, (_, i) => undated("reddit", i)),
      ...Array.from({ length: 100 }, (_, i) => undated("linkedin", i)),
      ...Array.from({ length: 100 }, (_, i) => undated("x", i)),
    ];
    const picked = pickFairShare(rows, 40);
    const bySurface = new Map<string, number>();
    for (const row of picked) bySurface.set(row.surface, (bySurface.get(row.surface) ?? 0) + 1);

    expect(picked).toHaveLength(40);
    expect(bySurface.get("github")).toBe(10);
    expect(bySurface.get("reddit")).toBe(10);
    expect(bySurface.get("linkedin")).toBe(10);
    expect(bySurface.get("x")).toBe(10);
  });

  it("hands a small surface's unused share to the others", () => {
    const rows = [
      ...Array.from({ length: 2 }, (_, i) => undated("linkedin", i)),
      ...Array.from({ length: 50 }, (_, i) => undated("reddit", i)),
    ];
    const picked = pickFairShare(rows, 20);
    expect(picked.filter((r) => r.surface === "linkedin")).toHaveLength(2);
    expect(picked.filter((r) => r.surface === "reddit")).toHaveLength(18);
  });

  it("takes the newest first inside a surface, and undated rows after dated ones in their given order", () => {
    const rows = [
      { id: "old", surface: "reddit", posted_at: "2026-01-01T00:00:00Z" },
      { id: "unknown-a", surface: "reddit", posted_at: null },
      { id: "new", surface: "reddit", posted_at: "2026-09-01T00:00:00Z" },
      { id: "unknown-b", surface: "reddit", posted_at: null },
    ];
    expect(pickFairShare(rows, 4).map((r) => r.id)).toEqual(["new", "old", "unknown-a", "unknown-b"]);
  });

  it("returns everything when the cap exceeds the pool, and nothing for a spent cap", () => {
    const rows = [undated("reddit", 1), dated("github", 1)];
    expect(pickFairShare(rows, 10)).toHaveLength(2);
    expect(pickFairShare(rows, 0)).toEqual([]);
    expect(pickFairShare(rows, -5)).toEqual([]);
  });
});

describe("applyVerdicts", () => {
  const supabaseWith = (updates: unknown[]) => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn((payload: unknown) => {
      updates.push(payload);
      return { eq };
    });
    return { from: vi.fn(() => ({ update })) } as never;
  };

  it("writes one decision per verdict and counts them", async () => {
    const updates: unknown[] = [];
    const applied = await applyVerdicts({
      supabase: supabaseWith(updates),
      rows: [row(), row({ id: "row-2" })],
      verdicts: [verdict({ index: 0 }), verdict({ index: 1, verdict: "rejected" })],
      now: new Date("2026-08-28T00:00:00Z"),
    });

    expect(applied).toEqual({ qualified: 1, rejected: 1, undecided: 0 });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      status: "qualified",
      qualify_score: 80,
      topic: "cast iron care",
      intent: "question",
      qualified_by: "agent",
    });
  });

  it("writes a pitch-angled verdict back as a rejection when told the business's names", async () => {
    const updates: unknown[] = [];
    const applied = await applyVerdicts({
      supabase: supabaseWith(updates),
      rows: [row()],
      verdicts: [verdict({ angle: "Explain how Lodge's seasoning service takes the guesswork out of it." })],
      brandNames: ["Lodge"],
    });
    expect(applied).toEqual({ qualified: 0, rejected: 1, undecided: 0 });
    expect(updates[0]).toMatchObject({ status: "rejected", qualify_angle: null });
  });

  it("leaves an unjudged row alone rather than recording a verdict nobody gave", async () => {
    const updates: unknown[] = [];
    const applied = await applyVerdicts({
      supabase: supabaseWith(updates),
      rows: [row(), row({ id: "row-2" }), row({ id: "row-3" })],
      verdicts: [verdict({ index: 1 })],
    });

    expect(applied).toEqual({ qualified: 1, rejected: 0, undecided: 2 });
    expect(updates).toHaveLength(1);
  });

  it("ignores a verdict pointing at a row that is not in the batch", async () => {
    const updates: unknown[] = [];
    const applied = await applyVerdicts({
      supabase: supabaseWith(updates),
      rows: [row()],
      verdicts: [verdict({ index: 7 })],
    });

    expect(applied).toEqual({ qualified: 0, rejected: 0, undecided: 1 });
    expect(updates).toHaveLength(0);
  });
});
