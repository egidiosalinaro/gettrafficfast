import { CanonicalArticle } from "@/lib/content/types";
import { appendVideoParagraphs } from "@/lib/media/embed";
import { DeliveryContext, DeliveryResult, PublisherAdapter } from "../types";
import {
  USER_AGENT,
  fetchWithTimeout,
  readErrorBody,
  wrapFetchError,
} from "../http";

/**
 * WordPress destination, via the REST API with an Application Password.
 *
 * WordPress renders the post title itself, so the body we send is the canonical
 * `bodyHtml` (no <h1>) — the title travels in its own field.
 */

export interface WordPressCredentials {
  siteUrl: string;
  username: string;
  applicationPassword: string;
}

function normalizeSiteUrl(input: string): string {
  let trimmed = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("Site URL must start with http:// or https://");
  }
  // Forgive common paste mistakes (admin/login/API paths).
  trimmed = trimmed.replace(/\/(wp-admin|wp-login\.php|wp-json)(\/.*)?$/i, "");
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`.replace(/\/+$/, "");
  } catch {
    throw new Error("Site URL is not a valid URL");
  }
}

function authHeader(username: string, applicationPassword: string): string {
  // WordPress accepts the application password with or without spaces.
  const pw = applicationPassword.replace(/\s+/g, "");
  return `Basic ${Buffer.from(`${username}:${pw}`).toString("base64")}`;
}

export class WordPressAdapter implements PublisherAdapter {
  readonly type = "wordpress" as const;
  private readonly siteUrl: string;
  private readonly auth: string;

  constructor(credentials: WordPressCredentials) {
    this.siteUrl = normalizeSiteUrl(credentials.siteUrl);
    this.auth = authHeader(credentials.username, credentials.applicationPassword);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: this.auth,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...extra,
    };
  }

  async testConnection(): Promise<void> {
    const url = `${this.siteUrl}/wp-json/wp/v2/users/me?context=edit`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers: this.headers() });
    } catch (err) {
      throw wrapFetchError(err, this.siteUrl);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `WordPress rejected the credentials (${res.status}): ${await readErrorBody(res)}`
      );
    }
    if (res.status === 404) {
      throw new Error(
        `WordPress REST API not found at ${this.siteUrl}/wp-json — is the site URL correct and is the REST API enabled?`
      );
    }
    if (!res.ok) {
      throw new Error(`WordPress auth failed (${res.status}): ${await readErrorBody(res)}`);
    }
    const me = await res.json();
    if (typeof me?.id !== "number") {
      throw new Error("WordPress returned an unexpected /users/me payload");
    }
  }

  /**
   * Uploads the hero to the WordPress media library so it can be the post's
   * featured image. Best-effort: a failure costs the featured image, never
   * the publication.
   */
  private async uploadHero(article: CanonicalArticle): Promise<number | null> {
    const hero = article.media?.hero;
    if (!hero) return null;
    try {
      const source = await fetchWithTimeout(hero.url, {});
      if (!source.ok) throw new Error(`fetching hero returned ${source.status}`);
      const bytes = Buffer.from(await source.arrayBuffer());
      const contentType = source.headers.get("content-type") ?? "image/png";
      const extension = contentType.includes("jpeg") ? "jpg" : contentType.split("/")[1] ?? "png";

      const res = await fetchWithTimeout(`${this.siteUrl}/wp-json/wp/v2/media`, {
        method: "POST",
        headers: this.headers({
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${article.slug || "hero"}.${extension}"`,
        }),
        body: bytes,
      });
      if (!res.ok) throw new Error(`media upload returned ${res.status}`);
      const media = await res.json();
      if (typeof media?.id !== "number") throw new Error("unexpected media payload");

      // Alt text lives on the attachment, not the post.
      await fetchWithTimeout(`${this.siteUrl}/wp-json/wp/v2/media/${media.id}`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ alt_text: hero.alt }),
      }).catch(() => undefined);

      return media.id;
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "wordpress.hero_upload_failed",
          error: err instanceof Error ? err.message : String(err),
        })
      );
      return null;
    }
  }

  async deliver(article: CanonicalArticle, context?: DeliveryContext): Promise<DeliveryResult> {
    // WordPress oEmbeds a bare watch URL in its own paragraph into a player,
    // so videos travel inside the content for this destination.
    const content = appendVideoParagraphs(article.bodyHtml, article.media?.videos ?? []);
    const featuredMedia = await this.uploadHero(article);

    const payload: Record<string, unknown> = {
      title: article.title,
      content,
      status: "publish",
    };
    if (article.slug) payload.slug = article.slug;
    if (article.metaDescription) payload.excerpt = article.metaDescription;
    if (featuredMedia) payload.featured_media = featuredMedia;

    // Updating an existing post is the same call against its own URL. Without
    // this a refresh would publish the article a second time instead of
    // replacing it.
    const url = context?.externalId
      ? `${this.siteUrl}/wp-json/wp/v2/posts/${encodeURIComponent(context.externalId)}`
      : `${this.siteUrl}/wp-json/wp/v2/posts`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw wrapFetchError(err, this.siteUrl);
    }
    if (!res.ok) {
      throw new Error(`WordPress publish failed (${res.status}): ${await readErrorBody(res)}`);
    }
    const post = await res.json();
    if (!post?.id || !post?.link) {
      throw new Error("WordPress publish returned unexpected payload");
    }
    return {
      url: String(post.link),
      externalId: String(post.id),
      payload,
      response: { id: post.id, link: post.link, status: post.status },
    };
  }
}
