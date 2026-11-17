import { describe, expect, it } from "vitest";
import { auditDraft, type AuditContext, type DraftForAudit } from "@/lib/placements/audit";
import { factProblems, otherVenture } from "@/lib/placements/fact-fit";
import { problemsOf } from "@/lib/jobs/workflows/placement-draft";
import { factKey } from "@/lib/voice/staleness";

/**
 * A fact from About you is used only where it fits the post.
 *
 * The case, 10 November 2026, on the GetTrafficFast site: About you held a
 * figure about another product, the notes said "Lead with a number", and
 * the reply to a post about a hackathon judged by paying customers led with
 * that figure. It passed every check. What is pinned: that draft is refused
 * now, with a sentence a person can act on, and a fact about this site on a
 * post about its subject still passes.
 */

/** The owner's About you and notes, as they stood. */
const OWNER_ABOUT =
  "Former agency designer, learned to code at night. Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026. Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40. Left Porto on Oct 27 2026, working from Taipei.";
const OWNER_NOTES =
  "Lowercase, short lines, like a reply typed on a phone. One idea per reply. Lead with a number or a concrete thing I did. Never name a product, never a link. No em dashes, no hashtags, no 'great post', no lists. Disagree when I disagree. Ask one precise question when I have nothing to add.";

/** The draft the gate passed, word for word. */
const REAL_DRAFT = "12 paying stores for my own thing felt like real validation. letting customers decide is a smart way to run a hackathon.";

/**
 * The post, by its subject: a hackathon judged by paying customers. Its
 * exact wording was not kept with the report, so this is the subject as the
 * owner described it, not a quotation.
 */
const HACKATHON_POST = "we ran a hackathon where the judges were our paying customers. they picked what ships.";

/** A post about this site's subject, and the reply the owner posted under one like it. */
const SEO_POST =
  "Is SEO still worth it for a brand new blog? Three months of articles and Google sends me nothing. Do impressions ever turn into clicks?";
const SEO_REPLY = "not dead, just slow. 342 impressions on my blog in one week, still 0 clicks. what position do your articles sit at?";

const NOW = new Date("2026-11-10T09:30:00Z");

const xPost = (excerpt: string, over: Partial<AuditContext> = {}): AuditContext => ({
  thread: { surface: "x", kind: "post", title: excerpt.slice(0, 80), excerpt },
  business: { name: "GetTrafficFast", domains: ["gettrafficfa.st"], brandNames: [] },
  angle: null,
  expertise: ["ai seo", "answer engine optimization"],
  writer: { aboutYou: OWNER_ABOUT, instructions: OWNER_NOTES },
  now: NOW,
  ...over,
});
const xReply = (body: string, claims: DraftForAudit["claims"] = []): DraftForAudit => ({ variant: "short_comment", body, linkUrl: null, claims });
const claimsCheck = (result: ReturnType<typeof auditDraft>) => result.checks.find((check) => check.id === "verifiable_claims");

const fit = (body: string, post: string, over: Partial<Parameters<typeof factProblems>[0]> = {}) =>
  factProblems({
    body,
    aboutYou: OWNER_ABOUT,
    thread: { title: post.slice(0, 80), excerpt: post },
    businessName: "GetTrafficFast",
    ownNames: ["GetTrafficFast", "gettrafficfa"],
    expertise: ["ai seo"],
    now: NOW,
    ...over,
  });

describe("the reply of 10 November 2026", () => {
  it("is refused: a fact about another product, on a post that is not about it", () => {
    const result = auditDraft(xReply(REAL_DRAFT, [{ text: "12 paying stores", basis: "business_profile" }]), xPost(HACKATHON_POST));
    expect(result.status).toBe("blocked");
    const check = claimsCheck(result);
    expect(check?.status).toBe("fail");
    expect(check?.label).toBe("Nothing invented, and your own facts only where they fit");
    // A sentence a person can act on, first in the line.
    expect(check?.detail).toMatch(/^Uses a fact about another product: "12 paying stores" is about Postwren in About you/);
    expect(check?.detail).toContain("this reply is written for GetTrafficFast");
    expect(check?.detail).toContain("Leave the number out and put no other number in its place.");
    // It was the only thing wrong with it: every other counted check passes.
    expect(result.checks.filter((c) => c.status === "fail").map((c) => c.id)).toEqual(["verifiable_claims"]);
  });

  it("would have passed without the check: the same draft, with nothing about Postwren recorded", () => {
    const about = OWNER_ABOUT.replace("Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026. ", "");
    const result = auditDraft(xReply(REAL_DRAFT), xPost(HACKATHON_POST, { writer: { aboutYou: about, instructions: OWNER_NOTES } }));
    expect(claimsCheck(result)?.status).toBe("pass");
  });

  it("hands the rewrite that sentence, so the next write leaves the number out", () => {
    const result = auditDraft(xReply(REAL_DRAFT), xPost(HACKATHON_POST));
    expect(problemsOf(result)[0]).toContain('Uses a fact about another product: "12 paying stores"');
  });

  it("is refused whatever the day: the clock only adds the question about a date", () => {
    const result = auditDraft(xReply(REAL_DRAFT), xPost(HACKATHON_POST, { now: undefined }));
    expect(claimsCheck(result)?.detail).toContain("Uses a fact about another product");
  });

  it("is refused in the forms a model reaches for next", () => {
    for (const body of [
      "twelve paying stores taught me more than any judge could. letting customers decide is the smart way to run a hackathon.",
      "i got to 12 paying stores by letting customers decide. a hackathon judged that way makes sense to me.",
      // Saying what it counts does not make it this site's fact.
      "12 paying stores on my email marketing tool felt like validation. letting customers judge a hackathon is smart.",
    ]) {
      expect(fit(body, HACKATHON_POST).map((problem) => problem.kind), body).toEqual(["other_product"]);
    }
  });
});

describe("a fact that fits", () => {
  it("passes a fact about this site's own blog on a post about SEO", () => {
    const result = auditDraft(
      xReply(SEO_REPLY, [{ text: "342 impressions on my blog in one week, still 0 clicks", basis: "business_profile" }]),
      xPost(SEO_POST)
    );
    expect(claimsCheck(result)?.status).toBe("pass");
    expect(result.status).toBe("passed");
    expect(fit(SEO_REPLY, SEO_POST)).toEqual([]);
  });

  it("passes a fact that names this site as its subject", () => {
    const about = "I publish my own site's blog through GetTrafficFast: 40 articles as of the week of Nov 2 2026, 342 impressions a week.";
    const body = "40 articles in and 342 impressions a week on my blog. slow, but it moves. how many have you published?";
    expect(fit(body, SEO_POST, { aboutYou: about })).toEqual([]);
    expect(otherVenture(about, ["GetTrafficFast"])).toBeNull();
  });

  it("lets the other product's fact through when the post is about that product's market", () => {
    const post = "what do people use for email marketing on shopify? klaviyo is getting expensive for small stores.";
    const body = "i co-founded a tool for exactly this. back in october we had 12 paying stores, all of them leaving klaviyo over price.";
    expect(fit(body, post)).toEqual([]);
    // Named outright, it is about it too.
    expect(fit("12 paying stores back in october, so still early.", "anyone tried postwren? is it any good")).toEqual([]);
  });

  it("says nothing about a draft that uses no number from About you", () => {
    expect(fit("letting customers decide is a smart way to run a hackathon. did they agree with each other?", HACKATHON_POST)).toEqual([]);
    // The same digit counting something else is not the fact.
    expect(fit("7 days is a short hackathon. did the customers judge the demos or the code?", HACKATHON_POST)).toEqual([]);
    expect(fit(REAL_DRAFT, HACKATHON_POST, { aboutYou: "" })).toEqual([]);
  });
});

describe("a number the reader cannot place", () => {
  const about = "An AI pipeline writes my blog: 342 impressions in the week of Oct 26 2026, still 0 clicks.";

  it("is refused when neither the post nor the reply says what it counts", () => {
    const [problem] = fit("342 in one week felt like real validation. letting customers decide is smart.", HACKATHON_POST, { aboutYou: about });
    expect(problem).toMatchObject({ kind: "no_subject", quote: "342 in one week" });
    expect(problem.detail).toContain('Uses a number the reader cannot place: "342 in one week" comes from About you');
    expect(problem.detail).toContain("Say what it is in plain words, or leave the number out.");
  });

  it("passes once the reply says what it counts, or the post is about it", () => {
    expect(fit("342 impressions on my blog in one week felt like validation too.", HACKATHON_POST, { aboutYou: about })).toEqual([]);
    expect(fit("342 in one week here, still nothing to show for it.", SEO_POST, { aboutYou: about })).toEqual([]);
  });
});

describe("a dated fact stated as current", () => {
  const post = "what do people use for email marketing on shopify? klaviyo is getting expensive for small stores.";

  it("is refused when the fact is over 30 days old and the reply does not say when", () => {
    const [problem] = fit("we have 12 paying stores on our email tool, all of them leaving klaviyo over price.", post);
    expect(problem).toMatchObject({ kind: "stale_as_current", quote: "12 paying stores" });
    expect(problem.detail).toBe(
      'States a dated fact as current: "12 paying stores" is dated October 2026 in About you. Say when it was true ("in October I had…"), or leave it out.'
    );
    const result = auditDraft(xReply("we have 12 paying stores on our email tool, all of them leaving klaviyo over price."), xPost(post));
    expect(claimsCheck(result)?.status).toBe("fail");
  });

  it("passes once the reply says when", () => {
    for (const body of [
      "in october we had 12 paying stores on our email tool, all leaving klaviyo over price.",
      "we had 12 paying stores last month, all leaving klaviyo over price.",
      "12 paying stores as of Oct 2026, all leaving klaviyo over price.",
    ]) {
      expect(fit(body, post), body).toEqual([]);
    }
  });

  it("is not asked of a fact confirmed as still true on Today within 30 days, and is again after", () => {
    const body = "we have 12 paying stores on our email tool, all of them leaving klaviyo over price.";
    const confirmations = { [factKey("Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026.")]: "2026-11-09" };
    expect(fit(body, post, { confirmations })).toEqual([]);
    const result = auditDraft(xReply(body), xPost(post, { writer: { aboutYou: OWNER_ABOUT, instructions: OWNER_NOTES, confirmedFacts: confirmations } }));
    expect(claimsCheck(result)?.status).toBe("pass");
    // 31 days after the confirmation: asked again; saying the day it was confirmed is saying when.
    const later = new Date("2026-12-10T09:30:00Z");
    expect(fit(body, post, { confirmations, now: later }).map((problem) => problem.kind)).toEqual(["stale_as_current"]);
    expect(fit("in november we had 12 paying stores on our email tool, all leaving klaviyo.", post, { confirmations, now: later })).toEqual([]);
  });

  it("is not asked of a fact still fresh, or with no clock", () => {
    // The blog's numbers are dated 15 days ago on 10 November.
    expect(fit(SEO_REPLY, SEO_POST)).toEqual([]);
    expect(fit("we have 12 paying stores on our email tool, all leaving klaviyo.", post, { now: undefined })).toEqual([]);
    // The same reply, once the week of Oct 26 is over 30 days old.
    expect(fit(SEO_REPLY, SEO_POST, { now: new Date("2026-11-27T00:00:00Z") }).map((problem) => problem.kind)).toEqual(["stale_as_current"]);
  });
});

describe("otherVenture", () => {
  it("reads the product a sentence says the writer owns or builds", () => {
    const own = ["GetTrafficFast", "Get Traffic Fast", "gettrafficfa"];
    expect(otherVenture("Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026.", own)).toBe("Postwren");
    expect(otherVenture("I run Acme Labs with two friends.", own)).toBe("Acme Labs");
    expect(otherVenture("Founder of Tallyhold.", own)).toBe("Tallyhold");
    expect(otherVenture("Postwren has 12 paying stores.", own)).toBe("Postwren");
    expect(otherVenture("I work on Postwren's deliverability.", own)).toBe("Postwren");
  });

  it("is not this site, a place, a platform merely used, an acronym or a topic", () => {
    const own = ["GetTrafficFast", "Get Traffic Fast", "gettrafficfa"];
    expect(otherVenture("I built GetTrafficFast.", own)).toBeNull();
    expect(otherVenture("I run Get Traffic Fast's blog.", own)).toBeNull();
    expect(otherVenture("Left Porto on Oct 27 2026, working from Taipei.", own)).toBeNull();
    expect(otherVenture("I rank on Google for 12 keywords.", own)).toBeNull();
    expect(otherVenture("I work on SEO for small shops.", own)).toBeNull();
    expect(otherVenture("I work on Answer Engine Optimization.", own, ["answer engine optimization"])).toBeNull();
    expect(otherVenture("I run 3 Shopify stores.", own)).toBeNull();
    expect(otherVenture("We made 40 sales.", own)).toBeNull();
    // A lowercase name cannot be told from a word: left to the prompt.
    expect(otherVenture("co-founded postwren, email marketing.", own)).toBeNull();
  });
});
