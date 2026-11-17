import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./support/fake-supabase";

/**
 * GET /llms.txt reads the published blog and nothing else: `blog_posts` is
 * what the receiver stored, and a draft (an `articles` row never delivered)
 * must not reach the file.
 */

const m = vi.hoisted(() => ({ db: null as unknown as FakeSupabase, tables: [] as string[], fail: false }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      m.tables.push(table);
      if (m.fail) throw new Error("database down");
      return m.db.from(table);
    },
  }),
}));

import { GET } from "@/app/llms.txt/route";

const row = (slug: string, published_on: string, meta_description: string | null) => ({
  gtf_article_id: `article-${slug}`,
  slug,
  title: `Post ${slug}`,
  body_html: "<p>Body.</p>",
  excerpt: `Excerpt of ${slug}.`,
  meta_description,
  hero: null,
  published_on,
  updated_at: `${published_on}T08:00:00.000Z`,
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  m.tables = [];
  m.fail = false;
  m.db = new FakeSupabase({
    blog_posts: [row("older", "2026-11-01", "Older description."), row("newer", "2026-11-10", null)],
    articles: [{ id: "draft-1", slug: "draft-article", title: "Draft article", status: "generated", keyword: "draft" }],
  });
});

describe("GET /llms.txt", () => {
  it("lists the published posts newest first, with their meta description or excerpt, as cached plain text", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("s-maxage=3600");

    const text = await response.text();
    expect(text.startsWith("# GetTrafficFast\n")).toBe(true);
    const newer = text.indexOf("- [Post newer](https://gettrafficfa.st/blog/newer): Excerpt of newer.");
    const older = text.indexOf("- [Post older](https://gettrafficfa.st/blog/older): Older description.");
    expect(newer).toBeGreaterThan(0);
    expect(older).toBeGreaterThan(newer);
  });

  it("never reads the articles table, so a draft is not listed", async () => {
    const text = await (await GET()).text();
    expect(m.tables).toEqual(["blog_posts"]);
    expect(text).not.toContain("draft-article");
    expect(text).not.toContain("Draft article");
  });

  it("is still served, without posts and kept briefly, when the blog cannot be read", async () => {
    m.fail = true;
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=300");
    const text = await response.text();
    expect(text).toContain("## Docs");
    expect(text).not.toContain("/blog/");
  });
});
