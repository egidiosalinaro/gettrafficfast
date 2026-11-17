import { createHmac, timingSafeEqual } from "crypto";
import { sanitizeHtml } from "@/lib/content/stages/sanitize";
import { MAX_FAQ_PAIRS, type FaqPair } from "@/lib/publishing/seo";

/**
 * The receiving half of this site's own blog.
 *
 * gettrafficfa.st is a Next.js site, so it takes its articles the way every
 * other Next.js site does: the Webhooks integration posts a signed payload and
 * this endpoint stores it. There is deliberately no shortcut for the product's
 * own domain — a private path would mean the piece customers actually depend
 * on is the one piece never exercised.
 *
 * Everything here is pure so the contract can be tested without a database or
 * a request: the two things that break a receiver are a signature check that
 * does not check, and a payload mapping that silently drops a field.
 */

export interface WebhookArticlePayload {
  event?: "test" | "article.publish";
  title?: string;
  slug?: string | null;
  html?: string;
  keyword?: string | null;
  scheduled_date?: string | null;
  schema_version?: number;
  article_id?: string | null;
  body_html?: string | null;
  excerpt?: string | null;
  seo?: { meta_title?: string | null; meta_description?: string | null };
  media?: {
    hero?: { url: string; alt: string; caption: string | null; embedded?: boolean } | null;
    videos?: Array<Record<string, unknown>>;
  } | null;
  /** v5: the article's FAQ as pairs; [] when it has none. Absent from older senders. */
  faq?: Array<{ question?: unknown; answer?: unknown }> | null;
  /** v5: when the published document last changed (ISO); null when it never did. */
  date_modified?: string | null;
  /** v7: unique per request, signed with the body; a second sight of it is a replay. */
  delivery_id?: string;
}

/** A delivery id as the sender writes it (a UUID); anything else is not one. */
export function deliveryIdOf(payload: WebhookArticlePayload): string | null {
  const id = payload.delivery_id;
  return typeof id === "string" && /^[0-9a-f-]{8,64}$/i.test(id) ? id.toLowerCase() : null;
}

export interface BlogPostRow {
  gtf_article_id: string;
  slug: string;
  title: string;
  body_html: string;
  excerpt: string | null;
  meta_description: string | null;
  hero: Record<string, unknown> | null;
  videos: Array<Record<string, unknown>>;
  keyword: string | null;
  published_on: string | null;
  /** The article's own meta title; null when the sender only had the headline. */
  meta_title: string | null;
  /**
   * The FAQ pairs the sender extracted; null when the sender is older than
   * v5 and said nothing (the page then reads them from the stored body).
   */
  faq: FaqPair[] | null;
  /** When the sender says the document last changed; null when it never did. */
  modified_at: string | null;
}

/** The columns added for payload v5 (20261110200000_blog_posts_seo.sql). */
export const SEO_COLUMNS = ["meta_title", "faq", "modified_at"] as const;

/** The row as the table took it before those columns existed. */
export function withoutSeoColumns(row: BlogPostRow): Omit<BlogPostRow, (typeof SEO_COLUMNS)[number]> {
  const { meta_title: _metaTitle, faq: _faq, modified_at: _modifiedAt, ...legacy } = row;
  void _metaTitle;
  void _faq;
  void _modifiedAt;
  return legacy;
}

/** Plain text of a payload string: a pair is rendered as JSON-LD and never as markup, tags have no place in it. */
function plainText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** The payload's FAQ as pairs of non-empty strings; null when the payload does not carry the field. */
export function faqFrom(value: unknown): FaqPair[] | null {
  if (!Array.isArray(value)) return null;
  const pairs: FaqPair[] = [];
  for (const item of value) {
    const question = plainText((item as { question?: unknown } | null)?.question);
    const answer = plainText((item as { answer?: unknown } | null)?.answer);
    if (question && answer) pairs.push({ question, answer });
    if (pairs.length >= MAX_FAQ_PAIRS) break;
  }
  return pairs;
}

/**
 * Constant-time HMAC check over the RAW body. Reading the text before parsing
 * is not a style choice: JSON.parse then re-stringify produces different bytes
 * and the comparison silently never matches.
 *
 * This is the legacy v1 scheme (`X-Signature`, no timestamp), kept for the
 * contract tests. This site's receiver no longer accepts it on its own: it
 * requires the timestamped v2 signature (lib/publishing/webhook-signature.ts).
 */
export function verifySignature(rawBody: string, signature: string, secret: string | undefined): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The body as it may be rendered on gettrafficfa.st.
 *
 * The blog page puts `body_html` into the document as markup, on the product's
 * own origin, so a signature is not enough: it proves who sent the payload,
 * not that the payload is safe. The body goes through the content pipeline's
 * tree-level allowlist (lib/content/stages/sanitize.ts) on the way in: no
 * script, no iframe, no event handler, no javascript: URL. The only additions
 * to that allowlist are the two attributes the delivery itself writes after
 * the pipeline ran: the hero's `figure.gtf-hero` and its `fetchpriority`.
 */
export function sanitizeBlogHtml(html: string): string {
  return sanitizeHtml(html, {
    extraAttributes: { FIGURE: ["class"], IMG: ["fetchpriority"] },
  }).html;
}

/** Fallback for the legacy senders that omit a slug. */
export function slugFrom(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Payload to stored row, or null when the payload cannot become a post.
 *
 * `body_html` is preferred over `html` because it carries no <h1>: the title
 * is a field, and rendering both is how a blog ends up with every post titled
 * twice.
 */
export function toBlogPostRow(payload: WebhookArticlePayload): BlogPostRow | null {
  const title = payload.title?.trim();
  const raw = payload.body_html ?? payload.html ?? "";
  const body = typeof raw === "string" ? sanitizeBlogHtml(raw) : "";
  if (!title || !body.trim()) return null;

  const slug = (payload.slug || slugFrom(title)).trim();
  if (!slug) return null;

  // article_id is stable across republishes; the slug is the fallback for
  // senders old enough not to have one.
  const gtfArticleId = payload.article_id || slug;
  const hero = payload.media?.hero ?? null;
  // The headline repeated as a meta title is not one: stored only when the
  // sender had a title written for search.
  const metaTitle = payload.seo?.meta_title?.trim() || null;
  const modified = typeof payload.date_modified === "string" && !Number.isNaN(Date.parse(payload.date_modified))
    ? new Date(payload.date_modified).toISOString()
    : null;

  return {
    gtf_article_id: gtfArticleId,
    slug,
    title,
    body_html: body,
    excerpt: payload.excerpt?.trim() || null,
    meta_description: payload.seo?.meta_description?.trim() || payload.excerpt?.trim() || null,
    hero: hero ? { ...hero } : null,
    videos: payload.media?.videos ?? [],
    keyword: payload.keyword?.trim() || null,
    published_on: payload.scheduled_date ?? null,
    meta_title: metaTitle && metaTitle !== title ? metaTitle : null,
    faq: faqFrom(payload.faq),
    modified_at: modified,
  };
}
