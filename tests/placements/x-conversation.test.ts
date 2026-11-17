import { describe, expect, it } from "vitest";
import { X_EXCLUDED_WORDS, xConversationPhrases, xNoiseRule, xPostShape } from "@/lib/placements/x-conversation";

/**
 * The X pre-filter: rules alone, before the paid qualifier. The negatives
 * are the kinds the qualifier rejected on the first two production runs
 * (2026-11-12 and 2026-11-13), real-shaped, with names and links changed;
 * the positives are the posts it qualified then, and plain questions.
 */

const judge = (text: string, language = "en") => xNoiseRule({ title: text.slice(0, 200), excerpt: text }, language);
const rule = (text: string, language = "en") => judge(text, language)?.status === "rejected" ? (judge(text, language) as { rule: string }).rule : null;

describe("adverts, sales, courses, hiring: x_promo", () => {
  it.each([
    [
      "an agency advertising its service",
      "Your brand deserves more than just an online presence. It deserves to be found, followed and remembered.\n\nAt Acmestorms, our Social Media Optimization (SMO) and Search Engine Optimization (SEO) services help your business strengthen its online presence. https://t.co/aaaa",
    ],
    [
      "a sign-up form for early access",
      "FREE Early Access to https://t.co/bbbb!\n\nFind out how AI sees your business across ChatGPT, Gemini and Perplexity.\n\nVisit https://t.co/cccc, fill out the form and our team will reach out.\n\n#AIVisibility #FreeEarlyAccess https://t.co/dddd",
    ],
    [
      "free courses (styled letters)",
      "All Paid Courses (Free for First 4500 People)\n\n 𝗣𝗮𝗶𝗱 𝗖𝗼𝘂𝗿𝘀𝗲 𝗙𝗥𝗘𝗘 (PART - 2)\n 1. Artificial Intelligence\n 2. Machine Learning\n 3. Prompt Engineering\n 4. Claude, Chatgpt, Grok\n5. Data Analytics https://t.co/eeee",
    ],
    [
      "a request to buy subscriptions",
      "badly needed po! 🥹\n\nwtb netflix disney wow presents chatgpt gemini claude ai nba league pass prime scribd\n\n⚆ legally pa!d and stable! 🙏\n⚆ can do asap &amp; rush",
    ],
    ["accounts for sale", "PREMIUM ACC FOR SALE 🤍\n\nSPOTIFY\nCANVA PRO\nNETFLIX\nCHATGPT PLUS\n\nmop; gcash https://t.co/ffff"],
    ["a news share asking to follow an account", "❗️Acme brings ChatGPT Work to 30,000 employees\n\nhttps://t.co/gggg\n\n🎗️Remember to follow my Instagram account and post your comments below"],
    ["a job post", "We’re hiring a content strategist who knows AI SEO. Remote, full time. Apply below 👇 https://t.co/hhhh"],
    ["a giveaway", "GIVEAWAY: one year of our AI writer free. Like, repost and comment how you write blog posts today to enter!"],
  ])("rejects %s", (_kind, text) => {
    expect(rule(text)).toBe("x_promo");
  });
});

describe("shares, headlines, dumps: the shape rules", () => {
  it("rejects a link shared with a line: news, an article, a product", () => {
    expect(rule("4 Datasets On AI Visibility: #ChatGPT Sends 0.62% Of Google’s Organic Traffic\nMake AI visibility budgets defensible with data quality checks, tests against customer behavior, and brand measures like recall and consideration.\nhttps://t.co/iiii\n#AI #search")).toBe("x_link_share");
    expect(rule("Imagine the discovery process: “Your Honour, ChatGPT has the receipts.” 😂 @someone can't predict that outcome either. https://t.co/jjjj")).toBe("x_link_share");
    expect(rule("From Tokyo — the part that stands out is how quietly Tessera handles AI-heavy desktops. Claude, ChatGPT, Cursor, and Terminal can all stay open without turning the screen into a pileup. https://t.co/kkkk #macOS #AIWorkflow #Productivity")).toBe("x_link_share");
  });

  it("rejects a run of hashtags, even with a rhetorical question in it", () => {
    const text =
      "Just because a website appears at the top of Google doesn't mean it's legitimate. If Google ranks a website first, it must be safe to visit, right? Unfortunately, that's not how it works. Verify the domain name. Be cautious with sponsored results.\n\n#CyberSecurity #SecurityAwareness #Phishing #Malvertising #SEOPoisoning #OnlineSafety";
    expect(rule(text)).toBe("x_list_dump");
  });

  it("rejects a long list with no question in it", () => {
    const items = Array.from({ length: 12 }, (_, i) => `${i + 1}. Side hustle number ${i + 1}`).join("\n");
    expect(rule(`Here are 60 online side hustles you can explore in 2027 to build an extra source of income.\n\n${items}\n\nAnd my top 10 that I recommend for 2027`)).toBe("x_list_dump");
  });

  it("rejects a headline nobody says to anybody", () => {
    expect(rule("Search engine market share shifts again as answer engines gain ground in November across retail and travel queries")).toBe("x_broadcast");
  });

  it("rejects a post too short to know what is asked", () => {
    expect(rule("chatgpt again 😭")).toBe("x_too_short");
    expect(rule("@someone @other #seo https://t.co/llll")).toBe("x_too_short");
  });
});

describe("conversations pass, for the qualifier to judge", () => {
  it.each([
    ["a plain question", "How do I get my blog posts cited by ChatGPT? I rewrote ten articles with FAQs and nothing changed."],
    ["a request for tools", "Anyone using an AI tool for SEO content that doesn't read like AI? Ahrefs' writer feels generic."],
    ["a struggle", "Struggling with organic traffic since the core update, lost 40% on our docs. Content is good imo. Ideas?"],
    ["a question with a screenshot link", "Is it worth rewriting old posts for AI answers or just publishing new ones? Our numbers https://t.co/mmmm"],
    ["a question in Italian", "Qualcuno sa come far citare il proprio sito da ChatGPT? Ho provato con le FAQ ma niente.", "it"],
    [
      "a list asking for additions (qualified on 2026-11-12)",
      "5 free AI tools worth bookmarking:\n\n• ChatGPT – AI assistant\n• Perplexity – Research\n• Gamma – Presentations\n• Napkin AI – Visual explanations\n• NotebookLM – Study &amp; research\nWhich free AI tool would you add?\n#AITools #FreeTools",
    ],
    [
      "a how-to thread addressing the reader (answered by the owner on 2026-11-12)",
      "Your helper didn't break the rules. It never received them.\n\nBad: \"Have an agent search the repo and [do X].\"\n→ The lead starts a researcher.\n\nBetter: a one-minute helper brief.\n\n# Brief\nGoal: [one sentence]\nHard rules:\n- [rule 1]\n- [rule 2]\nDone looks like:\n- [result 1]\n- [result 2]\nDo not:\n- [scope limit]\nReturn only:\n- the result\n- 3 lines: what you did, what you couldn't, what is still unchecked",
    ],
    [
      "a thread whose recruiter line is not a job post (qualified on 2026-11-12)",
      "Most profile prompts ask AI to rewrite you. The better first step: ask it what a stranger thinks you do after 10 seconds.\n\n1. A recruiter hiring for [target role]\n2. A potential client\n3. A peer in my field\n\nWhat do they think I do, and would they keep reading?",
    ],
  ])("keeps %s", (_kind, text, language = "en") => {
    expect(judge(text, language)).toBeNull();
  });

  it("does not guess the shape in a language it has no words for: only the advert, hashtag and list rules apply", () => {
    expect(xPostShape("Wer kann mir helfen", "ja").address).toBeNull();
    expect(judge("これはAIコンテンツについての長い投稿です https://t.co/nnnn", "ja")).toBeNull();
    expect(judge("SEOについて", "ja")).toBeNull();
    expect(rule("giveaway: これはAIコンテンツ 本当に 長い 投稿 です", "ja")).toBe("x_promo");
  });
});

describe("the vocabulary the search uses", () => {
  it("has question phrases for the languages it knows, none for the others", () => {
    expect(xConversationPhrases("en-US")).toContain('"how do i"');
    expect(xConversationPhrases("it")).toContain('"qualcuno sa"');
    expect(xConversationPhrases("ja")).toEqual([]);
    expect(xConversationPhrases(null)).toContain('"anyone know"');
  });

  it("never writes an apostrophe, an operator or a bare OR into a phrase or an excluded word", () => {
    for (const lang of ["en", "it", "es", "fr", "de", "pt"]) {
      for (const phrase of xConversationPhrases(lang)) {
        expect(phrase).not.toMatch(/['’:]/);
        expect(phrase).not.toMatch(/^-|^(or|and)$/i);
      }
    }
    for (const word of X_EXCLUDED_WORDS) expect(word).not.toMatch(/['’:]|^-/);
    // Words genuine posts carry are not excluded at the search: the pre-filter reads them in context.
    expect(X_EXCLUDED_WORDS).not.toContain("course");
    expect(X_EXCLUDED_WORDS).not.toContain("hiring");
  });
});
