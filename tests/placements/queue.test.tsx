import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AddPostForm } from "@/components/placements/add-post-form";
import { ViewTabs } from "@/components/today/view-tabs";
import { LinkBox, MarkRemoved, PostedItem, pasteLinkFor, shortLink } from "@/components/placements/posted-item";
import { DayCount, GroupHeading, OpenInPlace, QueueRow, rowText } from "@/components/placements/queue";
import { OwnReply, ReplyItem, type ReplyItemProps } from "@/components/placements/reply-item";
import { CloseItem } from "@/components/placements/post-preview";
import {
  FIX_IT_START,
  FIX_PRESETS,
  ageLabel,
  auditSummary,
  bylineParts,
  copyThenOpen,
  correctThenApply,
  declineReason,
  fixIt,
  isAdvisoryCheck,
  noteProblem,
  postLines,
  promoteNote,
  promotedSentence,
  replyLabel,
  replyThenOpen,
  rowMeta,
  rowState,
  shortcutFor,
  withPreset,
  withSavedDraft,
} from "@/components/placements/reply-logic";
import { TOAST_MS, Toast } from "@/components/placements/toast";
import { goalFromInput } from "@/components/settings/voice-settings-form";
import { PASTE_BLOCKED, PASTE_NO_LINK } from "@/lib/placements/paste";
import type { PlacementDraftRecord, PlacementTargetRecord } from "@/lib/placements/read";
import { HUMAN_WRITTEN_AGENT_VERSION } from "@/lib/placements/workflow";

/**
 * The Replies queue (2026-11-10): compact rows, one item open, one primary
 * button per state. Server-rendered structure, not pixels: the contract.
 * The owner's words on the cards this replaces: too much scrolling, the
 * next button is not clear, too much text, parts that are not needed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");
const NOW = Date.parse("2026-11-10T09:30:00Z");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const draft = (over: Partial<PlacementDraftRecord> = {}): PlacementDraftRecord => ({
  id: "d-1",
  variant: "short_comment",
  body: "Answer engines retrieve passages, not pages, so restructure each section to answer its own question first.",
  linkUrl: null,
  claims: [{ text: "Answer engines retrieve passages", basis: "general_knowledge" }],
  audit: {
    status: "passed",
    checks: [{ id: "answers_first", label: "Answers the question before anything else", status: "pass", detail: "ok" }],
  },
  auditStatus: "passed",
  agentVersion: 1,
  updatedAt: "2026-09-21T00:00:00Z",
  ...over,
});

const target = (over: Partial<PlacementTargetRecord> = {}): PlacementTargetRecord => ({
  id: "t-1",
  surface: "x",
  kind: "post",
  url: "https://x.com/asker/status/1900000000000000001",
  title: "How do I get my site cited by AI answer engines? Our SEO is fine but ChatGPT never mentions us.",
  excerpt: "How do I get my site cited by AI answer engines? Our SEO is fine but ChatGPT never mentions us.",
  community: "@asker",
  author: "asker",
  postedAt: ago(3),
  postedAtPrecision: null,
  score: null,
  commentCount: null,
  foundFor: "ai seo",
  foundVia: "manual",
  status: "drafted",
  qualifyScore: null,
  qualifyReason: "Squarely their topic and the top answers are guesses.",
  qualifyAngle: "Passage-level structure and how to measure citations.",
  qualifiedBy: "person",
  qualifiedAt: ago(2),
  topic: "AI citations",
  intent: "question",
  freshUntil: null,
  snoozedUntil: null,
  reviewNote: null,
  dismissedReason: null,
  publishedUrl: null,
  publishedAt: null,
  publishedNote: null,
  aeoQueryId: null,
  selectedPlacementId: null,
  lastSeenAt: ago(1),
  createdAt: ago(2),
  drafts: [draft()],
  ...over,
});

const reddit = (over: Partial<PlacementTargetRecord> = {}) =>
  target({
    surface: "reddit",
    kind: "thread",
    url: "https://www.reddit.com/r/SEO/comments/1abc2d/x/",
    title: "How do I get my site cited by AI answer engines?",
    excerpt: "Our SEO is fine but ChatGPT never mentions us.",
    community: "r/SEO",
    author: "u/asker",
    commentCount: 12,
    foundVia: "reddit",
    qualifiedBy: "agent",
    qualifyScore: 82,
    ...over,
  });

const noop = () => {};
const recorded = async () => null;
const saved = async () => ({ ok: false as const, error: "not in a test" });
const item = (t: PlacementTargetRecord, over: Partial<ReplyItemProps> = {}) =>
  renderToStaticMarkup(
    <ReplyItem
      target={t}
      now={NOW}
      busy={false}
      replied={false}
      onRepliedChange={noop}
      onDraft={noop}
      onDraftAnyway={noop}
      onAction={noop}
      onMarkPublished={recorded}
      onSaveDraft={saved}
      onSaveOwnReply={saved}
      onCorrectDraft={saved}
      onPromoteNote={saved}
      {...over}
    />
  );

/** Buttons and links a person can press, as their text, menus included. */
const controls = (html: string) => [...html.matchAll(/<(?:button|a)\b[^>]*>((?:(?!<\/(?:button|a)>)[^])*)<\/(?:button|a)>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
const primaries = (html: string) => [...html.matchAll(/<(?:button|a)\b[^>]*class="[^"]*bg-primary[^"]*"[^>]*>((?:(?!<\/(?:button|a)>)[^])*)<\/(?:button|a)>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
const words = (html: string) => html.replace(/<textarea[^>]*>[^]*?<\/textarea>/g, " ").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean);

const blockedDraft = () =>
  draft({
    auditStatus: "blocked",
    audit: {
      status: "blocked",
      checks: [
        { id: "answers_first", label: "Answers the question before anything else", status: "fail", detail: "Opens with the pitch." },
        { id: "not_spam", label: "Reads like a person, not a campaign", status: "pass", detail: "ok" },
      ],
    },
  });

const coherenceNote = (over: Record<string, unknown> = {}) => ({
  id: "business_coherence",
  label: "Coherent with what the business can speak to",
  status: "warn" as const,
  detail: "Does not touch any of the business's keywords or entities. A note, not a fault.",
  advisory: true,
  ...over,
});

describe("a row of the queue", () => {
  it("is two lines and one word: who and how old, the post, the state; no pill, no chip, no icon button", () => {
    const html = renderToStaticMarkup(<QueueRow target={target()} now={NOW} onOpen={noop} />);
    expect(html).toContain("X · @asker · 3h");
    expect(html).toContain("How do I get my site cited by AI answer engines?");
    expect(html).toContain("Draft ready");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("rounded-md border");
    expect(html).not.toContain("AI citations");
    // The whole row is the tap target, taller than a thumb.
    expect(html).toContain("min-h-14");
    expect(html).toContain("truncate");
  });

  it("says the state in one word, the same words everywhere", () => {
    expect(rowState(target()).word).toBe("Draft ready");
    expect(rowState(target({ drafts: [blockedDraft()], status: "needs_review" }))).toEqual({ word: "Check failed", tone: "warn" });
    expect(rowState(target({ drafts: [] }), { writing: true }).word).toBe("Writing…");
    expect(rowState(target({ drafts: [], status: "qualified" })).word).toBe("Draft it");
    expect(rowState(target({ drafts: [], status: "qualified" }), { failure: "declined" }).word).toBe("Not drafted");
    expect(rowState(target({ drafts: [], status: "qualified" }), { failure: "paused" }).word).toBe("Draft failed");
    expect(rowState(target({ kind: "listicle", drafts: [], status: "qualified" })).word).toBe("Ask to be listed");
    expect(rowState(target({ status: "published_manually" }))).toEqual({ word: "No link", tone: "warn" });
    expect(rowState(target({ status: "published_manually", publishedUrl: "https://x.com/me/status/2" })).word).toBe("Linked");
    expect(rowState(target({ status: "published_manually", removedAt: ago(1) })).word).toBe("Removed");
    expect(rowState(target({ status: "dismissed" })).word).toBe("Skipped");
    expect(rowState(target({ status: "rejected" })).word).toBe("Filtered out");
    expect(rowState(target({ status: "discovered" })).word).toBe("Not sorted yet");
  });

  it("says how old a post is in a word: minutes and hours on X, a floor on a search engine's distance, nothing when unknown", () => {
    expect(ageLabel(ago(0.5), null, NOW)).toBe("30m");
    expect(ageLabel(ago(3), null, NOW)).toBe("3h");
    expect(ageLabel(ago(50), null, NOW)).toBe("2d");
    expect(ageLabel(ago(24 * 20), null, NOW)).toMatch(/^Oct \d+$/);
    expect(ageLabel(ago(24 * 70), "month", NOW)).toBe("2 months+");
    expect(ageLabel(ago(24 * 9), "week", NOW)).toBe("1 week+");
    expect(ageLabel(ago(24 * 400), "year", NOW)).toBe("1 year+");
    expect(ageLabel(ago(5), "day", NOW)).toBe("today");
    expect(ageLabel(null, null, NOW)).toBe("");
    expect(ageLabel("nonsense", null, NOW)).toBe("");
  });

  it("names the poster once, says how busy a found thread is, and when a row is snoozed or expired", () => {
    expect(bylineParts("@asker", "asker")).toEqual(["@asker"]);
    expect(bylineParts("r/SEO", "u/asker")).toEqual(["r/SEO", "by u/asker"]);
    // A found row says two times since 2026-11-12: the post's age and when it was found.
    expect(rowMeta(reddit(), NOW)).toBe("Reddit · r/SEO · 3h · 12 comments · found 2h ago");
    expect(rowMeta(target({ surface: "quora", community: "Quora", author: null }), NOW)).toBe("Quora · 3h");
    expect(rowMeta(target({ surface: "linkedin", community: null, author: "Anna Keller" }), NOW)).toBe("LinkedIn · Anna Keller · 3h");
    expect(rowMeta(reddit({ freshUntil: ago(1) }), NOW)).toContain("expired");
    expect(rowMeta(reddit({ snoozedUntil: new Date(NOW + 6 * 86_400_000).toISOString() }), NOW)).toContain("snoozed until Nov 16");
    expect(rowMeta(target({ status: "published_manually", publishedAt: ago(20) }), NOW)).toBe("X · @asker · posted 20h");
  });

  it("shows the person's own reply once it is posted, so they can tell which reply it is", () => {
    const posted = target({ status: "published_manually", selectedPlacementId: "d-1" });
    expect(rowText(posted)).toBe("“Answer engines retrieve passages, not pages, so restructure each section to answer its own question first.”");
    expect(rowText(target({ status: "published_manually", publishedText: "what I typed on X\nsecond line" }))).toBe("“what I typed on X”");
    expect(rowText(target({ status: "published_manually", drafts: [] }))).toContain("How do I get my site cited");
    expect(rowText(target())).toContain("How do I get my site cited");
  });

  it("carries Paste link on the row of a posted reply with no link, in place of the state word", () => {
    const html = renderToStaticMarkup(
      <QueueRow target={target({ status: "published_manually" })} now={NOW} onOpen={noop} trailing={<button type="button">Paste link</button>} />
    );
    expect(html).toContain("Paste link");
    expect(html).not.toContain("No link");
  });

  it("highlights the open item's row beside the pane, and heads each group with its count", () => {
    expect(renderToStaticMarkup(<QueueRow target={target()} now={NOW} selected onOpen={noop} />)).toContain('aria-current="true"');
    const heading = renderToStaticMarkup(<GroupHeading label="Yours" count={4} />);
    expect(heading).toContain("Yours");
    expect(heading).toContain("· 4");
  });
});

describe("the open item, a draft ready", () => {
  const html = item(target());

  it("shows the post once, two lines until tapped, and the draft as the largest text", () => {
    expect(postLines(target())).toEqual({ title: target().excerpt, body: null });
    expect(html.match(/How do I get my site cited/g)).toHaveLength(1);
    expect(html).toContain("line-clamp-2");
    const box = html.match(/<textarea[^>]*aria-label="Your reply"[^>]*>/)?.[0] ?? "";
    expect(box).toContain("text-[17px]");
    expect(box).toContain("resize-none");
    // A post cut at 200 characters as a title is still shown whole, once.
    // A post written one sentence per line: the title is the same text on one line.
    const lines = {
      title: "Every time one of my LinkedIn posts gets traction, some 50+ year old CEO turns up to call me a scammer. For sharing my own revenue. Is this the price of posting???",
      excerpt: "Every time one of my LinkedIn posts gets traction,\n\nsome 50+ year old CEO turns up to call me a scammer.\n\nFor sharing my own revenue.\n\nIs this the price of posting???",
    };
    expect(postLines(lines)).toEqual({ title: lines.excerpt, body: null });
    const cut = postLines({ title: "A long post that was cut…", excerpt: "A long post that was cut right here, with the rest of it." });
    expect(cut).toEqual({ title: "A long post that was cut right here, with the rest of it.", body: null });
    // A thread with a real title keeps the title and its text.
    expect(postLines(reddit())).toEqual({ title: "How do I get my site cited by AI answer engines?", body: "Our SEO is fine but ChatGPT never mentions us." });
  });

  it("has one primary button, Reply on X, and everything else is a chip or behind the menu", () => {
    expect(primaries(html)).toEqual(["Reply on X"]);
    const visible = controls(html.replace(/<div role="menu"[^]*?<\/div>/g, ""));
    expect(visible).toEqual(expect.arrayContaining(["Reply on X", "Sounds like AI", "Too long", "Fix…", "Skip"]));
    // The post toggle, Checked, the primary, the menu button, four chips.
    expect(visible.length).toBeLessThanOrEqual(8);
    const menu = html.match(/<div role="menu"[^]*?<\/div>/)?.[0] ?? "";
    expect(controls(menu)).toEqual(["Copy", "I posted it", "Start over", "Snooze a week", "Open post", "Voice"]);
  });

  it("says the checks in one quiet mark, and nothing the buttons already say", () => {
    expect(html).toContain("Checked");
    expect(html).not.toContain("All checks passed");
    expect(html).not.toContain("Show all checks");
    for (const gone of [
      "The post",
      "No link and no product name",
      "come back and tap I posted it",
      "Posted it on",
      "You can add the link to your reply afterwards",
      "Draft ready",
      "Generate draft",
      "Rewrite",
      "Copy only",
      "never posts",
    ]) {
      expect(html).not.toContain(gone);
    }
    // Under 30 words of the product's own on the item, the post and the draft
    // aside, and the byline the open row used to print above it (2026-11-10:
    // it is the post's header now, "@asker" over "X · 3h", and "You" beside the draft).
    const own = words(html).length - words(target().excerpt ?? "").length - words("@asker X · 3h You").length;
    expect(own).toBeLessThan(30);
  });

  it("keeps the finder's and the qualifier's notes off the item", () => {
    const found = item(reddit());
    expect(found).not.toContain("Squarely their topic");
    expect(found).not.toContain("Passage-level structure");
    expect(found).not.toContain("ai seo");
    expect(found).not.toContain("82");
  });

  it("makes every control thumb-sized on a phone and keeps text at 12px or more", () => {
    for (const tag of html.match(/<button[^>]*>/g) ?? []) {
      expect(tag).toContain("min-h-11");
    }
    expect(html).not.toMatch(/text-\[(?:9|10|11)px\]/);
  });

  it("replies where the thread is: X opens its composer, another site is named, a bare page is copy and open", () => {
    expect(replyLabel("x")).toBe("Reply on X");
    expect(replyLabel("reddit")).toBe("Copy & reply on Reddit");
    expect(replyLabel("linkedin")).toBe("Copy & reply on LinkedIn");
    expect(replyLabel("quora")).toBe("Copy & reply on Quora");
    expect(replyLabel("web")).toBe("Copy & open");
    expect(primaries(item(reddit()))).toEqual(["Copy &amp; reply on Reddit"]);
  });
});

describe("the open item, after Reply", () => {
  it("turns the same primary button into I posted it, with the way back beside it", () => {
    const html = item(target(), { replied: true });
    expect(primaries(html)).toEqual(["I posted it"]);
    expect(html).toContain("Open X again");
    expect(html).toContain("Not posted");
    expect(html).not.toContain("Reply on X");
    expect(html).not.toContain("Sounds like AI");
  });

  it("does not offer I posted it on a row that cannot be marked", () => {
    const html = item(target({ status: "dismissed", dismissedReason: "Off topic." }), { replied: true });
    expect(html).toContain("Skipped: Off topic.");
    expect(primaries(html)).toEqual(["Reply on X"]);
    expect(html).not.toContain("I posted it");
  });
});

describe("the open item, when a check failed", () => {
  it("says it in one line, once, and the primary button is Reply anyway", () => {
    const html = item(target({ status: "needs_review", drafts: [blockedDraft()] }));
    expect(html).toContain("Check failed");
    expect(html.match(/Opens with the pitch\./g)).toHaveLength(1);
    expect(primaries(html)).toEqual(["Reply anyway"]);
    expect(html).not.toContain("didn&#x27;t pass a check");
    expect(html).not.toContain("it is your call");
    expect(html).toContain("All checks");
  });

  it("keeps an advisory check out of the verdict: a note behind Checked, never a warning", () => {
    const advisory = draft({
      audit: { status: "passed", checks: [{ id: "answers_first", label: "Answers the question before anything else", status: "pass", detail: "ok" }, coherenceNote()] },
    });
    expect(auditSummary(advisory.audit)).toMatchObject({ allPassed: true, flagged: [] });
    expect(auditSummary(advisory.audit).notes).toHaveLength(1);
    const html = item(target({ drafts: [advisory] }));
    expect(html).toContain("Checked");
    expect(html).not.toContain("Coherent with what the business can speak to");
    expect(isAdvisoryCheck({ id: "business_coherence" })).toBe(true);
    expect(isAdvisoryCheck({ id: "answers_first" })).toBe(false);
    expect(isAdvisoryCheck({ id: "anything", advisory: true } as never)).toBe(true);
    const warned = { status: "warning", checks: [{ id: "platform_fit", label: "Fits", status: "warn" as const, detail: "301 of 280." }] };
    expect(auditSummary(warned)).toMatchObject({ allPassed: false });
    expect(auditSummary({ status: "blocked", checks: [coherenceNote()] }).allPassed).toBe(false);
  });

  it("opens the variant that passed when an earlier one is blocked, and shows the tabs only when there is a choice", () => {
    const good = draft({ id: "d-2", variant: "detailed_answer", body: "The longer answer that passed." });
    const two = item(target({ drafts: [blockedDraft(), good] }));
    expect(two).toContain("The longer answer that passed.");
    expect(two).toContain('role="tablist"');
    expect(two).toContain("Long reply");
    expect(item(target())).not.toContain('role="tablist"');
  });
});

describe("the open item, with no draft", () => {
  it("offers Draft it as the one primary on a found thread, with Write my own and Skip", () => {
    const html = item(reddit({ status: "qualified", drafts: [] }));
    expect(primaries(html)).toEqual(["Draft it"]);
    expect(html).toContain("Write my own");
    expect(html).toContain("Skip");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("I posted it");
  });

  it("says it is writing in one line, with no button to press", () => {
    const html = item(target({ status: "qualified", drafts: [] }), { writing: true, busy: true, note: { tone: "info", text: "Still writing, almost there." } });
    expect(html.match(/Still writing, almost there\./g)).toHaveLength(1);
    expect(primaries(html)).toEqual([]);
    expect(html).not.toContain("Draft it");
  });

  it("gives a decline's reason without the sentence that lists the buttons, and Write it anyway as the primary", () => {
    const text = 'Not drafted: the AI found nothing worth saying in this thread ("a greeting"). Your call: write it anyway, open it, or reject it.';
    expect(declineReason(text)).toBe('the AI found nothing worth saying in this thread ("a greeting").');
    const html = item(target({ status: "qualified", drafts: [] }), { note: { tone: "error", kind: "declined", text } });
    expect(primaries(html)).toEqual(["Write it anyway"]);
    expect(html).toContain("the AI found nothing worth saying");
    expect(html).not.toContain("reject it");
    expect(html).not.toContain("Your call");
  });

  it("shows a paused or failed draft as one line, and Draft it again", () => {
    const html = item(target({ status: "qualified", drafts: [] }), {
      note: { tone: "error", kind: "paused", text: "Drafting is paused: the AI provider is not answering right now." },
    });
    expect(html).toContain("Drafting is paused");
    expect(primaries(html)).toEqual(["Draft it"]);
  });

  it("says what to fill in when nothing records how the writer uses the product", () => {
    const html = item(target({ status: "qualified", drafts: [] }), { writerUseRecorded: false });
    expect(html).toContain("Drafts speak only from what you recorded about yourself.");
    expect(html).toContain('href="/settings/voice"');
  });

  it("is a reply box with Reply under it once Write my own is tapped, disabled until there is text", () => {
    const html = renderToStaticMarkup(<OwnReply target={{ surface: "x", url: "https://x.com/a/status/1" }} onSave={saved} onCancel={noop} />);
    expect(html).toContain("<textarea");
    const button = html.match(/<button[^>]*bg-primary[^>]*>/)?.[0] ?? "";
    expect(button).toContain('disabled=""');
    expect(html).toContain("Reply on X");
    expect(html).toContain("Cancel");
  });

  it("shows the person's own saved reply as the draft, with nothing to fix by a note", () => {
    const own = draft({ agentVersion: HUMAN_WRITTEN_AGENT_VERSION, body: "My own words." });
    const html = item(target({ drafts: [own] }));
    expect(html).toContain("My own words.");
    expect(html).not.toContain("Fix…");
    expect(html).not.toContain("Sounds like AI");
  });

  it("offers a list article's page and says to ask its author: no draft, no reply box, no I posted it", () => {
    const html = item(target({ surface: "web", kind: "listicle", status: "qualified", drafts: [], title: "The 14 best tools", excerpt: null }));
    expect(primaries(html)).toEqual(["Open the article"]);
    expect(html).toContain("nobody has checked that the author takes suggestions");
    expect(html).toContain("nothing is written or sent for");
    expect(html).not.toContain("Draft it");
    expect(html).not.toContain("Write my own");
    expect(html).not.toContain("I posted it");
  });

  it("names the rule when a post was filtered out, and offers to bring it back", () => {
    const html = item(reddit({ status: "rejected", drafts: [], qualifiedBy: "rules:stale", qualifyReason: "posted 40 days ago" }));
    expect(html).toContain("Filtered out (rule: stale): posted 40 days ago");
    expect(primaries(html)).toEqual(["Bring back"]);
  });

  it("says which prompt and which engine cited a page a visibility run put here, as a sampled answer", () => {
    const html = item(
      reddit({
        status: "qualified",
        drafts: [],
        aiCitation: { runId: "r", checkedAt: null, promptCount: 1, prompts: [{ queryId: "q", query: "best ai seo tool", engines: ["gemini"] }] },
      })
    );
    expect(html).toContain("sampled AI answer");
    expect(html).toContain("best ai seo tool");
  });
});

describe("Reply in one tap, whatever the draft's state", () => {
  const run = (over: Partial<Parameters<typeof replyThenOpen>[0]> = {}) => {
    const calls: string[] = [];
    const promise = replyThenOpen({
      dirty: false,
      blocked: false,
      anyway: false,
      body: "as shown",
      save: async () => {
        calls.push("save");
        return { body: "as saved", auditStatus: "passed" };
      },
      urlFor: (body) => `https://x.com/intent/tweet?text=${encodeURIComponent(body)}`,
      copy: async (body) => calls.push(`copy ${body}`),
      open: (url) => calls.push(`open ${url}`),
      then: () => calls.push("then"),
      ...over,
    });
    return promise.then((outcome) => ({ outcome, calls }));
  };

  it("copies, opens the other site, then tells the item the reply is out", async () => {
    const calls: string[] = [];
    await copyThenOpen("https://x.com/intent/tweet?text=a&in_reply_to=1", {
      copy: async () => calls.push("copy"),
      open: (url) => calls.push(`open ${url}`),
      then: () => calls.push("then"),
    });
    expect(calls).toEqual(["copy", "open https://x.com/intent/tweet?text=a&in_reply_to=1", "then"]);
    const opened: string[] = [];
    await copyThenOpen("https://x.com/a", { copy: async () => false, open: (url) => opened.push(url) });
    expect(opened).toHaveLength(1);
  });

  it("saves and re-checks an edited draft, then opens with the text as saved", async () => {
    const { outcome, calls } = await run({ dirty: true });
    expect(outcome).toBe("opened");
    expect(calls).toEqual(["save", "copy as saved", "open https://x.com/intent/tweet?text=as%20saved", "then"]);
    expect((await run()).calls[0]).toBe("copy as shown");
  });

  it("opens nothing when the re-check blocks the edit or the save fails, and replies anyway only when the person says so", async () => {
    expect(await run({ dirty: true, save: async () => ({ body: "x", auditStatus: "blocked" }) })).toEqual({ outcome: "blocked", calls: [] });
    expect(await run({ dirty: true, save: async () => null })).toEqual({ outcome: "save_failed", calls: [] });
    expect((await run({ blocked: true })).outcome).toBe("blocked");
    const anyway = await run({ blocked: true, anyway: true });
    expect(anyway.outcome).toBe("opened");
    expect(anyway.calls).toContain("then");
  });

  it("puts a saved draft on its own item only, with the status the save moved", () => {
    const targets = [target(), target({ id: "t-2", drafts: [draft({ id: "d-9" })] })];
    const next = withSavedDraft(targets, draft({ id: "d-9", body: "edited" }), "needs_review");
    expect(next[0]).toBe(targets[0]);
    expect(next[1].drafts[0].body).toBe("edited");
    expect(next[1].status).toBe("needs_review");
  });
});

describe("Fix: a draft corrected with a note", () => {
  it("offers the two notes given most as one-tap chips, and Fix… for one's own", () => {
    expect(FIX_PRESETS).toEqual(["Sounds like AI", "Too long", "Use one of my numbers"]);
    const html = item(target());
    expect(html).toMatch(/<button[^>]*rounded-full[^>]*>Sounds like AI<\/button>/);
    expect(html).toMatch(/<button[^>]*rounded-full[^>]*>Too long<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Fix…<\/button>/);
    // Closed until asked for: no note box on the item.
    expect(html).not.toContain("What is wrong with the draft");
  });

  it("fills the note from a preset, and two presets make one note", () => {
    expect(withPreset("", "Too long")).toBe("Too long");
    expect(withPreset("Too long", "Sounds like AI")).toBe("Too long. Sounds like AI");
    expect(withPreset("Too long", "too long")).toBe("Too long");
    expect(fixIt(FIX_IT_START, { type: "preset", preset: "Too long" }).reason).toBe("Too long");
  });

  it("opens, waits while the one call runs, and closes on the rewrite", () => {
    const open = fixIt(FIX_IT_START, { type: "toggle" });
    expect(open.open).toBe(true);
    const running = fixIt({ ...open, reason: "Too long" }, { type: "submit" });
    expect(running.rewriting).toBe(true);
    expect(fixIt(running, { type: "toggle" })).toBe(running);
    expect(fixIt(running, { type: "submit" })).toBe(running);
    const done = fixIt(running, { type: "rewritten", feedbackId: "fb-1", blocked: false });
    expect(done).toMatchObject({ open: false, reason: "", rewriting: false, kept: { feedbackId: "fb-1", blocked: false } });
    const refused = fixIt(running, { type: "refused", error: "No credits.", href: "/pricing" });
    expect(refused).toMatchObject({ open: true, rewriting: false, error: { text: "No credits.", href: "/pricing" } });
  });

  it("sends the note with the text as it stands and puts the rewrite on the item, or says the server's sentence and changes nothing", async () => {
    const applied: string[] = [];
    const sent: Array<[string, string | null]> = [];
    const ok = await correctThenApply({
      reason: " Too long ",
      body: "the text in the box",
      correct: async (reason, body) => {
        sent.push([reason, body]);
        return { ok: true, draft: draft({ body: "shorter" }), feedbackId: "fb-1" };
      },
      apply: (d) => applied.push(d.body),
    });
    expect(sent).toEqual([["Too long", "the text in the box"]]);
    expect(applied).toEqual(["shorter"]);
    expect(ok).toEqual({ type: "rewritten", feedbackId: "fb-1", blocked: false });

    const still = await correctThenApply({
      reason: "Too long",
      body: "",
      correct: async (_reason, body) => {
        expect(body).toBeNull();
        return { ok: true, draft: blockedDraft(), feedbackId: "fb-2" };
      },
      apply: noop,
    });
    expect(still).toMatchObject({ type: "rewritten", blocked: true });

    const refused = await correctThenApply({
      reason: "Too long",
      body: "x",
      correct: async () => ({ ok: false, error: "Add what is true about you first.", href: "/settings/voice" }),
      apply: () => applied.push("never"),
    });
    expect(refused).toEqual({ type: "refused", error: "Add what is true about you first.", href: "/settings/voice" });
    expect(applied).toEqual(["shorter"]);
  });

  it("refuses a note too short to say anything before any round trip", async () => {
    expect(noteProblem("Too long")).toBeNull();
    expect(noteProblem("  ")).not.toBeNull();
    let asked = false;
    const result = await correctThenApply({
      reason: " ",
      body: "x",
      correct: async () => {
        asked = true;
        return { ok: false, error: "never" };
      },
      apply: noop,
    });
    expect(result.type).toBe("refused");
    expect(asked).toBe(false);
  });

  it("offers, after a rewrite, to remember the note for every draft, and says what that did", async () => {
    expect(await promoteNote({ feedbackId: "fb-1", promote: async () => ({ ok: true, appended: true }) })).toEqual({
      type: "promoted",
      ok: true,
      text: promotedSentence(true),
    });
    expect(promotedSentence(false)).toContain("already in your notes");
    expect(await promoteNote({ feedbackId: "fb-1", promote: async () => ({ ok: false, error: "Try again." }) })).toEqual({
      type: "promoted",
      ok: false,
      text: "Try again.",
    });
    const kept = fixIt({ ...FIX_IT_START, kept: { feedbackId: "fb-1", blocked: false } }, { type: "promote" });
    expect(kept.promoting).toBe(true);
    expect(fixIt(FIX_IT_START, { type: "promote" })).toBe(FIX_IT_START);
  });
});

describe("keyboard shortcuts", () => {
  const press = (key: string, over: Record<string, unknown> = {}) => shortcutFor({ key, target: { tagName: "BODY" }, ...over });

  it("moves with J and K and presses the open item with R, P, F and S", () => {
    expect(press("j")).toBe("next");
    expect(press("k")).toBe("previous");
    expect(press("r")).toBe("reply");
    expect(press("p")).toBe("posted");
    expect(press("f")).toBe("fix");
    expect(press("s")).toBe("skip");
    expect(press("J")).toBe("next");
    expect(press("x")).toBeNull();
    expect(press("Enter")).toBeNull();
  });

  it("never fires while typing: a field, a text box, a select, anything editable", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input", "textarea"]) {
      expect(press("r", { target: { tagName } })).toBeNull();
      expect(press("s", { target: { tagName } })).toBeNull();
    }
    expect(press("p", { target: { tagName: "DIV", isContentEditable: true } })).toBeNull();
    expect(press("j", { isComposing: true })).toBeNull();
  });

  it("leaves the browser's own shortcuts alone", () => {
    expect(press("r", { metaKey: true })).toBeNull();
    expect(press("r", { ctrlKey: true })).toBeNull();
    expect(press("f", { ctrlKey: true })).toBeNull();
    expect(press("s", { altKey: true })).toBeNull();
    expect(press("j", { target: null })).toBe("next");
  });

  it("is listened for by the page, which steps the open item and presses what the item registered", () => {
    const page = source("app/(app)/today/page.tsx");
    expect(page).toContain("shortcutFor(event, { dialogOpen: sheetOpen || todayOpen })");
    expect(page).toContain("stepOpenId(rowIds, open,");
    expect(page).toContain("itemActions.current[shortcut]");
  });
});

describe("a posted reply and its link", () => {
  const posted = (over: Partial<PlacementTargetRecord> = {}) =>
    target({ status: "published_manually", publishedAt: ago(20), selectedPlacementId: "d-1", ...over });
  const render = (t: PlacementTargetRecord) =>
    renderToStaticMarkup(
      <PostedItem target={t} now={NOW} aeoQueries={[{ id: "q-1", query: "best ai seo tool" }]} busy={false} onSetPublishedUrl={recorded} onMarkRemoved={recorded} onUnmarkRemoved={recorded} />
    );

  it("shows the words that went out, and Paste link as the one primary while the link is missing", () => {
    const html = render(posted());
    expect(html).toContain("Answer engines retrieve passages, not pages");
    expect(primaries(html)).toEqual(["Paste link"]);
    expect(html).toContain('type="url"');
    expect(html).toContain("https://x.com/you/status/1234567890");
    expect(html).toContain("It was removed");
    // The explanation is said once, on the box above the list, not on every reply.
    expect(html).not.toContain("so it can be measured");
    expect(html).not.toContain("traced back to this reply");
    expect(html).not.toContain("<textarea");
  });

  it("shows the text read back from X when there is one, and the link once it is saved", () => {
    const html = render(posted({ publishedUrl: "https://x.com/me/status/2", publishedText: "what I typed on X" }));
    expect(html).toContain("what I typed on X");
    expect(html).not.toContain("Answer engines retrieve passages");
    expect(html).toContain('href="https://x.com/me/status/2"');
    expect(primaries(html)).toEqual(["Your reply"]);
    expect(html).not.toContain("Paste link");
  });

  it("shows a removed reply with its reason and date, stops asking for its link, and offers the Undo", () => {
    const html = render(posted({ removedAt: "2026-11-08T10:00:00Z", removedReason: "Hidden because my account is new" }));
    expect(html).toContain("Removed: Hidden because my account is new, marked Nov 8, 2026");
    expect(html).toContain("Undo: it is still up");
    expect(html).not.toContain("Paste link");
    expect(html).not.toContain("It was removed");
  });

  it("lays out It was removed with the three reasons a thumb can tap and a 300-character field, in place", () => {
    const html = renderToStaticMarkup(<MarkRemoved busy={false} defaultOpen onSubmit={recorded} />);
    expect(html).toContain("Removed by a moderator or the site");
    expect(html).toContain("Hidden because my account is new");
    expect(html).toContain("I deleted it");
    expect(html).toContain('maxLength="300"');
    expect(html).toContain("Mark as removed");
    expect(html).not.toContain("dialog");
  });

  it("pastes the clipboard's link in one tap when it can belong to this reply, and saves nothing otherwise", async () => {
    const reply = { surface: "x", url: "https://x.com/asker/status/1900000000000000001" };
    const savedUrls: string[] = [];
    const save = async (url: string) => {
      savedUrls.push(url);
      return null;
    };
    expect(await pasteLinkFor({ target: reply, read: async () => "https://x.com/me/status/1987700000000000001?s=20", save })).toBeNull();
    expect(savedUrls).toEqual(["https://x.com/me/status/1987700000000000001?s=20"]);

    // The thread's own link, a link on another site, prose, a refused clipboard: said in words, nothing saved.
    expect(await pasteLinkFor({ target: reply, read: async () => reply.url, save })).toContain("reply");
    expect(await pasteLinkFor({ target: reply, read: async () => "https://www.reddit.com/r/a/comments/b/c/d/", save })).toContain("not on X");
    expect(await pasteLinkFor({ target: reply, read: async () => "no link here", save })).toBe(PASTE_NO_LINK);
    expect(await pasteLinkFor({ target: reply, read: async () => null, save })).toBe(PASTE_BLOCKED);
    expect(savedUrls).toHaveLength(1);
    // The server's refusal comes back as the sentence to show.
    expect(await pasteLinkFor({ target: reply, read: async () => "https://x.com/me/status/5", save: async () => "This post is no longer in your inbox." })).toBe(
      "This post is no longer in your inbox."
    );
  });

  it("takes several links in one box, says what was saved, and asks about the ones it cannot be sure of", () => {
    const candidate = posted({ id: "t-9" });
    const html = renderToStaticMarkup(
      <LinkBox
        busy={false}
        now={NOW}
        candidates={[candidate]}
        result={{
          saved: 2,
          picks: [{ kind: "pick", link: "https://x.com/me/status/1987700000000000888", candidateIds: ["t-9"], why: "…" }],
          refused: [{ link: "https://github.com/a/b/issues/1#issuecomment-2", error: "No posted reply on GitHub is waiting for its link." }],
        }}
        onLinks={async () => {}}
        onPick={recorded}
        onDismissPick={noop}
      />
    );
    expect(html).toContain("Paste your reply links");
    expect(html).toContain("2 links saved.");
    expect(html).toContain("which reply is it?");
    expect(html).toContain("Answer engines retrieve passages");
    expect(html).toContain("None of these");
    expect(html).toContain("No posted reply on GitHub is waiting for its link.");
    expect(primaries(html)).toEqual(["Paste"]);
    expect(shortLink("https://x.com/me/status/1987700000000000888")).toBe("x.com…/1987700000000000888");
    expect(shortLink("https://www.reddit.com/r/a/")).toBe("reddit.com/r/a");
  });
});

describe("the three tabs in place of the filter menu", () => {
  it("are To do, Posted and Archive, the open one in the primary colour, To do with its count, each 44px on a phone", () => {
    const html = renderToStaticMarkup(<ViewTabs value="posted" todoCount={5} onChange={noop} />);
    expect(html).toContain('role="tablist"');
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^]*?)<\/button>/g)].map((m) => m[0]);
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toContain("To do");
    expect(tabs[0]).toContain(" · 5</span>");
    expect(tabs[1]).toMatch(/aria-selected="true"[^>]*bg-primary/);
    expect(tabs[2]).toContain("Archive");
    for (const tab of tabs) expect(tab).toContain("min-h-11");
    // An unknown count is not shown as 0.
    expect(renderToStaticMarkup(<ViewTabs value="todo" todoCount={null} onChange={noop} />)).not.toContain("·");
  });

  it("labels an archived row with why it is there, in place of its state", () => {
    const html = renderToStaticMarkup(<QueueRow target={target({ status: "dismissed" })} now={NOW} onOpen={noop} reason="Skipped" />);
    expect(html).toContain(">Skipped</span>");
    const expired = renderToStaticMarkup(<QueueRow target={target()} now={NOW} onOpen={noop} reason="Expired" />);
    expect(expired).toContain(">Expired</span>");
    expect(expired).not.toContain("Draft it");
  });

  it("tags a row a sampled AI answer cited: where it came from, not a state", () => {
    const cited = renderToStaticMarkup(
      <QueueRow target={target({ aiCitation: { runId: "r", checkedAt: null, promptCount: 1, prompts: [{ queryId: "q", query: "best seo tools", engines: ["perplexity"] }] } })} now={NOW} onOpen={noop} />
    );
    expect(cited).toContain("Cited by AI · ");
    expect(renderToStaticMarkup(<QueueRow target={target()} now={NOW} onOpen={noop} />)).not.toContain("Cited by AI");
  });

  it("opens To do's reply on top of Today as a card of its own", () => {
    const card = renderToStaticMarkup(
      <OpenInPlace target={target()} card>
        <p>inside</p>
      </OpenInPlace>
    );
    expect(card).toContain('data-open-item="t-1"');
    expect(card).toContain("rounded-xl border border-border bg-background");
  });
});

describe("adding posts", () => {
  const form = (over: Partial<Parameters<typeof AddPostForm>[0]> = {}) =>
    renderToStaticMarkup(
      <AddPostForm value="" onChange={noop} text="" onTextChange={noop} askForText={false} progress={null} report={null} onAdd={noop} {...over} />
    );

  it("is one row: a field at 16px on a phone and one primary button, 44px tall", () => {
    const html = form();
    expect(html).toMatch(/^<form/);
    const input = html.match(/<input[^>]*id="placements-add-url"[^>]*>/)?.[0] ?? "";
    expect(input).toContain("min-h-11");
    expect(input).toContain("text-base");
    expect(input).toContain("up to 10 at a time");
    expect(primaries(html)).toEqual(["Paste &amp; add"]);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("<label");
    expect(html).not.toContain("<textarea");
  });

  it("is Add once there is something in the field, and asks for a post's text only when X refused it", () => {
    expect(primaries(form({ value: "https://x.com/a/status/1" }))).toEqual(["Add"]);
    expect(form({ askForText: true })).toContain("X did not let us read that post.");
  });

  it("shows progress in the button, with no line under the field to make the header row taller", () => {
    const html = form({ value: "https://x.com/a/status/1", progress: "Adding 2 of 5…" });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Adding 2 of 5…<\/button>/);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("</p>");
  });

  it("lists what was not added, link by link with its reason, and what the cap left out", () => {
    const html = form({
      report: {
        text: "1 of 3 posts added. 2 not added.",
        failed: [
          { link: "https://www.reddit.com/r/SaaS/comments/abc/x/", error: "Paste the link of a post on X." },
          { link: "https://x.com/b/status/2", error: "You have reached today's limit of 60 drafts." },
        ],
        notes: ["3 more links were left out: 10 at a time."],
      },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("1 of 3 posts added. 2 not added.");
    expect(html).toContain("Paste the link of a post on X.");
    expect(html).toContain("today&#x27;s limit of 60 drafts");
    expect(html).toContain("3 more links were left out: 10 at a time.");
  });
});

describe("the daily count on the page", () => {
  it("shows N of G with dots when a goal is stored, a plain N today without, and says UTC when that is the zone used", () => {
    const withGoal = renderToStaticMarkup(<DayCount today={{ posted: 2, goal: 5, timeZone: "Europe/Berlin" }} browserZone="Europe/Berlin" />);
    expect(withGoal).toContain("2 of 5 today");
    expect(withGoal.match(/rounded-full/g)).toHaveLength(5);
    expect(withGoal).not.toContain("(UTC)");
    const plain = renderToStaticMarkup(<DayCount today={{ posted: 2, goal: null, timeZone: "Europe/Berlin" }} browserZone="Europe/Berlin" />);
    expect(plain).toContain("2 today");
    expect(plain).not.toContain("rounded-full");
    expect(plain).not.toContain(" of ");
    const utc = renderToStaticMarkup(<DayCount today={{ posted: 1, goal: null, timeZone: "UTC" }} browserZone={null} />);
    expect(utc).toContain("1 today");
    expect(utc).toContain("(UTC)");
    expect(renderToStaticMarkup(<DayCount today={undefined} browserZone="UTC" />)).toBe("");
  });

  it("reads the goal typed in Settings as a whole number from 1 to 50, or none", () => {
    expect(goalFromInput("5")).toBe(5);
    expect(goalFromInput("")).toBeNull();
    expect(goalFromInput("0")).toBeNull();
    expect(goalFromInput("-3")).toBeNull();
    expect(goalFromInput("abc")).toBeNull();
    expect(goalFromInput("500")).toBe(50);
  });
});

describe("the open item where it sits in the list", () => {
  it("is the item itself, whose header says who and closes it with a thumb-sized button", () => {
    const box = renderToStaticMarkup(
      <OpenInPlace target={target()}>
        <p>inside</p>
      </OpenInPlace>
    );
    expect(box).toContain('data-open-item="t-1"');
    expect(box).toContain("inside");
    const html = item(target(), { headerEnd: <CloseItem onClose={noop} /> });
    expect(html).toMatch(/<button[^>]*aria-expanded="true"[^>]*aria-label="Close"[^>]*h-11 w-11/);
    // Who, once: the author's name, then the platform and the age under it.
    expect(html).toContain("@asker");
    expect(html).toContain("X · posted 3h ago");
    expect(html).not.toContain("X · @asker · posted 3h ago");
  });
});

describe("the Today page", () => {
  const page = source("app/(app)/today/page.tsx");

  it("has three tabs in place of the filter menu, and no sentence that explains a list", () => {
    expect(page.match(/<ViewTabs\n/g)).toHaveLength(1);
    expect(page).not.toContain("InboxFilter");
    for (const gone of [
      "shown`",
      "only replies missing their link",
      "Show all posted",
      "found, not judged yet",
      "are missing their link",
      "were cited in a sampled AI answer",
      "Show all",
      "missingOnly",
      "Paste a post from X. We draft a reply in your voice; you post it.",
      "FilterMenu",
      "FilterSheet",
      "TargetCard",
      "movedToast",
      "arrangeInbox",
    ]) {
      expect(page).not.toContain(gone);
    }
  });

  it("puts the day's progress first, then the tabs, adding posts in To do, then the open reply, Also today and the next replies", () => {
    const at = (s: string) => page.indexOf(s);
    expect(at("<ProgressCard\n")).toBeGreaterThan(-1);
    expect(at("<ProgressCard\n")).toBeLessThan(at("<ViewTabs\n"));
    expect(at("<ViewTabs\n")).toBeLessThan(at("<AddPostForm\n"));
    expect(page).toContain('{tab === "todo" && (\n          <AddPostForm');
    expect(at("<OpenInPlace target={openTarget} card>")).toBeGreaterThan(-1);
    expect(at("<OpenInPlace target={openTarget} card>")).toBeLessThan(at("{also}\n            {nextRows.length > 0"));
    expect(page).toContain('<GroupHeading label="Next replies"');
  });

  it("reads Also today from the route get_today answers, and shows no section when it could not be read", () => {
    expect(page).toContain("fetch(`/api/today");
    expect(page).toContain("setAlsoToday(response.ok && Array.isArray(payload.alsoToday) ? payload.alsoToday : null)");
    // Still true, and its Undo of that one confirmation (About you is never written back); Paste link through the one action a link is saved by.
    expect(page).toContain('fetch("/api/business/voice-settings/about-you", {\n        method: "PATCH"');
    expect(page).toContain("body: JSON.stringify({ sentence, undo: { previousConfirmedOn } })");
    expect(page).not.toContain("JSON.stringify({ aboutYou: previous })");
    expect(page).toContain('act(id, "set_published_url", { publishedUrl })');
  });

  it("keeps ?source=ai_visibility on To do, narrowed to the cited rows", () => {
    expect(page).toContain('params.get("source") === AI_CITED_FILTER');
    expect(page).toContain('return filter.aiCited ? "ai_cited" : todayViewList(filter.tab);');
    expect(page).toContain('if (filters.aiCited) params.set("source", AI_CITED_FILTER);');
  });

  it("opens one item, lets a posted one leave at once with its Undo, and opens the next", () => {
    expect(page).toContain("setOpenId(nextOpenId(rowIds, id))");
    expect(page).toContain('act(id, "unmark_published")');
    expect(page).toContain("showToast(leftToast(action)");
    expect(page).toContain("<OpenInPlace");
    expect(page).toContain("useMediaQuery(TWO_PANES)");
  });

  it("keeps To do in the server's order, the posts the person chose before what was found", () => {
    expect(page).toContain('(["yours", "found"] as const)');
    expect(page).toContain("<GroupHeading");
    expect(source("lib/placements/read.ts")).toContain("targets: orderInbox(");
  });

  it("adds several posts one after the other and stops on a refusal that would be the same for all", () => {
    expect(page).toContain("for (const [index, link] of links.entries())");
    expect(page).toContain("[401, 402, 429, 503].includes(response.status)");
    expect(page).toContain("addSummary(attempts, over)");
  });

  it("sends the browser's time zone for the daily count, and scrolls the open item into view in the app's scrolling area", () => {
    expect(page).toContain('params.set("tz", zone)');
    expect(page).toContain("el.scrollIntoView({ block:");
    expect(page).not.toMatch(/position:\s*fixed|className="[^"]*\bfixed bottom-0/);
  });

  it("matches pasted reply links on the server and saves only what is sure through the one action a link is saved by", () => {
    expect(page).toContain('fetch("/api/placements/match-links"');
    expect(page).toContain('act(match.targetId, "set_published_url"');
    const route = source("app/api/placements/match-links/route.ts");
    expect(route).toContain("matchPastedReplyLinks(");
    expect(route).not.toContain(".update(");
    expect(route).not.toContain(".insert(");
    // The match itself, shared with the paste_reply_links tool, stores nothing either.
    const match = source("lib/placements/link-paste.ts");
    expect(match).toContain("matchReplyLinks(");
    expect(match).not.toContain(".update(");
    expect(match).not.toContain(".insert(");
  });
});

describe("Toast", () => {
  it("goes on its own after about four seconds, above the tab bar, with one action and a thumb-sized dismiss", () => {
    expect(TOAST_MS).toBeGreaterThanOrEqual(3_000);
    expect(TOAST_MS).toBeLessThanOrEqual(5_000);
    const empty = renderToStaticMarkup(<Toast toast={null} onDismiss={noop} />);
    expect(empty).toContain('aria-live="polite"');
    expect(empty).toContain("bottom-[calc(4.5rem+env(safe-area-inset-bottom))]");
    const html = renderToStaticMarkup(<Toast toast={{ id: 1, text: "Posted.", action: { label: "Undo", onClick: noop } }} onDismiss={noop} />);
    expect(html).toContain("Posted.");
    expect(html).toMatch(/<button[^>]*min-h-11[^>]*>Undo<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-label="Dismiss"[^>]*min-h-11/);
  });
});
