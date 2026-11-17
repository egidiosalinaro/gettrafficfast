import { describe, expect, it } from "vitest";
import {
  ADVISORY_CHECKS,
  STYLE_CHECKS,
  asksForRewrite,
  auditDraft,
  campaignMention,
  countsTowardVerdict,
  isAdvisory,
  promotesBusiness,
  straightQuotes,
  tellsIn,
  fitXLength,
  withoutLink,
  withoutTells,
  xLength,
  X_LIMIT,
  type AuditContext,
  type DraftForAudit,
} from "@/lib/placements/audit";

/**
 * The gate is the product. Every case here is a draft that must NOT ship as
 * written, plus the ones that must, so a future prompt change cannot quietly
 * turn the inbox into a spam queue.
 */

const ctx: AuditContext = {
  thread: {
    surface: "reddit",
    kind: "thread",
    title: "How do I get my site cited by AI answer engines like ChatGPT and Perplexity?",
    excerpt: "Our SEO is decent but AI answers never mention us. What actually moves the needle?",
  },
  business: { name: "GetTrafficFast", domains: ["gettrafficfa.st"], brandNames: ["Get Traffic Fast"] },
  angle: "Answer engines retrieve passages, not pages: every section has to answer its own question in the first two sentences.",
  expertise: ["ai seo", "answer engine optimization", "citation rate", "answer-first sections"],
  // The good answer says "for us", "I run my blog through" and "the
  // checklist we use": experience, which is a claim, so the fixture
  // business records how it uses the product.
  writer: { aboutYou: "I publish my own blog through GetTrafficFast and restructured it this way." },
};

// Answers first, names no product, carries no link, closes on the person's
// question. The shape every reply is now asked for: the 21 replies published
// with one sentence naming the product read as adverts.
const SITE = "https://gettrafficfa.st";
const LEAD = `Answer engines retrieve passages, not pages, so the thing that moved the needle for us was restructuring every section to answer its own question in the first two sentences. Question-shaped headings help too: they match how people actually ask.`;
const REST = `Then check whether the engines cite you at all — ask ChatGPT and Perplexity a handful of the questions your pages answer and record whether your domain shows up in the sources. It is a sampled measurement, not ground truth, but the trend over a few weeks tells you if the restructuring is working. If you want, I can share the checklist we use for the section structure.`;
const GOOD_BODY = `${LEAD} ${REST}`;
/** The good reply with one more sentence in the middle, where the mention used to sit. */
const withLine = (line: string) => `${LEAD} ${line} ${REST}`;

/**
 * The mention sentences of the 21 replies published between 28 September
 * and 8 October 2026, as they were posted. Every one is refused, in a reply
 * and in an article.
 */
const PUBLISHED_MENTIONS = [
  "GetTrafficFast (https://gettrafficfa.st/) is what I use for that.",
  "I use GetTrafficFast (https://gettrafficfa.st/) for my own site's blog publishing.",
  "I publish my own site's blog through GetTrafficFast (https://gettrafficfa.st/)",
  "that's the part I have [GetTrafficFast](https://gettrafficfa.st/) doing for my own site",
  "I handle my own site's blog publishing with GetTrafficFast (https://gettrafficfa.st/) to keep things consistent.",
  "I manage my own site's blog publishing with GetTrafficFast (...). It keeps the calendar full.",
  "For my own site's blog, that's the part I have GetTrafficFast doing",
  "GetTrafficFast is what I use for that.",
];

// The article on the writer's own account still names the project once,
// with the link, in a clause that is not the "I use X for that" shape.
const ARTICLE_MENTION = `My own blog runs on GetTrafficFast (${SITE}), so weigh this with that in mind.`;
const ARTICLE = `Why AI answers skip your pages\n\n${GOOD_BODY}\n\n${ARTICLE_MENTION} ${GOOD_BODY}\n\n${GOOD_BODY}`;
const articleCtx: AuditContext = { ...ctx, thread: { ...ctx.thread, surface: "linkedin", kind: "post" } };
const article = (over: Partial<DraftForAudit> = {}): DraftForAudit => ({
  variant: "article_draft",
  body: ARTICLE,
  linkUrl: SITE,
  claims: [{ text: "My own blog runs on GetTrafficFast", basis: "business_profile" }],
  ...over,
});

const draft = (over: Partial<DraftForAudit> = {}): DraftForAudit => ({
  variant: "detailed_answer",
  body: GOOD_BODY,
  linkUrl: null,
  claims: [{ text: "Answer engines retrieve passages, not pages", basis: "general_knowledge" }],
  ...over,
});

const failing = (result: ReturnType<typeof auditDraft>) =>
  result.checks.filter((c) => c.status === "fail").map((c) => c.id);

describe("auditDraft", () => {
  it("passes a reply that answers and names nothing: no product, no link, nothing it cannot back", () => {
    const result = auditDraft(draft(), ctx);
    expect(result.status).toBe("passed");
    expect(result.checks.find((c) => c.id === "manual_publish")?.status).toBe("pass");
    expect(result.checks.find((c) => c.id === "names_business")?.label).toBe("Names no product: the reply is the answer");
    expect(result.checks.find((c) => c.id === "names_business")?.detail).toBe(
      "Does not name GetTrafficFast. Readers who want to know who wrote it open the profile."
    );
    expect(result.checks.find((c) => c.id === "link")?.detail).toBe("No URL in the reply.");
    expect(result.checks.find((c) => c.id === "useful_without_link")?.detail).toBe("No link to delete: the text is the answer.");

    // The same reply passes on every surface: none of them wants a name or a link any more.
    for (const surface of ["quora", "linkedin", "hackernews", "stackexchange", "indiehackers", "web"]) {
      const elsewhere = auditDraft(draft(), { ...ctx, thread: { ...ctx.thread, surface } });
      expect(elsewhere.status, surface).toBe("passed");
    }
    const x = auditDraft(
      draft({
        variant: "short_comment",
        body: "Make every section answer its own question in its first two sentences, then ask the engines those questions and record who they cite.",
        claims: [],
      }),
      { ...ctx, thread: { ...ctx.thread, surface: "x", kind: "post" } }
    );
    expect(x.status).toBe("passed");
  });

  it("refuses any link in a reply, on every surface, and still requires the one link in the article", () => {
    const reddit = auditDraft(draft({ body: withLine(`The checklist is on [my blog](${SITE}/blog).`), linkUrl: null }), ctx);
    expect(reddit.status).toBe("blocked");
    expect(failing(reddit)).toContain("link");
    expect(reddit.checks.find((c) => c.id === "link")?.label).toBe("No link in the reply");
    expect(reddit.checks.find((c) => c.id === "link")?.detail).toMatch(/Reddit removes a comment that contains a link/);

    for (const surface of ["quora", "x", "linkedin", "hackernews", "github"]) {
      const there = { ...ctx, thread: { ...ctx.thread, surface } };
      const bare = auditDraft(draft({ body: withLine(`More at ${SITE}/blog/aeo.`) }), there);
      expect(failing(bare), surface).toContain("link");
      expect(bare.checks.find((c) => c.id === "link")?.detail, surface).toBe(
        "A reply carries no link: readers find the business through the profile. Leave every URL out."
      );
      // A link declared beside the text is a link too.
      expect(failing(auditDraft(draft({ linkUrl: SITE }), there)), surface).toContain("link");
    }
    expect(failing(auditDraft(draft({ variant: "github_issue", body: withLine(`See ${SITE}.`) }), ctx))).toContain("link");

    // The article on the writer's own account still carries the one link, beside the name.
    const linked = auditDraft(article(), articleCtx);
    expect(linked.checks.find((c) => c.id === "link")?.status).toBe("pass");
    expect(linked.checks.find((c) => c.id === "link")?.detail).toBe("One link to gettrafficfa.st, beside the name.");
    const unlinked = auditDraft(article({ body: ARTICLE.replace(` (${SITE})`, ""), linkUrl: null }), articleCtx);
    expect(failing(unlinked)).toContain("link");
    expect(unlinked.checks.find((c) => c.id === "link")?.detail).toContain("No link to gettrafficfa.st");
    // A business with no site recorded has nothing to link, and is not refused for it.
    const siteless = auditDraft(article({ body: ARTICLE.replace(` (${SITE})`, ""), linkUrl: null }), {
      ...articleCtx,
      business: { ...ctx.business, domains: [] },
    });
    expect(siteless.checks.find((c) => c.id === "link")?.status).toBe("pass");
  });

  it("refuses a reply that names the product, once or more, and passes the same name in the list entry", () => {
    const named = "My own blog runs on GetTrafficFast, so weigh this with that in mind.";
    for (const variant of ["short_comment", "detailed_answer", "github_issue"] as const) {
      const result = auditDraft(draft({ variant, body: withLine(named) }), ctx);
      expect(result.status, variant).toBe("blocked");
      expect(failing(result), variant).toContain("names_business");
      const detail = result.checks.find((c) => c.id === "names_business")?.detail ?? "";
      expect(detail, variant).toContain("Names GetTrafficFast.");
      expect(detail, variant).toContain("Delete the clause that names it and put nothing in its place.");
    }
    const twice = auditDraft(draft({ body: `${withLine(named)} The Get Traffic Fast blog has the long version.` }), ctx);
    expect(twice.checks.find((c) => c.id === "names_business")?.detail).toContain("Names GetTrafficFast 2 times.");

    // The list entry is the project's line: naming it is the point.
    const listCtx: AuditContext = {
      ...ctx,
      thread: {
        surface: "github",
        kind: "repository",
        title: "awesome-aeo: answer engine optimization tools",
        excerpt: "A curated list of answer engine optimization tools, grouped by what they measure.",
      },
      angle: "Citation measurement per engine is missing from the list.",
    };
    const entry = `* [GetTrafficFast](${SITE}) - Samples whether answer engines cite a site, engine by engine.

This PR adds a citation measurement entry to the answer engine optimization tools section, since the list has none that samples citations per engine. It follows the format of the entries around it.`;
    const listed = auditDraft(
      draft({
        variant: "github_pr_proposal",
        body: entry,
        linkUrl: SITE,
        claims: [{ text: "Samples whether answer engines cite a site, engine by engine", basis: "business_profile" }],
      }),
      listCtx
    );
    expect(listed.checks.find((c) => c.id === "names_business")?.status).toBe("pass");
    expect(listed.checks.find((c) => c.id === "names_business")?.detail).toBe("Named once.");
    expect(listed.checks.find((c) => c.id === "link")?.status).toBe("pass");
    expect(listed.status).toBe("passed");

    // The same line in a reply under the same repository is refused.
    const asReply = auditDraft(draft({ variant: "github_issue", body: entry, linkUrl: null, claims: [] }), listCtx);
    expect(failing(asReply)).toEqual(expect.arrayContaining(["names_business", "link"]));
  });

  it("refuses every mention sentence the 21 published replies carried, in a reply and in an article", () => {
    for (const line of PUBLISHED_MENTIONS) {
      expect(campaignMention(line, ["GetTrafficFast"]), line).not.toBeNull();

      const reply = auditDraft(draft({ body: withLine(line) }), ctx);
      expect(reply.status, line).toBe("blocked");
      expect(failing(reply), line).toContain("human_voice");
      expect(reply.checks.find((c) => c.id === "human_voice")?.detail, line).toContain("already posted under every thread");

      const onArticle = auditDraft(article({ body: ARTICLE.replace(ARTICLE_MENTION, line) }), articleCtx);
      expect(failing(onArticle), line).toContain("human_voice");
      expect(onArticle.checks.find((c) => c.id === "human_voice")?.detail, line).toContain("already posted under every thread");
    }
  });

  it("catches the generic forms whatever the name, and leaves ordinary sentences alone", () => {
    // Any capitalised name in the exact shape, or a name that carries a link.
    for (const line of [
      "Tallyhold is what I use for that.",
      "[Tallyhold](https://tallyhold.example) is what I use for this.",
      "That's the part I have Tallyhold doing for me.",
      "The part I have Tallyhold doing is the reminders.",
      "What I have Zapier doing is the hand-off.",
      "The reminders are the bit I have Tallyhold sending.",
      "I use Tallyhold (https://tallyhold.example) for the reminders.",
      "I let [Tallyhold](https://tallyhold.example) handle the reminders.",
      "I manage the reminders with Tallyhold (https://tallyhold.example).",
    ]) {
      expect(campaignMention(line, []), line).not.toBeNull();
    }
    // The business's own names, in every form, linked or not.
    for (const line of [
      "I use GetTrafficFast for the citation sampling.",
      "I have Get Traffic Fast doing the sampling.",
      "I let GetTrafficFast handle the publishing.",
      "I run my own blog through GetTrafficFast, so that's my bias.",
      "I publish twice a week via GetTrafficFast.",
      "I do the publishing bit in GetTrafficFast.",
      "The recording bit is what I use GetTrafficFast for, so that's my bias.",
    ]) {
      expect(campaignMention(line, ["GetTrafficFast", "Get Traffic Fast"]), line).not.toBeNull();
    }
    // What a person says without plugging anything.
    for (const line of [
      "I use a spreadsheet for that.",
      "A spreadsheet is what I use for that.",
      "That is what I use for this.",
      "This is what I use for it.",
      "I use Google Sheets for that.",
      "I run my tests with Jest.",
      "I let Sarah handle the invoices.",
      "That's the part I have to keep doing by hand.",
      "I publish twice a week and track citations by hand.",
    ]) {
      expect(campaignMention(line, ["GetTrafficFast", "Get Traffic Fast"]), line).toBeNull();
    }
    const ordinary = auditDraft(draft({ body: withLine("I use a spreadsheet for that, one row per question.") }), ctx);
    expect(ordinary.checks.find((c) => c.id === "human_voice")?.status).toBe("pass");
  });

  it("counts the benefit tail after the mention as a tell", () => {
    const tail = auditDraft(draft({ body: withLine("It keeps the calendar full.") }), ctx);
    expect(tail.checks.find((c) => c.id === "human_voice")?.detail).toContain('the benefit tail ("It keeps the calendar full")');
  });

  it("refuses the no-link sentence Reddit still removed", () => {
    const result = auditDraft(
      draft({
        body: withLine("I publish my own site's blog through GetTrafficFast, and for me, the initial keyword brief makes all the difference."),
      }),
      ctx
    );
    expect(failing(result)).toContain("human_voice");
    expect(result.checks.find((c) => c.id === "human_voice")?.detail).toMatch(/publish my own site's blog through/);
  });

  it("refuses the mention sentence that was posted, and removed, on every thread", () => {
    const result = auditDraft(
      draft({ body: withLine("For the publishing flow, that's the part I have GetTrafficFast doing for my own site.") }),
      ctx
    );
    expect(failing(result)).toContain("human_voice");
    expect(result.checks.find((c) => c.id === "human_voice")?.detail).toMatch(/already posted under every thread/);
  });

  it("refuses the maker speaking, by name or by role, whatever else the reply does right", () => {
    for (const clause of [
      "I work on GetTrafficFast, so weigh this accordingly.",
      "We built Get Traffic Fast for exactly this.",
      "For context, I'm behind GetTrafficFast.",
      "I'm the founder of a tool in this space, which is why I care about this part.",
      "Full disclosure: our product does the citation check.",
      "Our users ask for this every week.",
    ]) {
      const result = auditDraft(draft({ body: withLine(clause), linkUrl: null }), ctx);
      expect(result.status, clause).toBe("blocked");
      expect(failing(result), clause).toContain("human_voice");
      expect(result.checks.find((c) => c.id === "human_voice")?.detail, clause).toContain("Speaks as the maker");
    }
    // A user's own shop is not the maker's: "my team", "we built our calendar around it".
    const user = auditDraft(
      draft({ body: `${GOOD_BODY} My team built our whole calendar around that structure.` }),
      ctx
    );
    expect(user.checks.find((c) => c.id === "human_voice")?.detail).not.toContain("Speaks as the maker");
  });

  it("still requires the article to name the business once: never is a refusal, twice a warning", () => {
    const passing = auditDraft(article(), articleCtx);
    expect(passing.status).toBe("passed");
    expect(passing.checks.find((c) => c.id === "names_business")?.detail).toBe("Named once.");

    const silent = auditDraft(article({ body: ARTICLE.replace(`${ARTICLE_MENTION} `, ""), linkUrl: null }), articleCtx);
    expect(failing(silent)).toContain("names_business");
    expect(silent.checks.find((c) => c.id === "names_business")?.detail).toContain("Never names GetTrafficFast");

    const twice = auditDraft(article({ body: `${ARTICLE} The Get Traffic Fast blog has the long version, with the data.` }), articleCtx);
    expect(twice.checks.find((c) => c.id === "names_business")?.status).toBe("warn");
    expect(twice.checks.find((c) => c.id === "names_business")?.detail).toContain("Named 2 times");
    // An article that ends on the business carries the soft-close tell.
    expect(twice.checks.find((c) => c.id === "human_voice")?.detail).toContain("closes on the business");

    // With no name recorded there is nothing to look for, and nothing to refuse.
    const nameless = auditDraft(draft(), { ...ctx, business: { name: "", domains: [], brandNames: [] } });
    expect(nameless.checks.find((c) => c.id === "names_business")?.status).toBe("pass");
  });

  it("refuses a short reply that names what it uses in its last sentence, and passes it without that sentence", () => {
    const answer =
      "Answer engines retrieve passages, not pages, so make every section answer its own question in the first two sentences. Then ask ChatGPT and Perplexity your pages' questions and record whether your domain is cited.";
    const named = auditDraft(draft({ variant: "short_comment", body: `${answer} I do the publishing bit in GetTrafficFast.` }), ctx);
    expect(named.status).toBe("blocked");
    expect(failing(named)).toEqual(expect.arrayContaining(["names_business", "human_voice"]));

    const short = auditDraft(draft({ variant: "short_comment", body: answer }), ctx);
    expect(short.checks.find((c) => c.id === "answers_first")?.status).toBe("pass");
    expect(short.status).toBe("passed");

    // The brand in the opening: still the pitch opener.
    const opener = auditDraft(
      draft({ variant: "short_comment", body: "I run my blog through GetTrafficFast and answer engines retrieve passages, not pages. Make every section answer its own question first." }),
      ctx
    );
    expect(failing(opener)).toContain("answers_first");
  });

  it("does not take an imperative for a pitch: a reply that opens 'Use…' or 'Try…' answers first", () => {
    for (const opening of ["Use question-shaped headings.", "Try asking the engines your own questions first.", "Check out the sources each engine cites."]) {
      const result = auditDraft(draft({ body: `${opening} ${GOOD_BODY}` }), ctx);
      expect(result.checks.find((c) => c.id === "answers_first")?.status, opening).toBe("pass");
    }
    const ours = auditDraft(draft({ body: `Check out our tool for this. ${GOOD_BODY}` }), ctx);
    expect(ours.checks.find((c) => c.id === "answers_first")?.detail).toContain('The opening is a pitch ("Check out our")');
  });

  it("blocks a draft that opens with the pitch", () => {
    const result = auditDraft(draft({ body: `Check out GetTrafficFast, it does exactly this. ${GOOD_BODY}` }), ctx);
    expect(result.status).toBe("blocked");
    expect(failing(result)).toContain("answers_first");
  });

  it("blocks a draft that is only a link", () => {
    const result = auditDraft(
      draft({
        variant: "short_comment",
        body: "We wrote about answer engines and citation rate here: https://gettrafficfa.st/blog/aeo — it covers this.",
        linkUrl: "https://gettrafficfa.st/blog/aeo",
      }),
      ctx
    );
    expect(result.status).toBe("blocked");
    expect(failing(result)).toContain("useful_without_link");
  });

  it("names the thread's own words when a reply does not touch it, so the rewrite has something to use", () => {
    const result = auditDraft(
      draft({
        body: "A human editor is still essential for brand voice and factual accuracy before publishing. GetTrafficFast is what I use for that, and the last read is always mine.",
      }),
      ctx
    );
    const detail = result.checks.find((check) => check.id === "specific_angle")?.detail ?? "";
    expect(result.status).toBe("blocked");
    expect(detail).toContain("Use the thread's own words:");
    expect(detail).toMatch(/chatgpt|perplexity|cited|needle/i);
  });

  it("drops the essay sentences the voice check names, including one that starts by saying it is easy to see", () => {
    const essay = [
      "It's easy to see lists of must-have tools and think they'll handle everything.",
      "Answer engines retrieve passages, not pages, so each section answers its own question first.",
      "This isn't just about fixing mistakes. It's about the reader trusting the page.",
      "This protects your reputation with the audience you already have.",
      "This is the process I follow for my own content.",
      "My own blog runs on GetTrafficFast.",
    ].join(" ");
    const cleaned = withoutTells(essay, "article_draft");
    expect(cleaned).not.toMatch(/easy to see/i);
    expect(cleaned).not.toMatch(/isn't just/i);
    expect(cleaned.split(/(?<=[.!?])\s+/).filter((sentence) => /^this\b/i.test(sentence))).toHaveLength(2);
    expect(cleaned).toContain("My own blog runs on GetTrafficFast.");
    expect(cleaned).toContain("passages");
  });

  it("blocks a generic answer that does not touch the thread or the angle", () => {
    const result = auditDraft(
      draft({
        body: "Great question! Marketing is about consistency and knowing your audience. Post regularly, measure what works, and iterate. Consistency beats intensity every single time, and the brands that win are the ones that keep showing up week after week with something worth reading, whatever channel they choose to invest in over the long run.",
      }),
      ctx
    );
    expect(result.status).toBe("blocked");
    expect(failing(result)).toContain("specific_angle");
  });

  it("blocks numbers that were never declared as claims, and any unverified claim", () => {
    const undeclared = auditDraft(draft({ body: `${GOOD_BODY} Sites that did this saw a 43% lift in citations.` }), ctx);
    expect(failing(undeclared)).toContain("verifiable_claims");

    const unverified = auditDraft(draft({ claims: [{ text: "we have 2,000 customers", basis: "unverified" }] }), ctx);
    expect(failing(unverified)).toContain("verifiable_claims");
  });

  it("blocks unverifiable language even without a number", () => {
    const result = auditDraft(draft({ body: `${GOOD_BODY} Studies show this is the best way to do it.` }), ctx);
    expect(failing(result)).toContain("verifiable_claims");
    const superlative = auditDraft(draft({ body: `${GOOD_BODY} Honestly it's the best tool for this.` }), ctx);
    expect(failing(superlative)).toContain("verifiable_claims");
  });

  it("does not mistake 'pick the best tool for each job' for a superlative claim", () => {
    // The first genuinely human draft in production was blocked on this line.
    const result = auditDraft(
      draft({ body: `${GOOD_BODY} You pick the best tool for each specific job and can intervene at any stage.` }),
      ctx
    );
    expect(result.checks.find((c) => c.id === "verifiable_claims")?.status).toBe("pass");
  });

  it("treats experience as a claim: invented when nothing about the writer is recorded, fine when it is", () => {
    const nobody = { ...ctx, writer: { aboutYou: "" } };
    const invented = auditDraft(draft(), nobody);
    expect(failing(invented)).toContain("verifiable_claims");
    expect(invented.checks.find((c) => c.id === "verifiable_claims")?.detail).toContain("Settings → Voice");

    for (const line of ["I've been using it for months.", "In my experience the headings matter most.", "We switched to question-shaped headings last year."]) {
      expect(failing(auditDraft(draft({ body: `Passages, not pages: make every section answer its own question first. ${line}` }), nobody)), line).toContain("verifiable_claims");
    }

    const absent = auditDraft(draft(), { ...ctx, writer: undefined });
    expect(failing(absent)).toContain("verifiable_claims");
    expect(auditDraft(draft(), ctx).checks.find((c) => c.id === "verifiable_claims")?.status).toBe("pass");

    // An opinion is not an experience.
    const opinion = auditDraft(
      draft({ body: "Passages, not pages: make every section answer its own question in the first two sentences. I think the headings matter more than the tool, and for me the citation check is the part worth automating." }),
      nobody
    );
    expect(opinion.checks.find((c) => c.id === "verifiable_claims")?.status).toBe("pass");
  });

  it("blocks spam signals: several links, the brand on repeat, marketing phrases", () => {
    const links = auditDraft(draft({ body: `${GOOD_BODY} See https://gettrafficfa.st/a and https://gettrafficfa.st/b.` }), ctx);
    expect(failing(links)).toContain("not_spam");

    const brand = auditDraft(draft({ body: `${GOOD_BODY} GetTrafficFast does this. GetTrafficFast is fast. Get Traffic Fast today.` }), ctx);
    expect(failing(brand)).toContain("not_spam");

    const phrase = auditDraft(draft({ body: `${GOOD_BODY} DM me for details.` }), ctx);
    expect(failing(phrase)).toContain("not_spam");
  });

  it("blocks an article's link to a domain that is not the business's", () => {
    const result = auditDraft(
      article({ body: ARTICLE.replace(SITE, "https://competitor.test/guide"), linkUrl: "https://competitor.test/guide" }),
      articleCtx
    );
    expect(failing(result)).toContain("link");
    expect(result.checks.find((c) => c.id === "link")?.detail).toContain("not at a domain of the business");
  });

  it("accepts a Reddit reply with no URL, and refuses one that adds one", () => {
    expect(auditDraft(draft(), ctx).status).toBe("passed");
    const second = auditDraft(draft({ body: `${GOOD_BODY} The checklist is at https://gettrafficfa.st/blog/aeo-checklist if it helps.` }), ctx);
    expect(failing(second)).toContain("link");
  });

  it("enforces the platform's length: a short comment on X must fit in 280 characters", () => {
    const result = auditDraft(draft({ variant: "short_comment" }), { ...ctx, thread: { ...ctx.thread, surface: "x", kind: "post" } });
    expect(failing(result)).toContain("platform_fit");
  });

  it("notes, and never blocks, a draft that touches none of the business's topics", () => {
    // Only a pass is saved, so a warning that counted toward the verdict
    // kept every off-topic reply out of the inbox, a post the owner chose
    // by hand on 8 November 2026 included. A reply speaks from the writer.
    const result = auditDraft(draft(), { ...ctx, expertise: ["cast iron", "sourdough"] });
    expect(result.status).toBe("passed");
    const coherence = result.checks.find((c) => c.id === "business_coherence");
    expect(coherence?.status).toBe("warn");
    expect(coherence?.detail).toContain("never blocks");
    expect(ADVISORY_CHECKS.has("business_coherence")).toBe(true);
  });

  it("lists failing checks first", () => {
    const result = auditDraft(draft({ body: `Check out GetTrafficFast! ${GOOD_BODY}` }), ctx);
    expect(result.checks[0].status).toBe("fail");
  });
});

/**
 * The two drafts that made the gate grow a check. Both passed every line
 * above; both read as an advert written by an AI. The text is what the inbox
 * showed, kept verbatim as the regression.
 */
const MARKETER_SHORT = `For writing better SEO content, tools like Jasper and Surfer SEO are definitely strong contenders for generating and optimizing individual pieces. However, I've found that the real game-changer isn't just a writing tool, but an AI agent that handles the entire content workflow from start to finish. Think about something that researches keywords, plans your content calendar, writes daily articles, and even publishes them directly to your site. This kind of full automation means you're not just writing better, but consistently building authority and driving traffic without constant manual effort.`;

const MARKETER_LONG = `When looking for AI tools to write better SEO content, Jasper and Surfer SEO are excellent for specific tasks like generating long-form drafts or optimizing on-page elements. They definitely help streamline the writing process. However, a different approach I've seen gain traction focuses on automating the entire content production lifecycle, moving beyond individual tools to a complete AI agent.

Instead of just assisting with writing, imagine a system that acts as your dedicated content team. This kind of AI agent starts by performing automated keyword research, identifying opportunities you might miss. It then uses this research to generate a comprehensive content calendar, ensuring a consistent flow of relevant topics.

The real power comes from its ability to then write daily, SEO-optimized articles without any manual input from you. These aren't just generic articles; they're designed to rank on Google and establish your site as an authoritative source for AI answer engines like ChatGPT, Perplexity, and Claude. Finally, it handles the publishing, integrating directly with your website to post these articles automatically.

This hands-off approach eliminates the need for expensive content agencies, juggling multiple SEO tools, or spending hours writing yourself. It's about setting up a system that continuously drives organic traffic and builds your online authority on autopilot. If you're exploring options for full content automation, you might want to look into services like GetTrafficFast that offer this kind of end-to-end AI agent solution.`;

const toolsCtx: AuditContext = {
  ...ctx,
  thread: {
    surface: "reddit",
    kind: "thread",
    title: "Best AI tools to write better SEO content?",
    excerpt: "Jasper – great for long-form content with templates tuned for SEO. Surfer SEO – pairs AI writing with on-page optimization.",
  },
  angle: "Writing tools optimise one piece; the workflow around the pieces (keyword research, calendar, publishing) is where the time goes.",
  expertise: ["seo content", "content calendar", "keyword research", "ai agent"],
};

describe("auditDraft: written like a person, not a pitch", () => {
  it("passes the answer a participant would write", () => {
    const result = auditDraft(draft(), ctx);
    expect(result.checks.find((c) => c.id === "human_voice")?.status).toBe("pass");
  });

  it("blocks the short draft from the inbox: the game-changer, the not-just-but pivot, the imagine", () => {
    const result = auditDraft(draft({ variant: "short_comment", body: MARKETER_SHORT }), toolsCtx);
    expect(result.status).toBe("blocked");
    expect(failing(result)).toContain("human_voice");
    const detail = result.checks.find((c) => c.id === "human_voice")?.detail ?? "";
    expect(detail).toContain("game-changer");
    expect(detail).toContain("not just X, but Y");
    expect(detail).toContain("imagine a system");
  });

  it("blocks the long draft from the inbox and names every tell, including the soft close on the brand", () => {
    const result = auditDraft(draft({ body: MARKETER_LONG }), toolsCtx);
    expect(result.status).toBe("blocked");
    expect(failing(result)).toContain("human_voice");
    const detail = result.checks.find((c) => c.id === "human_voice")?.detail ?? "";
    expect(detail).toContain('Sales phrasing: "you might want to look into"');
    for (const tell of ["when looking for", "streamline", "a different approach", "instead of just", "imagine a system", "the real power", "hands-off", "the benefits line", "describes an unnamed tool"]) {
      expect(detail).toContain(tell);
    }
    expect(detail).toContain('Pitches the brand by name: "services like GetTrafficFast"');
    // A reply names no product, so the soft close on the brand is check 5's refusal now.
    expect(failing(result)).toContain("names_business");
  });

  /**
   * The first production draft of agent version 3. It passed the gate as it
   * stood and still read as an advert, so it is the third fixture: the
   * paraphrased description, "I've seen services like X", the benefits close.
   */
  const V3_SHORT = `Those are solid picks for improving content quality and optimization. But it's worth thinking about the bigger picture beyond just writing individual articles. For SEO content, the real time-saver often comes from automating the entire content workflow, not just the writing part. That means something that handles keyword research, content calendar, article generation, and even publishing, all on autopilot. I've seen services like GetTrafficFast aim for this kind of end-to-end automation. It's a different approach that minimizes manual effort significantly.`;

  const V3_LONG_CLAIMS = [
    { text: "Jasper and Surfer SEO are strong contenders for refining individual pieces.", basis: "thread" as const },
    { text: "It starts with automatically researching relevant keywords for your niche and then uses that data to build a consistent content calendar.", basis: "business_profile" as const },
    { text: "From there, it generates daily, optimized articles designed to rank for those keywords.", basis: "business_profile" as const },
    { text: "The final piece is automatic publishing directly to your site.", basis: "business_profile" as const },
    { text: "The goal is to establish authority and drive organic traffic from Google and AI answer engines.", basis: "business_profile" as const },
    { text: "Services like GetTrafficFast are built around this kind of fully automated content agent model.", basis: "business_profile" as const },
  ];

  it("blocks the first draft of version 3, which the gate had let through", () => {
    const short = auditDraft(draft({ variant: "short_comment", body: V3_SHORT, claims: [] }), { ...toolsCtx, writer: { aboutYou: "" } });
    expect(short.status).toBe("blocked");
    expect(failing(short)).toContain("human_voice");
    expect(failing(short)).toContain("verifiable_claims");
    const voice = short.checks.find((c) => c.id === "human_voice")?.detail ?? "";
    expect(voice).toContain('Pitches the brand by name: "services like GetTrafficFast"');
    for (const tell of ["the real power", "beyond just", "a different approach", "end-to-end solution", "the benefits line"]) expect(voice).toContain(tell);
    expect(short.checks.find((c) => c.id === "verifiable_claims")?.detail).toContain('"I\'ve seen"');
  });

  it("counts the category pitch and the whole-workflow claim as tells", () => {
    const category = auditDraft(
      draft({ variant: "short_comment", body: "Jasper and Surfer are solid for writing and optimizing. For a different scale, though, there's a newer class of AI agents that automate the full content process. They'll research keywords, build a content calendar, write articles, and even publish them directly." }),
      toolsCtx
    );
    expect(category.checks.find((c) => c.id === "human_voice")?.detail).toContain("the new category pitch");

    const workflow = auditDraft(draft({ body: `${GOOD_BODY} Some tools now automate the entire content workflow for you.` }), ctx);
    expect(workflow.checks.find((c) => c.id === "human_voice")?.detail).toContain("the whole workflow");
  });

  it("blocks a reply that describes the product statement by statement, whatever the wording", () => {
    const body = `${GOOD_BODY} The tool researches the keywords. It builds the calendar from them. It writes the articles. It publishes them to the site.`;
    const brochure = auditDraft(draft({ body, claims: V3_LONG_CLAIMS }), toolsCtx);
    expect(failing(brochure)).toContain("human_voice");
    const detail = brochure.checks.find((c) => c.id === "human_voice")?.detail ?? "";
    expect(detail).toContain("Describes the product in 5 statements");
    // The statements are quoted, so a rewrite knows which sentences to drop.
    expect(detail).toContain('"The final piece is automatic publishing directly to your site."');
    expect(detail).toContain(", …");

    const three = auditDraft(draft({ body, claims: V3_LONG_CLAIMS.slice(0, 4) }), toolsCtx);
    expect(three.checks.find((c) => c.id === "human_voice")?.status).toBe("warn");
    expect(three.checks.find((c) => c.id === "human_voice")?.detail).toContain("3 statements about the product");
  });

  it("blocks the sales close however soft, and the brand pitched by name", () => {
    for (const close of [
      "Worth looking into if you have the time.",
      "I'd recommend giving it a spin.",
      "Definitely worth trying for a week.",
      "You can learn more about the approach on their site.",
    ]) {
      const result = auditDraft(draft({ body: `${GOOD_BODY} ${close}` }), ctx);
      expect(failing(result), close).toContain("human_voice");
    }
    const byName = auditDraft(draft({ body: `${GOOD_BODY} Try GetTrafficFast for the measuring part.` }), ctx);
    expect(failing(byName)).toContain("human_voice");
    expect(byName.checks.find((c) => c.id === "human_voice")?.detail).toContain("Pitches the brand by name");
    // The name as a Markdown link is still the name: "check out [X](url)".
    const linkedPitch = auditDraft(
      draft({ body: `Passages, not pages: make every section answer its own question first. Check out [GetTrafficFast](${SITE}), it does exactly this.` }),
      ctx
    );
    expect(linkedPitch.checks.find((c) => c.id === "human_voice")?.detail).toContain("Pitches the brand by name");
    const linkedMaker = auditDraft(draft({ body: withLine(`I work on [GetTrafficFast](${SITE}), so weigh this accordingly.`) }), ctx);
    expect(linkedMaker.checks.find((c) => c.id === "human_voice")?.detail).toContain("Speaks as the maker");
  });

  it("warns on one stray brochure word and blocks on two", () => {
    const one = auditDraft(draft({ body: `${GOOD_BODY} The restructuring is robust to redesigns.` }), ctx);
    expect(one.checks.find((c) => c.id === "human_voice")?.status).toBe("warn");
    expect(one.status).toBe("warning");

    const two = auditDraft(draft({ body: `${GOOD_BODY} It is robust and it streamlines the reviews.` }), ctx);
    expect(failing(two)).toContain("human_voice");
  });

  it("gives an article room for a stray word, but not for the whole vocabulary", () => {
    const article = (tail: string) =>
      auditDraft(
        draft({
          variant: "article_draft",
          body: `Why AI answers skip you\n\n${GOOD_BODY} ${GOOD_BODY} ${GOOD_BODY} ${GOOD_BODY} ${tail}`,
        }),
        ctx
      ).checks.find((c) => c.id === "human_voice")?.status;
    expect(article("The structure is robust and the tooling seamless.")).toBe("warn");
    expect(article("The structure is robust, the tooling seamless, and it unlocks the calendar.")).toBe("fail");
  });

  it("catches the not-just pivot split across two sentences, and the less-about-more-about pivot", () => {
    // Both from the third write of a production job: the model had been told
    // the comma form was out and put a full stop where the comma was.
    const split = auditDraft(
      draft({ body: `${GOOD_BODY} This isn't just about drafting articles. It's about automating the discovery of authoritative sources.` }),
      ctx
    );
    expect(split.checks.find((c) => c.id === "human_voice")?.detail).toContain("it's not just X, it's Y");

    const lessMore = auditDraft(
      draft({ body: `${GOOD_BODY} It's less about just creating text and more about integrating verifiable sources.` }),
      ctx
    );
    expect(lessMore.checks.find((c) => c.id === "human_voice")?.detail).toContain("less about X, more about Y");
  });

  it("counts the This-This-This cadence and a chain of em dashes as tells", () => {
    const cadence = auditDraft(
      draft({ body: `${GOOD_BODY} This helps. This also helps. This helps most of all.` }),
      ctx
    );
    expect(cadence.checks.find((c) => c.id === "human_voice")?.detail).toContain('start with "This"');

    const dashes = auditDraft(draft({ body: `${GOOD_BODY} One — two — three — four.` }), ctx);
    expect(dashes.checks.find((c) => c.id === "human_voice")?.detail).toContain("em dashes");
  });

  it("does not mistake a plain technical answer for a pitch", () => {
    const body =
      "Check out the CONTRIBUTING file first: the list only takes tools with a public repository, so the entry needs the repo link, not the landing page. Then open the PR against main with the line in the same format as its neighbours; the maintainers merge within a week or so.";
    const result = auditDraft(
      draft({ variant: "github_issue", body, claims: [] }),
      {
        ...ctx,
        thread: { surface: "github", kind: "repository", title: "Add tool to awesome-seo list", excerpt: "A curated list of SEO tools with public repositories." },
        angle: "The entry format and the public-repository rule.",
        expertise: ["seo tools", "public repository"],
      }
    );
    expect(result.checks.find((c) => c.id === "human_voice")?.status).toBe("pass");
  });

  it("lets a short comment be short: fifteen words that answer something pass the length check", () => {
    const result = auditDraft(
      draft({
        variant: "short_comment",
        body: "Passages, not pages: make every section answer its own question in the first two sentences, then check citations.",
      }),
      ctx
    );
    expect(result.checks.find((c) => c.id === "platform_fit")?.status).toBe("pass");
  });
});

/**
 * The drafts of 29 September. Every one passed the gate as it stood (the
 * first with a warning) and the owner read them as what they were: written
 * by a model. Kept verbatim; the register they share is what the gate now
 * names, with the words that tripped it quoted so a rewrite can act.
 */
const ESSAY_SHORT = `When evaluating AI SEO tools, it's easy to get caught up in content quality, but for consistent organic traffic, the automation of publishing and content calendaring makes a significant impact. Getting content from generation to live on your blog, on a schedule, is often where the real bottleneck lies. That hands-off content calendar and publishing workflow is the part I have GetTrafficFast (https://gettrafficfa.st/) doing for my own site. Considering the path from content idea to published post can change how you weigh a tool's overall value for SEO.`;

const ESSAY_LONG = `For content SEO automation, it's easy to get caught up in just the content generation part. But think about the entire pipeline from idea to published post.

A key thing to prioritize is how well the tool integrates with your actual publishing platform – whether that's WordPress, Webflow, or something else. A direct webhook or API connection means you're not manually copying and pasting or dealing with exports. That's where you genuinely save time.

Beyond publishing, consider content calendar integration. Can it slot new articles into your existing schedule, or at least communicate with it effectively? That's what moves you past just generating text and into real workflow automation.

I publish my own site's blog through [GetTrafficFast](https://gettrafficfa.st/), and having that direct publishing link is what makes it 'just work' for me. It means the content gets created, optimized, and pushed live without a lot of extra steps in between. That kind of automation for content delivery is what makes a tool genuinely effective for SEO.`;

const ESSAY_PIVOT = `Grammarly and Scrivener are solid choices for refining the actual text, which is a critical part of content creation. However, the biggest efficiency gains often come from looking at the entire content *publishing* workflow, not just the writing phase.

When I'm evaluating tools, I think about how they connect the dots from keyword research to the final post going live. Does a tool make it easy to manage your content calendar? How smoothly does it get your finished article from your editor into your CMS? These integration points are where many hours can be lost to manual transfers and copy-pasting.

Focusing on tools that bridge these gaps can significantly reduce overhead. For the actual publishing of my own site's blog, I use [GetTrafficFast](https://gettrafficfa.st/) to handle that step. It means less time spent wrestling with systems and more time focused on the quality of the content itself. So, consider the full journey of your content, not just the writing part.`;

const essayCtx: AuditContext = {
  ...ctx,
  thread: {
    surface: "reddit",
    kind: "thread",
    title: "Looking for a SEO automation tool that just works",
    excerpt: "You can check out Linda.co, it automates local seo stuff, handles content creation and helps with reviews.",
  },
  angle: "When choosing an SEO automation tool for content, check whether it can post to your CMS without a copy-paste step.",
  expertise: ["seo automation", "content calendar", "publishing", "content creation"],
  writer: { aboutYou: "I publish my own site's blog through GetTrafficFast." },
};

describe("auditDraft: the essay register", () => {
  it("blocks the draft the owner read as written by a model, naming each tell with the words that tripped it", () => {
    const result = auditDraft(
      draft({ variant: "short_comment", body: ESSAY_SHORT, linkUrl: "https://gettrafficfa.st/", claims: [] }),
      essayCtx
    );
    expect(result.status).toBe("blocked");
    expect(failing(result)).toContain("human_voice");
    const detail = result.checks.find((c) => c.id === "human_voice")?.detail ?? "";
    expect(detail).toContain(`the framing opener ("it's easy to get caught up")`);
    expect(detail).toContain(`the real power ("is often where the real bottleneck lies")`);
    expect(detail).toContain(`the impact line ("makes a significant impact")`);
    expect(detail).toContain(`from idea to live ("from generation to live")`);
    expect(detail).toContain(`the essay closer ("Considering the path from content idea to published post can change…")`);
    expect(detail).toContain("hands-off");
  });

  it("blocks the detailed answer that passed the same day: the framing opener, the pipeline, 'that's where', the closer", () => {
    const result = auditDraft(draft({ body: ESSAY_LONG, linkUrl: "https://gettrafficfa.st/", claims: [] }), essayCtx);
    expect(failing(result)).toContain("human_voice");
    const detail = result.checks.find((c) => c.id === "human_voice")?.detail ?? "";
    for (const tell of ["the framing opener", "from idea to live", "this is where X comes in", "consider…", "genuinely", "the essay closer"]) {
      expect(detail, tell).toContain(tell);
    }
  });

  it("blocks the setup-and-pivot: 'A and B are solid for X. However, the real gains come from Y'", () => {
    const result = auditDraft(draft({ body: ESSAY_PIVOT, linkUrl: "https://gettrafficfa.st/", claims: [] }), {
      ...essayCtx,
      thread: { ...essayCtx.thread, title: "What are the best tools/hacks for content writing?", excerpt: "Grammarly, Scrivener." },
      angle: "Check how the draft gets from the editor into the CMS before choosing.",
    });
    expect(failing(result)).toContain("human_voice");
    const detail = result.checks.find((c) => c.id === "human_voice")?.detail ?? "";
    for (const tell of ["the setup-and-pivot", "the impact line", "the cliché", "consider…"]) expect(detail, tell).toContain(tell);
  });

  it("counts a summing-up, a chain of questions and a forty-word sentence as tells", () => {
    const summing = auditDraft(draft({ body: `${GOOD_BODY} Ultimately, the structure is what the engines read.` }), ctx);
    expect(summing.checks.find((c) => c.id === "human_voice")?.detail).toContain("the summing-up");

    const questions = auditDraft(
      draft({ body: `${GOOD_BODY} Who writes it? Who checks the headings? Who measures the citations? Nobody, usually.` }),
      ctx
    );
    expect(questions.checks.find((c) => c.id === "human_voice")?.detail).toContain("a chain of questions");

    const long = auditDraft(
      draft({
        body: `${GOOD_BODY} And when the section structure is finally in place across the whole site and the headings have all been rewritten as questions and the engines have had a few weeks to crawl it again you can start comparing the citation samples week over week.`,
      }),
      ctx
    );
    expect(long.checks.find((c) => c.id === "human_voice")?.detail).toMatch(/a \d+-word sentence/);
  });

  it("does not read a short reply that ends on a concrete point, or a plain closing question, as the essay closer", () => {
    const short = auditDraft(
      draft({
        variant: "short_comment",
        body: `Answer engines retrieve passages, not pages, so make every section answer its own question in the first two sentences. Then ask ChatGPT and Perplexity your pages' questions and record whether your domain is cited. Do it per engine, since they rarely agree.`,
      }),
      ctx
    );
    expect(short.checks.find((c) => c.id === "human_voice")?.status).toBe("pass");
    expect(auditDraft(draft(), ctx).checks.find((c) => c.id === "human_voice")?.status).toBe("pass");
  });
});

describe("auditDraft: length as the platform measures it", () => {
  it("shortens an X reply that is a few characters over, and never drops a URL to do it", () => {
    const over =
      "Make every section answer its own question in its first two sentences; that's the passage the engines lift. Then ask ChatGPT and Perplexity the questions your pages answer and write down which domains they cite, engine by engine. What does your heading structure look like right now?";
    expect(xLength(over)).toBeGreaterThan(X_LIMIT);
    const fitted = fitXLength(over);
    expect(xLength(fitted)).toBeLessThanOrEqual(X_LIMIT);
    const result = auditDraft(draft({ variant: "short_comment", body: fitted, claims: [] }), {
      ...ctx,
      thread: { ...ctx.thread, surface: "x", kind: "post" },
    });
    expect(result.checks.find((c) => c.id === "platform_fit")?.status).toBe("pass");
    // A URL is never what gets cut; the gate refuses it in a reply anyway.
    expect(fitXLength(`${over} https://gettrafficfa.st/`)).toContain("https://gettrafficfa.st/");
  });

  it("does not refuse a list entry for opening on the project it adds", () => {
    const body = `* [GetTrafficFast](${SITE}) - An AI agent for autonomous SEO content creation and publishing, from research to daily articles.

This PR adds GetTrafficFast to the list of AI autonomous agents. It covers keyword research, daily article generation, and direct publishing to websites.`;
    const result = auditDraft(
      draft({
        variant: "github_pr_proposal",
        body,
        linkUrl: SITE,
        claims: [
          { text: "An AI agent for autonomous SEO content creation", basis: "business_profile" },
          { text: "It covers keyword research", basis: "business_profile" },
          { text: "direct publishing to websites", basis: "business_profile" },
        ],
      }),
      { ...ctx, thread: { ...ctx.thread, surface: "github", kind: "repository" } }
    );
    expect(result.checks.find((c) => c.id === "answers_first")?.status).toBe("pass");
    expect(failing(result)).not.toContain("human_voice");
  });

  it("counts a link as 23 characters on X, as X does", () => {
    const xCtx = { ...ctx, thread: { ...ctx.thread, surface: "x", kind: "post" } };
    const url = "https://gettrafficfa.st/blog/answer-first-sections-for-answer-engines";
    const body = `Make every section answer its own question in its first two sentences; that's what the engines retrieve, and the passage checklist I keep for it sits at ${url} if it helps. Question-shaped headings help too, by the way.`;
    expect(body.length).toBeGreaterThan(280);
    const result = auditDraft(draft({ variant: "short_comment", body, linkUrl: url }), xCtx);
    expect(result.checks.find((c) => c.id === "platform_fit")?.status).toBe("pass");

    const over = auditDraft(draft({ variant: "short_comment", body: `${body} And record whether your domain shows up in the sources, engine by engine.`, linkUrl: url }), xCtx);
    expect(over.checks.find((c) => c.id === "platform_fit")?.status).toBe("fail");
    expect(over.checks.find((c) => c.id === "platform_fit")?.detail).toContain("a link counting as 23");
  });

  it("refuses a two-sentence X reply whose second sentence is the mention, and passes its first sentence alone", () => {
    // The shape of every X reply published: the answer, then the product with its link.
    const xCtx = { ...ctx, thread: { ...ctx.thread, surface: "x", kind: "post" } };
    const answer = "Make every section answer its own question in its first two sentences, then ask the engines those questions and record who they cite.";
    const pitched = auditDraft(
      draft({ variant: "short_comment", body: `${answer} The recording bit is what I use GetTrafficFast (${SITE}) for, so that's my bias.`, linkUrl: SITE }),
      xCtx
    );
    expect(pitched.status).toBe("blocked");
    expect(failing(pitched)).toEqual(expect.arrayContaining(["names_business", "human_voice", "link"]));
    expect(auditDraft(draft({ variant: "short_comment", body: answer, claims: [] }), xCtx).status).toBe("passed");
  });
});

describe("withoutLink", () => {
  it("removes the sentence carrying the link", () => {
    expect(withoutLink("First point. See https://x.test/a for more. Second point.", "https://x.test/a")).toBe("First point. Second point.");
  });
});

/**
 * 9 November 2026. The owner pasted @abel_codes's post and the drafter
 * (version 16) wrote the reply below. It passed the gate; he read it as AI
 * at once, and he was right. His notes asked for lowercase. The reply he had
 * posted an hour earlier, under Daniel's post, was the one he liked. Both are
 * kept verbatim.
 */
const ALEX_POST =
  'i saw review on X about one tool to find customers and i was like "WTF?? boolshit! does it even work???" so i decided to run the experiment 1) i registered on <link> 2) i found communities w my target audience 3) i set up the campaigns to run on autopilot rn...';
const ALEX_DRAFT =
  "It's tough to tell if these tools work without knowing if the audience is actually ready to buy. Finding them is one thing, but are they actively looking for a solution? That's the real test.";
/** What was posted: the draft, plus the line he added, typed on a phone (curly apostrophes). */
const ALEX_POSTED = `${ALEX_DRAFT} I’m not good at doing the test I’m just thinking out loud ahahah`;
const DANIEL_POST =
  "Honest numbers might be holding my product back. Kind of sad, but it seems true. Marketing seems to need a bit of exaggeration. I'd rather see if I can make it work without. I make enough to live on.";
const DANIEL_REPLY =
  "Not naive at all. I'm getting 200+ impressions on my blog now, still zero clicks. Honest numbers take time to compound. What kind of numbers are you seeing?";
const OWNER_ABOUT =
  "Former agency designer, learned to code at night. Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026. Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40. Left Porto on Oct 27 2026, working from Taipei.";
const OWNER_NOTES =
  "Lowercase, short lines, like a reply typed on a phone. One idea per reply. Lead with a number or a concrete thing I did. Never name a product, never a link. No em dashes, no hashtags, no 'great post', no lists. Disagree when I disagree. Ask one precise question when I have nothing to add.";

const xPost = (excerpt: string, notes = ""): AuditContext => ({
  thread: { surface: "x", kind: "post", title: excerpt.slice(0, 80), excerpt },
  business: { name: "GetTrafficFast", domains: ["gettrafficfa.st"], brandNames: [] },
  angle: null,
  expertise: ["ai seo", "answer engine optimization"],
  writer: { aboutYou: OWNER_ABOUT, instructions: notes },
});
const xReply = (body: string): DraftForAudit => ({ variant: "short_comment", body, linkUrl: null, claims: [] });
const tellNames = (body: string) => tellsIn(body, "short_comment").map((tell) => tell.replace(/ \(".*$/, ""));

describe("auditDraft: the tells of the X reply of 9 November 2026", () => {
  it("names each new tell in the sentences that carried it, and in the forms a model reaches for next", () => {
    const cases: Array<[string, string]> = [
      ["It's tough to tell if these tools work without knowing if the audience is actually ready to buy.", "it's hard to tell if"],
      ["It's hard to say whether this scales past ten clients.", "it's hard to tell if"],
      ["It’s really difficult to know if anyone reads them.", "it's hard to tell if"],
      ["Finding them is one thing, but are they actively looking for a solution?", "X is one thing, but Y"],
      ["Building it is one thing; selling it is another.", "X is one thing, but Y"],
      ["Writing is one thing. Distribution is another.", "X is one thing, but Y"],
      ["It's one thing to find customers, it's another to keep them.", "X is one thing, but Y"],
      ["Do they buy? That's the real test.", "that's the real test"],
      ["Clicks are vanity. That’s the real question.", "that's the real test"],
      ["The real question is whether they come back.", "the real power"],
      ["The real test is the second purchase.", "the real power"],
      ["Here's the thing: nobody clicks past page one.", "here's the thing"],
      ["Here is the thing. Most of them never reply.", "here's the thing"],
      ["The key is to post every day for a month.", "the key is"],
      ["The key thing is consistency.", "the key is"],
      ["At the end of the day, people buy from people.", "the summing-up"],
      ["People buy from people at the end of the day.", "the summing-up"],
      ["This one was a game changer for my outreach.", "game-changer"],
      ["Honestly a game-changer.", "game-changer"],
    ];
    for (const [sentence, tell] of cases) expect(tellNames(sentence), sentence).toContain(tell);
  });

  it("reads a short verdict after a rhetorical question as a tell, and a question left standing as none", () => {
    expect(tellNames("Are they actually looking for a solution? That's the real test.")).toContain("a verdict after a question");
    expect(tellNames("Do you track it per engine? That's what matters.")).toContain("a verdict after a question");
    expect(tellNames("Do you write it down first? Mine are gone by breakfast.")).toEqual([]);
    expect(tellNames("Do you track it per engine? That's the part most people skip because the dashboards average it away.")).toEqual([]);
    expect(tellNames("That's the real test.")).not.toContain("a verdict after a question");
  });

  it("leaves ordinary sentences alone", () => {
    for (const sentence of [
      "There's one thing I'd add: put the due date in the subject line.",
      "There is one thing, but it matters: the date.",
      "That's one thing I check first.",
      "It's one thing I keep forgetting.",
      "It's hard to say no to a client who pays on time.",
      "It's hard to tell from the screenshot.",
      "Here's the thing I keep in my notes for this.",
      "The API key is in the env file, and the key is stored in the vault.",
      "Where the key is kept matters less than who can read it.",
      "The real reason was the price.",
      "That's the real Taipei for you, noisy and cheap.",
      "The end of the day is when I write.",
      "What kind of numbers are you seeing?",
      DANIEL_REPLY,
      "i’m not good at doing the test i’m just thinking out loud ahahah",
      "Changing the game plan took a week.",
    ]) {
      expect(tellNames(sentence), sentence).toEqual([]);
    }
  });

  it("refuses the draft of 9 November with every tell named, and sends it to the rewrite", () => {
    const result = auditDraft(xReply(ALEX_DRAFT), xPost(ALEX_POST, OWNER_NOTES));
    expect(result.status).toBe("blocked");
    expect(failing(result)).toEqual(["human_voice"]);
    const detail = result.checks.find((c) => c.id === "human_voice")?.detail ?? "";
    expect(detail).toContain(`it's hard to tell if ("It's tough to tell if")`);
    expect(detail).toContain(`X is one thing, but Y ("is one thing, but")`);
    expect(detail).toContain(`that's the real test ("That's the real test")`);
    expect(detail).toContain(`a verdict after a question ("That's the real test.")`);
    // Sentence case under notes that ask for lowercase: named for the rewrite too.
    const notes = result.checks.find((c) => c.id === "follows_your_notes");
    expect(notes?.status).toBe("warn");
    expect(notes?.detail).toContain('3 of 3 sentences start with a capital ("It\'s tough to…", "Finding them is…", "That\'s the real…")');
    expect(result.checks.filter(asksForRewrite).map((c) => c.id)).toEqual(["human_voice", "follows_your_notes"]);

    // What he posted, his line added on a phone, carries the same tells: the
    // curly apostrophes he typed are read as the plain ones.
    const posted = auditDraft(xReply(ALEX_POSTED), xPost(ALEX_POST, OWNER_NOTES));
    expect(posted.status).toBe("blocked");
    expect(withoutTells(ALEX_POSTED, "short_comment")).toBe("I’m not good at doing the test I’m just thinking out loud ahahah");
    expect(withoutTells(ALEX_DRAFT, "short_comment")).toBe("");
  });

  it("still passes the reply he posted under Daniel's post, with what About you records", () => {
    const result = auditDraft(xReply(DANIEL_REPLY), xPost(DANIEL_POST));
    expect(result.status).toBe("passed");
    expect(result.checks.find((c) => c.id === "human_voice")?.status).toBe("pass");
    // Under his lowercase notes it is still a pass, with the note as a
    // warning the rewrite would follow: a style rule never blocks.
    const underNotes = auditDraft(xReply(DANIEL_REPLY), xPost(DANIEL_POST, OWNER_NOTES));
    expect(underNotes.status).toBe("passed");
    expect(underNotes.checks.filter((c) => c.status !== "pass" && !isAdvisory(c)).map((c) => c.id)).toEqual(["follows_your_notes"]);
  });
});

describe("auditDraft: follows your notes (lowercase)", () => {
  const notes = (instructions: string, body: string, variant: DraftForAudit["variant"] = "short_comment") =>
    auditDraft({ ...xReply(body), variant }, xPost(DANIEL_POST, instructions)).checks.find((c) => c.id === "follows_your_notes");

  it("warns on sentence case when the notes ask for lowercase, and passes the same reply in lowercase", () => {
    expect(notes(OWNER_NOTES, DANIEL_REPLY)?.status).toBe("warn");
    const lower = notes(OWNER_NOTES, "not naive at all. 342 impressions last week, still zero clicks. what kind of numbers are you seeing?");
    expect(lower).toMatchObject({ status: "pass", detail: "Lowercase, as your notes ask." });
  });

  it("does not count the pronoun, a number, an acronym or a name with inner capitals as sentence case", () => {
    expect(notes(OWNER_NOTES, "I'm getting 200+ impressions now. 342 last week. AI answers never cite me. GitHub stars don't pay rent.")?.status).toBe("pass");
    expect(notes(OWNER_NOTES, "i’m in taipei now. Taipei wifi is fine. still zero clicks though.")?.status).toBe("pass");
  });

  it("reads only lowercase, only on a short reply, and only when the notes ask for it", () => {
    expect(notes("", DANIEL_REPLY)).toMatchObject({ status: "pass", detail: "No notes recorded in Settings → Voice." });
    expect(notes("Never name a product.", DANIEL_REPLY)?.status).toBe("pass");
    expect(notes("Never write in lowercase.", DANIEL_REPLY)?.status).toBe("pass");
    expect(notes(OWNER_NOTES, `${DANIEL_REPLY} ${DANIEL_REPLY} ${DANIEL_REPLY}`, "detailed_answer")).toMatchObject({
      status: "pass",
      detail: "Lowercase is checked on a short reply only.",
    });
    // A context with no notes at all (an older caller) gets the same pass.
    const noWriter = auditDraft(xReply(DANIEL_REPLY), { ...xPost(DANIEL_POST), writer: { aboutYou: OWNER_ABOUT } });
    expect(noWriter.checks.find((c) => c.id === "follows_your_notes")?.status).toBe("pass");
  });

  it("is a style rule: the rewrite is asked to follow it, the verdict never counts it", () => {
    const check = notes(OWNER_NOTES, DANIEL_REPLY);
    expect(check).toBeDefined();
    expect(STYLE_CHECKS.has("follows_your_notes")).toBe(true);
    expect(countsTowardVerdict(check!)).toBe(false);
    expect(asksForRewrite(check!)).toBe(true);
    expect(isAdvisory(check!)).toBe(false);
  });
});

describe("auditDraft: the advisory flag", () => {
  it("sets advisory on every check, true only for the advisory ones, so the inbox can show a note as a note", () => {
    const result = auditDraft(draft(), { ...ctx, expertise: ["cast iron", "sourdough"] });
    expect(result.checks.every((check) => typeof check.advisory === "boolean")).toBe(true);
    expect(result.checks.filter((check) => check.advisory).map((check) => check.id)).toEqual(["business_coherence"]);
    const coherence = result.checks.find((c) => c.id === "business_coherence")!;
    expect(coherence).toMatchObject({ status: "warn", advisory: true });
    expect(asksForRewrite(coherence)).toBe(false);
    expect(result.status).toBe("passed");
  });

  it("reads an audit stored before the flag by the check's id", () => {
    expect(isAdvisory({ id: "business_coherence" })).toBe(true);
    expect(isAdvisory({ id: "human_voice" })).toBe(false);
    expect(isAdvisory({ id: "human_voice", advisory: true })).toBe(true);
  });
});

describe("promotesBusiness and straightQuotes", () => {
  it("recognises the advert-shaped replies posted in October, and not the replies that name nothing", () => {
    const names = ["GetTrafficFast"];
    for (const posted of [
      "Does your Claude skill check uniqueness across those five sites? Tailoring each article for its audience and SEO intent prevents dilution. GetTrafficFast (https://gettrafficfa.st/) is what I use for that.",
      "Even with a great AI toolkit, professionals still need to factor in human review for brand voice. I make sure to do that for my own site's blog posts, which I publish through GetTrafficFast (https://gettrafficfa.st/).",
      "Full 90-100% SEO automation is tough. GetTrafficFast is what I use for that.",
      "Make every section answer first. Details at https://example.com/post.",
      "I work on a tool for this, full disclosure.",
    ]) {
      expect(promotesBusiness(posted, names), posted).toBe(true);
    }
    expect(promotesBusiness(DANIEL_REPLY, names)).toBe(false);
    expect(promotesBusiness(ALEX_POSTED, names)).toBe(false);
  });

  it("turns typographic apostrophes into the plain one without moving anything", () => {
    expect(straightQuotes("It’s tough ‘here’")).toBe("It's tough 'here'");
    expect(straightQuotes(ALEX_POSTED)).toHaveLength(ALEX_POSTED.length);
  });
});


describe("a short reply that answers the post in its own words (2026-11-12)", () => {
  // The @hank_ships post about being called a grifter, and a reply on its
  // point that shares almost none of its words. It was blocked, with
  // "every, someone, calls, charging" offered as the words to use.
  const hank = {
    ...ctx,
    thread: {
      surface: "x",
      kind: "post",
      title: "Every few weeks someone calls me a grifter for charging money, as if I'm trying to milk my followers.",
      excerpt:
        "Every few weeks someone calls me a grifter for charging money, as if I'm trying to milk my followers. It stings every time, because I mostly build for the fun of it. Everyone is chasing the AI gold rush and investors are writing big checks,",
    },
    angle: null,
    writer: { aboutYou: "" },
  };

  it("is never blocked for using different words, and suggests the post's subject words, not its filler", () => {
    const result = auditDraft(
      draft({
        variant: "short_comment",
        body: "i get it. building software and seeing people pay for it is a rare kind of satisfaction. it's cool you still feel that after all these users.",
        claims: [],
      }),
      hank
    );
    const check = result.checks.find((c) => c.id === "specific_angle");
    expect(check?.status).not.toBe("fail");
    expect(check?.detail ?? "").not.toMatch(/\bsometimes\b|\bcalling\b|\bsaying\b|\btrying\b/);
  });

  it("passes when the reply shares one word with the post", () => {
    const result = auditDraft(
      draft({ variant: "short_comment", body: "being called a grifter for charging money is wild. people pay because it saves them time.", claims: [] }),
      hank
    );
    expect(result.checks.find((c) => c.id === "specific_angle")?.status).toBe("pass");
  });
});
