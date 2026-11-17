import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AboutYouField } from "@/components/settings/voice-settings-form";
import { DraftCorrectInput, buildDraftCorrectPrompt } from "@/lib/agents/draft-correct";
import { PlacementDraftInput, buildPlacementDraftPrompt } from "@/lib/agents/placement-draft";
import { PlacementQualifyInput } from "@/lib/agents/placement-qualify";
import { problemsOf, unfinished } from "@/lib/jobs/workflows/placement-draft";
import { auditDraft, isAdvisory, type AuditContext, type DraftForAudit } from "@/lib/placements/audit";
import { factsUsed } from "@/lib/placements/fact-fit";
import { unrecordedEvents } from "@/lib/placements/first-hand-events";
import { loadRecentReplies, recentFacts, recentRepliesFrom, repeatedFacts, type RecentReply } from "@/lib/placements/recent-facts";
import { appendFact } from "@/lib/voice/about-you";
import { recentFactsRule } from "@/lib/voice/fact-rules";
import { ABOUT_YOU_MAX, VoiceSettings, notesAsRules } from "@/lib/voice/settings";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * "is that the only thing it can say?" The case, 12 November 2026, on the
 * GetTrafficFast site. About you was capped at 400 characters and held one
 * usable fact, the owner's blog numbers; 5 of the last 17 drafts said
 * "position 30-40". Under @hank_ships's post about being called a grifter and
 * building for the joy of it, not the money, the reply said "…i'm still
 * trying to get my blog articles past position 30-40, so i know the grind
 * is real." and passed every check. Pinned here: About you holds 2,000
 * characters; the recent replies' facts are traced, told to the drafter and
 * the rewrite, and a repeat fails the advisory check "Repeats a recent fact"
 * (one rewrite, never a block); a fact fits only a post about its subject;
 * a feeling with no fact passes; an invented payment does not.
 */

/** The owner's About you and notes, as they stood on 12 November 2026. */
const OWNER_ABOUT =
  "Former agency designer, learned to code at night. Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40. Left Porto on Oct 27 2026, working from Taipei.";
const BLOG_SENTENCE =
  "Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40.";
const OWNER_NOTES =
  "Lowercase, short lines, like a reply typed on a phone. One idea per reply. Lead with a number or a concrete thing I did. Never name a product, never a link. No em dashes, no hashtags, no 'great post', no lists. Disagree when I disagree. Ask one precise question when I have nothing to add.";

/** @hank_ships's post, its first lines as the owner pasted them. */
const HANK_POST =
  "Every few weeks someone calls me a grifter for charging money, as if I'm trying to milk my followers. It stings every time, because I mostly build for the fun of it. Everyone is chasing the AI gold rush and investors are writing big checks,…";

/** The reply that passed every check, word for word. */
const BAD_DRAFT =
  "i get that feeling, it's hard when people misinterpret your intentions, especially during a gold rush. i'm still trying to get my blog articles past position 30-40, so i know the grind is real.";

/** A reply with a feeling and no fact, the kind the fit rule asks for. */
const FEELING_DRAFT =
  "being called a grifter for building in public stings. i build because i like seeing something i made get used, the money comes way after that.";

/** What the owner suggested, with an event About you does not record. */
const INVENTED_DRAFT =
  "being called a grifter stings. even with zero revenue, i felt the same joy when someone paid for my app.";

const NOW = new Date("2026-11-12T09:30:00Z");

/** Four of the last ten replies said "position 30-40"; one said 342 impressions; five said nothing of him. */
const HISTORY: RecentReply[] = [
  "most of my articles sit at position 30-40, nowhere near page one yet.",
  "position 30-40 for every article so far. google takes its time.",
  "same here, articles stuck around position 30-40 for weeks.",
  "i'm at position 30-40 with zero clicks, so no idea yet.",
  "342 impressions on my blog last week, still 0 clicks.",
  "ship it and see who complains.",
  "what does your onboarding look like on mobile?",
  "the pricing page is the first thing i'd test.",
  "agree, the hard part is the second month.",
  "lowercase reads friendlier on x, imo.",
].map((text, index) => ({ targetId: `t-${index}`, at: `2026-11-${String(11 - (index % 10)).padStart(2, "0")}T10:00:00Z`, text }));

const RECENT = recentFacts(HISTORY, OWNER_ABOUT, NOW);

const marcCtx = (over: Partial<AuditContext> = {}): AuditContext => ({
  thread: { surface: "x", kind: "post", title: HANK_POST.slice(0, 80), excerpt: HANK_POST },
  business: { name: "GetTrafficFast", domains: ["gettrafficfa.st"], brandNames: [] },
  angle: null,
  expertise: ["ai seo", "answer engine optimization"],
  writer: { aboutYou: OWNER_ABOUT, instructions: OWNER_NOTES },
  now: NOW,
  recentFacts: RECENT,
  ...over,
});
const xReply = (body: string, claims: DraftForAudit["claims"] = []): DraftForAudit => ({ variant: "short_comment", body, linkUrl: null, claims });
const check = (result: ReturnType<typeof auditDraft>, id: string) => result.checks.find((c) => c.id === id);

describe("which About you sentences a text uses", () => {
  it("traces the bad draft's range to the blog sentence, as the draft writes it", () => {
    expect(factsUsed(BAD_DRAFT, OWNER_ABOUT, { now: NOW, post: HANK_POST })).toEqual([{ sentence: BLOG_SENTENCE, quote: "position 30-40" }]);
  });

  it("traces a distinctive number, a number with what it counts, zero in words, a name and a pair of words", () => {
    const quotes = (text: string) => factsUsed(text, OWNER_ABOUT, { now: NOW }).map((use) => use.quote);
    expect(quotes("got 342 on my blog")).toEqual(["342 on my blog"]);
    expect(quotes("9 impressions, week one")).toEqual(["9 impressions"]);
    expect(quotes("still zero clicks here")).toEqual(["zero clicks"]);
    expect(quotes("writing this from Taipei")).toEqual(["Taipei"]);
    expect(quotes("as a former agency designer")).toEqual(["former agency"]);
  });

  it("reads none in a reply with no fact of his, and no date as a figure", () => {
    expect(factsUsed(FEELING_DRAFT, OWNER_ABOUT, { now: NOW, post: HANK_POST })).toEqual([]);
    expect(factsUsed("ship it on oct 26 and see", OWNER_ABOUT, { now: NOW })).toEqual([]);
    expect(factsUsed("7 days to ship, 3 bugs", OWNER_ABOUT, { now: NOW })).toEqual([]);
  });

  it("does not count a pair of words the post itself uses", () => {
    expect(factsUsed("an ai pipeline is only as good as its review", OWNER_ABOUT, { now: NOW, post: "my ai pipeline broke again" })).toEqual([]);
    expect(factsUsed("an ai pipeline is only as good as its review", OWNER_ABOUT, { now: NOW })).toHaveLength(1);
  });
});

describe("the recent replies' facts", () => {
  it("counts the blog sentence in 5 of the last 10 replies, with how they wrote it", () => {
    expect(RECENT).toEqual({
      replies: 10,
      facts: [{ sentence: BLOG_SENTENCE, count: 5, quotes: ["position 30-40", "342 impressions"] }],
    });
  });

  it("keeps one reply per post, the posted text first, newest first, the post being drafted aside", () => {
    const replies = recentRepliesFrom(
      {
        targets: [
          { id: "posted", surface: "x", title: null, excerpt: null, published_at: "2026-11-11T08:00:00Z", selected_placement_id: "p-1", published_text: "what he posted" },
        ],
        drafts: [{ id: "p-1", variant: "short_comment", body: "the draft he chose" }],
      },
      [
        { target_id: "posted", variant: "short_comment", body: "the draft he chose", created_at: "2026-11-10T08:00:00Z" },
        { target_id: "reddit", variant: "short_comment", body: "short one", created_at: "2026-11-12T08:00:00Z" },
        { target_id: "reddit", variant: "detailed_answer", body: "long one", created_at: "2026-11-12T08:00:00Z" },
        { target_id: "reddit", variant: "article_draft", body: "names the project", created_at: "2026-11-12T08:00:00Z" },
        { target_id: "self", variant: "short_comment", body: "the post being drafted", created_at: "2026-11-12T09:00:00Z" },
      ],
      { excludeTargetId: "self" }
    );
    expect(replies).toEqual([
      { targetId: "reddit", at: "2026-11-12T08:00:00Z", text: "short one\nlong one" },
      { targetId: "posted", at: "2026-11-11T08:00:00Z", text: "what he posted" },
    ]);
  });

  it("reads the drafts in one indexed read beside the posted replies, and never throws", async () => {
    const db = new FakeSupabase({
      placement_targets: [],
      placements: HISTORY.map((reply) => ({ target_id: reply.targetId, business_id: "biz-1", variant: "short_comment", body: reply.text, created_at: reply.at })),
    });
    const replies = await loadRecentReplies(db as unknown as SupabaseClient, { businessId: "biz-1", excludeTargetId: "t-0" });
    expect(replies).toHaveLength(9);
    expect(replies.map((reply) => reply.targetId)).not.toContain("t-0");
    const broken = { from: () => { throw new Error("down"); } };
    expect(await loadRecentReplies(broken as unknown as SupabaseClient, { businessId: "biz-1", excludeTargetId: "x" })).toEqual([]);
  });
});

describe('the advisory check "Repeats a recent fact"', () => {
  it("fails the real bad draft when the history has the same fact, with a sentence the person can act on", () => {
    const four = recentFacts(HISTORY.slice(0, 4).concat(HISTORY.slice(5)), OWNER_ABOUT, NOW);
    const result = auditDraft(xReply(BAD_DRAFT), marcCtx({ recentFacts: four }));
    const repeat = check(result, "repeats_recent_fact");
    expect(repeat).toMatchObject({ label: "Repeats a recent fact", status: "fail", advisory: true });
    expect(repeat?.detail).toBe('"position 30-40" is in 4 of your last 9 replies. Say something else, or nothing about yourself.');
  });

  it("names the sentence when the earlier replies wrote the fact otherwise", () => {
    expect(repeatedFacts(BAD_DRAFT, OWNER_ABOUT, RECENT, { now: NOW })[0].detail).toBe(
      '"position 30-40" repeats a fact already in 5 of your last 10 replies ("Since late September an AI pipeline writes and publishes my…"). Say something else, or nothing about yourself.'
    );
  });

  it("is advisory: it never changes the verdict, a short reply included", () => {
    const result = auditDraft(xReply(BAD_DRAFT), marcCtx());
    const without = auditDraft(xReply(BAD_DRAFT), marcCtx({ recentFacts: undefined }));
    expect(isAdvisory(check(result, "repeats_recent_fact")!)).toBe(true);
    expect(result.status).toBe(without.status);
    expect(without.checks.some((c) => c.id === "repeats_recent_fact")).toBe(false);
  });

  it("passes once, and only once, when a fact is in fewer than two recent replies", () => {
    const once = recentFacts(HISTORY.slice(3), OWNER_ABOUT, NOW);
    expect(once.facts[0].count).toBe(2);
    const single = recentFacts(HISTORY.slice(4), OWNER_ABOUT, NOW);
    expect(single.facts[0].count).toBe(1);
    expect(check(auditDraft(xReply(BAD_DRAFT), marcCtx({ recentFacts: single })), "repeats_recent_fact")?.status).toBe("pass");
    expect(check(auditDraft(xReply(BAD_DRAFT), marcCtx({ recentFacts: { replies: 0, facts: [] } })), "repeats_recent_fact")?.detail).toBe(
      "No recent replies to compare with."
    );
  });

  it("asks the first rewrite to fix it, and no later one", () => {
    const result = auditDraft(xReply(FEELING_DRAFT), marcCtx());
    expect(result.status).toBe("passed");
    const repeated = { ...result, checks: [...result.checks, { ...check(auditDraft(xReply(BAD_DRAFT), marcCtx()), "repeats_recent_fact")! }] };
    expect(unfinished(repeated, true)).toBe(true);
    expect(unfinished(repeated, false)).toBe(false);
    expect(problemsOf(repeated)).toEqual([expect.stringContaining('"position 30-40" repeats a fact already in 5 of your last 10 replies')]);
  });
});

describe("a feeling with no fact, and an invented event", () => {
  it("passes a reply that shares a feeling and states no fact", () => {
    const result = auditDraft(xReply(FEELING_DRAFT), marcCtx());
    expect(result.status).toBe("passed");
    expect(check(result, "verifiable_claims")?.status).toBe("pass");
    expect(check(result, "repeats_recent_fact")?.status).toBe("pass");
  });

  it("fails a reply that invents a payment About you does not record, and offers it to confirm", () => {
    const result = auditDraft(xReply(INVENTED_DRAFT), marcCtx());
    const claims = check(result, "verifiable_claims");
    expect(claims?.status).toBe("fail");
    expect(claims?.detail).toContain('Claims something happened to you that About you does not record ("someone paid for my app").');
    expect(claims?.confirmable).toEqual(["even with zero revenue, i felt the same joy when someone paid for my app."]);
    expect(result.status).toBe("blocked");
  });

  it("reads the forms of a sale, and leaves feelings, opinions and the poster's money alone", () => {
    const events = (text: string) => unrecordedEvents(text, OWNER_ABOUT).map((event) => event.quote);
    expect(events("the day someone pays for something i built is the best day")).toEqual(["someone pays for something i built"]);
    expect(events("i got my first customer last week")).toHaveLength(1);
    expect(events("my revenue is zero and i still ship")).toHaveLength(1);
    expect(events("i build because i like seeing something i made get used")).toEqual([]);
    expect(events("people pay for outcomes, not code")).toEqual([]);
    expect(events("your customers will tell you")).toEqual([]);
    // Recorded in About you: the prompt decides whether it fits, not this.
    expect(unrecordedEvents("someone paid for my app", "Built a habit app: 12 paying users in October 2026.")).toEqual([]);
  });
});

describe("the prompts", () => {
  const draftPrompt = buildPlacementDraftPrompt(
    PlacementDraftInput.parse({
      business: { name: "GetTrafficFast", domain: "https://gettrafficfa.st", niche: "AI SEO content for small sites" },
      thread: { surface: "x", kind: "post", community: "@hank_ships", title: HANK_POST.slice(0, 80), excerpt: HANK_POST, author: "hank_ships" },
      angle: null,
      chosenByPerson: true,
      voice: { preset: "casual", person: "i", aboutYou: OWNER_ABOUT, instructions: OWNER_NOTES },
      recentFacts: RECENT,
      language: "en",
      variants: ["short_comment"],
    })
  );

  it("carries the recent facts and the rule not to use them again", () => {
    expect(recentFactsRule(RECENT)).toBe(
      [
        "Facts you used in your recent replies:",
        '- "Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the s…" (in 5 of your last 10 replies, as "position 30-40", "342 impressions")',
        "Do not use them again unless the post asks about exactly that. Another fact that fits this post, a feeling or an opinion of yours, a position on the post or one sharp question: any of them is better than the same fact again.",
      ].join("\n")
    );
    expect(draftPrompt).toContain("Facts you used in your recent replies:");
    expect(draftPrompt).toContain("Do not use them again unless the post asks about exactly that.");
    expect(recentFactsRule({ replies: 10, facts: [] })).toBeNull();
  });

  it("carries the fit rule: rankings are not motivation, a feeling when no fact fits, no invented event", () => {
    expect(draftPrompt).toContain(
      'a fact about your blog\'s search rankings belongs under a post about SEO or rankings, never under one about motivation, money, burnout or being called a grifter'
    );
    expect(draftPrompt).toContain('It can share a feeling or a belief of yours about the post\'s subject, in first person, with no number and no event ("i build because i like seeing something i made get used")');
    expect(draftPrompt).toContain('"when someone paid for my app", "my first customer", "my revenue" are allowed only when the voice section records them');
    expect(draftPrompt).toContain("What the poster means decides the angle");
  });

  it('reads "Lead with a number or a concrete thing I did" as "when one fits"', () => {
    const notes = notesAsRules(VoiceSettings.parse({ aboutYou: OWNER_ABOUT, instructions: OWNER_NOTES })) ?? "";
    expect(notes).toContain("Lead with a number or a concrete thing I did.");
    expect(notes).toContain("A note that asks you to lead with or include a number, a fact or a concrete thing you did means: when one fits this post.");
    expect(draftPrompt).toContain("When none fits, the note yields: open with your reaction, your position or your question instead.");
  });

  it("tells a rewrite what to do with a repeated fact", () => {
    const rewrite = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({
        business: { name: "GetTrafficFast", domain: null, niche: null },
        thread: { surface: "x", kind: "post", community: "@hank_ships", title: "t", excerpt: HANK_POST, author: null },
        voice: { aboutYou: OWNER_ABOUT, instructions: OWNER_NOTES },
        language: "en",
        variants: ["short_comment"],
        revisions: [{ variant: "short_comment", problems: ['"position 30-40" is in 4 of your last 10 replies.'] }],
      })
    );
    expect(rewrite).toContain("Where a problem says a fact repeats one from your recent replies, leave that fact out and say something else");
  });

  it("gives Fix it the same lines", () => {
    const prompt = buildDraftCorrectPrompt(
      DraftCorrectInput.parse({
        business: { name: "GetTrafficFast", site: "https://gettrafficfa.st", niche: "AI SEO content for small sites" },
        thread: { surface: "x", kind: "post", title: HANK_POST.slice(0, 80), excerpt: HANK_POST },
        variant: "short_comment",
        draft: BAD_DRAFT,
        reason: "is that the only thing it can say?",
        aboutYou: OWNER_ABOUT,
        notes: OWNER_NOTES,
        recentFacts: RECENT,
      })
    );
    expect(prompt).toContain("Facts you used in your recent replies:");
    expect(prompt).toContain("never under one about motivation, money, burnout or being called a grifter");
    expect(prompt).toContain("means: when one fits this post");
  });
});

describe("About you holds 2,000 characters", () => {
  const full = "x".repeat(ABOUT_YOU_MAX);

  it("in the schema, the drafter, the rewrite and the qualifier", () => {
    expect(ABOUT_YOU_MAX).toBe(2_000);
    expect(VoiceSettings.safeParse({ aboutYou: full }).success).toBe(true);
    expect(VoiceSettings.safeParse({ aboutYou: `${full}x` }).success).toBe(false);
    expect(
      DraftCorrectInput.safeParse({
        business: { name: "a", site: null },
        thread: { surface: "x", kind: "post", title: "t", excerpt: "" },
        variant: "short_comment",
        draft: "d",
        reason: "too generic",
        aboutYou: full,
      }).success
    ).toBe(true);
    expect(PlacementQualifyInput.shape.aboutWriter.safeParse(full).success).toBe(true);
  });

  it("in the add-fact refusal", () => {
    const refused = appendFact(`${"x".repeat(ABOUT_YOU_MAX - 10)}.`, "As of November 12, 2026: I build for the joy of it.");
    expect(refused).toMatchObject({ ok: false });
    if (refused.ok) return;
    expect(refused.error).toMatch(/and it holds 2,000\.$/);
    expect(appendFact("x".repeat(1_500), "As of November 12, 2026: I build for the joy of it.")).toMatchObject({ ok: true, appended: true });
  });

  it("in the form: the field, the count and a hint that asks for several kinds of true facts", () => {
    const html = renderToStaticMarkup(<AboutYouField value={OWNER_ABOUT} onChange={() => {}} now={NOW} />);
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain(`${OWNER_ABOUT.length}/2,000`);
    expect(html).toContain("numbers you measured, what you are building, what you feel and believe about building, your situation, opinions you hold");
    expect(html).toContain("Only true things");
  });
});
