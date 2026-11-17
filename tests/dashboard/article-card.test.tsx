import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Radix renders the dialog into a portal after mount, so on the server it is
// empty. The modal's content is what is under test, not Radix.
vi.mock("@/components/ui/dialog", () => {
  const Plain = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Plain,
    DialogContent: Plain,
    DialogHeader: Plain,
    DialogTitle: Plain,
    DialogDescription: Plain,
    DialogFooter: Plain,
  };
});

import {
  articleStatusLabel,
  NeedsReviewArticleCard,
  PublishedArticleCard,
  QueuedArticleCard,
  regenerateQuestion,
  type Article,
} from "@/components/dashboard/article-card";
import { ArticleModal } from "@/components/dashboard/article-modal";
import { dayKey } from "@/components/dashboard/calendar-model";
import { confirmTap, InlineConfirmView } from "@/components/ui/inline-confirm";
import { HELD_LAST_ERROR, HELD_QUALITY_REPORT } from "../fixtures/held-article-2026-11-12";

/**
 * Regenerate rewrites an article from scratch; on a published one, the next
 * delivery replaces the live post. One stray tap must not do that, so the
 * first tap asks inline and only the second acts. Not `window.confirm`: it
 * is blocked in some in-app browsers and reads as an error on a phone.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

const lastWeek = (() => {
  const now = new Date();
  return dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));
})();

const published: Article = {
  id: "a-1",
  keyword: "best trail shoes",
  status: "published",
  scheduledDate: lastWeek,
  publishedUrl: "https://example.com/best-trail-shoes",
  content: "<p>Body</p>",
};

describe("confirm before a rewrite", () => {
  it("acts on the second tap, never the first", () => {
    expect(confirmTap("idle")).toEqual({ next: "confirming", act: false });
    expect(confirmTap("confirming")).toEqual({ next: "idle", act: true });
  });

  it("says what a rewrite of a live article does", () => {
    expect(regenerateQuestion("published")).toBe("This rewrites the published article. Continue?");
    expect(regenerateQuestion("generated")).toMatch(/rewrites the article from scratch/);
  });

  it("shows only the control before the first tap, and the question after it", () => {
    const props = {
      question: regenerateQuestion("published"),
      confirmLabel: "Rewrite it",
      trigger: () => <button type="button">Regenerate</button>,
      onTap: () => {},
      onCancel: () => {},
    };
    const idle = renderToStaticMarkup(<InlineConfirmView step="idle" {...props} />);
    expect(idle).toContain("Regenerate");
    expect(idle).not.toContain("Continue?");

    const asking = renderToStaticMarkup(<InlineConfirmView step="confirming" {...props} />);
    expect(asking).toContain("This rewrites the published article. Continue?");
    expect(asking).toContain("Rewrite it");
    expect(asking).toContain("Cancel");
    expect(asking).not.toContain(">Regenerate<");
  });

  it("starts a published card at the first step", () => {
    const html = renderToStaticMarkup(
      <PublishedArticleCard article={published} onGenerateNow={() => {}} onView={() => {}} />
    );
    expect(html).toContain("Regenerate");
    expect(html).not.toContain("Continue?");
  });

  it("starts the modal at the first step too, for Regenerate and Republish", () => {
    const html = renderToStaticMarkup(
      <ArticleModal
        article={published}
        hasIntegration
        onClose={() => {}}
        onRegenerate={() => {}}
        onPublish={async () => ({ ok: true })}
      />
    );
    expect(html).toContain("Regenerate");
    expect(html).toContain("Republish");
    expect(html).not.toContain("Continue?");
  });

  it("never falls back to window.confirm", () => {
    for (const file of [
      "components/dashboard/article-card.tsx",
      "components/dashboard/article-modal.tsx",
      "components/dashboard/calendar.tsx",
      "components/dashboard/calendar-view.tsx",
      "components/ui/inline-confirm.tsx",
    ]) {
      // A call, not a mention: the components' comments say why it is not used.
      expect(source(file)).not.toMatch(/window\.confirm\s*\(|\bconfirm\s*\(/);
    }
  });
});

describe("search volume on a card", () => {
  const queued = (searchVolume: number | null): Article => ({
    id: "q-1",
    keyword: "trail running shoes",
    status: "queued",
    scheduledDate: lastWeek,
    searchVolume,
  });

  it("groups thousands in English and says when there is no estimate", () => {
    expect(renderToStaticMarkup(<QueuedArticleCard article={queued(12400)} />)).toContain("12,400 /mo");
    const none = renderToStaticMarkup(<QueuedArticleCard article={queued(null)} />);
    expect(none).toContain("volume not estimated");
    expect(none).not.toContain("—");
  });
});

describe("ArticleModal", () => {
  it("dates a published article by when it went out, in words", () => {
    const html = renderToStaticMarkup(
      <ArticleModal article={published} hasIntegration={false} onClose={() => {}} />
    );
    expect(html).toMatch(/Published [^<]/);
    expect(html).not.toContain(`Scheduled for ${lastWeek}`);
    expect(html).not.toContain(lastWeek);
  });

  it("gives its buttons a 44px target on a phone", () => {
    const html = renderToStaticMarkup(
      <ArticleModal
        article={published}
        hasIntegration
        onClose={() => {}}
        onRegenerate={() => {}}
        onPublish={async () => ({ ok: true })}
      />
    );
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(3);
    for (const button of buttons) expect(button).toMatch(/\bh-11\b/);
  });
});

describe("articleStatusLabel", () => {
  it("never shows a raw status", () => {
    expect(articleStatusLabel("needs_review")).toBe("Needs review");
    expect(articleStatusLabel("published")).toBe("Published");
    expect(articleStatusLabel("some_new_state")).toBe("Some new state");
  });
});

describe("Held before publishing: the reasons (2026-11-12)", () => {
  const held: Article = {
    id: "held-1",
    keyword: "ai seo content writer",
    status: "needs_review",
    content: "<h1>AI SEO Content Writer</h1><p>Body.</p>",
    qualityReport: HELD_QUALITY_REPORT as unknown as Article["qualityReport"],
    lastError: HELD_LAST_ERROR,
  };
  const modal = (article: Article) =>
    renderToStaticMarkup(
      <ArticleModal article={article} hasIntegration onClose={() => {}} onRegenerate={() => {}} onPublish={async () => ({ ok: true })} />
    );

  it("lists the reason the real row recorded, not an empty list, with Regenerate and Publish anyway", () => {
    const html = modal(held);
    expect(html).toContain("these quality checks failed, so it was not sent to your site:");
    expect(html).toContain("<li>The audit found a critical problem: The article&#x27;s central figures");
    expect(html).toContain("Regenerate");
    expect(html).toContain("Publish anyway");
    expect(html).not.toContain("The reason was not recorded.");
  });

  it("says the reason was not recorded rather than show an empty list", () => {
    const html = modal({ ...held, lastError: null });
    expect(html).toContain("The reason was not recorded.");
    expect(html).not.toContain("these quality checks failed");
    expect(html).not.toMatch(/<ul[^>]*list-disc/);
  });

  it("counts the reasons on the card", () => {
    expect(renderToStaticMarkup(<NeedsReviewArticleCard article={held} />)).toContain("1 quality check failed");
  });
});
