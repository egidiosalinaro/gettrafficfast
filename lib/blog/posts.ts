import { createAdminClient } from "@/lib/supabase/admin";
import { extractDataset, extractFaq, type ArticleDataset, type FaqPair } from "@/lib/publishing/seo";
import { faqFrom, sanitizeBlogHtml } from "./receive";

/**
 * The public blog of gettrafficfa.st.
 *
 * There is no CMS and no hand-written posts: every row in `blog_posts` arrived
 * through the ordinary Webhooks integration, delivered by the same pipeline a
 * customer pays for. If the product cannot write and deliver a decent article
 * to its own site, the blog is empty — which is the honest state to show, and
 * a much louder signal than a page of invented samples.
 *
 * Reads go through the admin client because a visitor has no session. The
 * table holds nothing private: it IS the published blog.
 */

export interface BlogHero {
  url: string;
  alt: string;
  caption: string | null;
  /** True when the hero is already inside body_html, so it is not rendered twice. */
  embedded: boolean;
}

export interface BlogPostSummary {
  slug: string;
  title: string;
  excerpt: string;
  /** ISO day (YYYY-MM-DD), or null when the delivery carried no date. */
  date: string | null;
  hero: BlogHero | null;
}

export interface BlogPost extends BlogPostSummary {
  bodyHtml: string;
  metaDescription: string;
  /** The article's own title for search; null when the delivery only had the headline. */
  metaTitle: string | null;
  /** The FAQ as pairs: the delivery's, or read from the stored body for rows older than payload v5. */
  faq: FaqPair[];
  /**
   * ISO day the published article last changed, when the sender said so and
   * it is later than `date`; null otherwise. Never the delivery time: a
   * retried delivery is not an update.
   */
  modified: string | null;
  /**
   * The article's own data, read from its "From our data" section on the
   * stored body (lib/publishing/seo.ts); null when it has none. Read on the
   * body, not stored, so no column is needed and every row has it.
   */
  dataset: ArticleDataset | null;
}

export interface PostRow {
  slug: string;
  title: string;
  body_html: string;
  excerpt: string | null;
  meta_description: string | null;
  hero: unknown;
  published_on: string | null;
  updated_at: string | null;
  /** Added by 20261110200000_blog_posts_seo.sql: absent on a database that has not run it. */
  meta_title?: string | null;
  faq?: unknown;
  modified_at?: string | null;
}

/**
 * Every column, not a list: the three SEO columns arrive with a migration
 * applied after the deploy, and naming a column that does not exist yet
 * would fail the read and empty the blog. A missing column reads undefined.
 */
const SELECT = "*";

function toHero(value: unknown): BlogHero | null {
  if (!value || typeof value !== "object") return null;
  const hero = value as Record<string, unknown>;
  if (typeof hero.url !== "string" || !hero.url) return null;
  return {
    url: hero.url,
    alt: typeof hero.alt === "string" ? hero.alt : "",
    caption: typeof hero.caption === "string" ? hero.caption : null,
    embedded: hero.embedded === true,
  };
}

/** One stored row to one post. Pure, so the mapping is testable without a database. */
export function toPost(row: PostRow): BlogPost {
  const stamp = row.published_on ?? row.updated_at ?? null;
  const date = stamp ? stamp.slice(0, 10) : null;
  const bodyHtml = sanitizeBlogHtml(row.body_html ?? "");
  const modifiedDay = typeof row.modified_at === "string" && !Number.isNaN(Date.parse(row.modified_at)) ? row.modified_at.slice(0, 10) : null;
  return {
    metaTitle: row.meta_title?.trim() || null,
    // What the sender extracted; a row from before payload v5 has none
    // stored, and the same structural read runs on its body here.
    faq: faqFrom(row.faq) ?? extractFaq(bodyHtml),
    dataset: extractDataset(bodyHtml, row.title),
    // "Updated" is said only for a change after the day it was published.
    modified: modifiedDay && (!date || modifiedDay > date) ? modifiedDay : null,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt ?? "",
    metaDescription: row.meta_description ?? row.excerpt ?? "",
    // Sanitised on receive as well; doing it again here covers rows stored
    // before the receiver sanitised, at the cost of one parse per render.
    bodyHtml,
    hero: toHero(row.hero),
    date,
  };
}

/**
 * The published blog, newest first. Each item is the whole post (a summary
 * plus the SEO fields): /llms.txt lists the meta description, and the row is
 * mapped in full either way.
 */
export async function listPosts(limit = 50): Promise<BlogPost[]> {
  const { data, error } = await createAdminClient()
    .from("blog_posts")
    .select(SELECT)
    .order("published_on", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) throw new Error(`blog: ${error.message}`);
  return (data ?? []).map((row: PostRow) => toPost(row));
}

export async function getPost(slug: string): Promise<BlogPost | null> {
  const { data, error } = await createAdminClient()
    .from("blog_posts")
    .select(SELECT)
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw new Error(`blog: ${error.message}`);
  return data ? toPost(data as PostRow) : null;
}
