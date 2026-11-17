import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ArticleFactsField, StaleFactLines } from "@/components/settings/voice-settings-form";

describe("Facts for articles (12 November 2026)", () => {
  it("says what the field is for, and holds 2,000 characters", () => {
    const html = renderToStaticMarkup(<ArticleFactsField value="I build GetTrafficFast." onChange={() => {}} />);
    expect(html).toContain("True things your articles may state about you and your business.");
    expect(html).toContain("Leave out what you would not want on your public blog.");
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain("23/2,000");
  });
});

/**
 * Settings → Voice, the lines under About you. Pinned: one quiet line for
 * each sentence dated more than 30 days ago, in plain English with the
 * sentence quoted short, and nothing at all when no fact is stale. It asks;
 * it has no button and no field, so it can neither edit the text nor stop a
 * save.
 */

const OWNER_ABOUT =
  "Former agency designer, learned to code at night. Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026. Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40. Left Porto on Oct 27 2026, working from Taipei.";

const render = (aboutYou: string, day: string) => renderToStaticMarkup(<StaleFactLines aboutYou={aboutYou} now={new Date(`${day}T09:30:00Z`)} />);

describe("the stale lines under About you", () => {
  it("asks about the one fact that is over 30 days old on 10 November 2026", () => {
    const html = render(OWNER_ABOUT, "2026-11-10");
    expect(html.match(/<li/g)).toHaveLength(1);
    expect(html).toContain("Dated October 2026 (last month): still true?");
    expect(html).toContain("Co-founded Postwren, email marketing for Shopify stores: 12…");
    // Readable on a phone: 12px, never smaller.
    expect(html).toContain("text-xs");
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
  });

  it("adds a line for each fact as it ages, with the day for a dated day", () => {
    const html = render(OWNER_ABOUT, "2026-11-27");
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).toContain("Dated the week of Oct 26, 2026 (32 days ago): still true?");
    expect(html).toContain("Dated Oct 27, 2026 (31 days ago): still true?");
  });

  it("renders nothing when no fact is stale", () => {
    expect(render("", "2026-11-10")).toBe("");
    expect(render("I run a two-person bakery.", "2026-11-10")).toBe("");
    expect(render("40 signups on Nov 3 2026.", "2026-11-10")).toBe("");
  });

  it("a fact confirmed on Today is not asked about, and shows 'confirmed Nov 14' on one small line", () => {
    const confirmations = { "co-founded postwren, email marketing for shopify stores: 12 paying stores in october 2026": "2026-11-14" };
    const html = renderToStaticMarkup(<StaleFactLines aboutYou={OWNER_ABOUT} now={new Date("2026-11-20T09:30:00Z")} confirmations={confirmations} />);
    expect(html).not.toContain("still true?");
    expect(html.match(/<li/g)).toHaveLength(1);
    expect(html).toContain("confirmed Nov 14");
    expect(html).not.toContain("Nov 14, 2026");
    expect(html).toContain("truncate");
    // The words as the person wrote them: nothing about the confirmation is in the text.
    expect(OWNER_ABOUT).not.toMatch(/still true on/);
    // Edited in the box, the sentence is other words: the confirmation no longer applies.
    const edited = OWNER_ABOUT.replace("12 paying stores", "14 paying stores");
    const after = renderToStaticMarkup(<StaleFactLines aboutYou={edited} now={new Date("2026-11-20T09:30:00Z")} confirmations={confirmations} />);
    expect(after).toContain("Dated October 2026 (last month): still true?");
    expect(after).not.toContain("confirmed");
  });

  it("only asks: no button, no field, no internal name", () => {
    const html = render(OWNER_ABOUT, "2026-11-27");
    expect(html).not.toMatch(/<button|<input|<textarea|role="dialog"|role="alert"/);
    expect(html).not.toMatch(/staleFacts|yearAssumed|precision|STALE_AFTER_DAYS/);
  });
});
