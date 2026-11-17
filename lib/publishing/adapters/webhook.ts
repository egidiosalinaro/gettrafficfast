import { randomUUID } from "crypto";
import { CanonicalArticle } from "@/lib/content/types";
import { renderHeroFigure } from "@/lib/media/figures";
import {
  DeliveryResult,
  PublisherAdapter,
  renderFullHtml,
} from "../types";
import { canonicalDateModified, canonicalMetaDescription, canonicalMetaTitle, extractDataset, extractFaq } from "../seo";
import {
  USER_AGENT,
  fetchWithTimeout,
  normalizeHttpUrl,
  wrapFetchError,
} from "../http";
import { signatureHeaders } from "../webhook-signature";

export { signPayload } from "../webhook-signature";

/**
 * Generic signed-webhook destination: any site that can accept an HTTPS POST.
 * This is what Postwren, custom Next.js sites and headless CMSs use.
 *
 * The wire format below is a PUBLIC CONTRACT (documented in
 * docs/NEXTJS_WEBHOOK_RECEIVER.md and implemented by live receivers). v1 fields
 * are frozen; v2 fields are additive. Changing either is a breaking change for
 * every customer and must go through a version bump, never an edit in place.
 */

/**
 * Version of the receiver-facing payload — independent of the canonical model.
 * v3 adds the `media` object (hero, inline images, videos); v4 adds
 * `media.hero.embedded`; v5 adds `faq` and `date_modified`, and
 * `seo.meta_title` carries the article's own meta title when it has one
 * (it was always the headline before); v6 adds `dataset`, the article's own
 * data as a schema.org Dataset names it; v7 adds `delivery_id`, unique per
 * request (a retry is a new request with a new id), which goes with the
 * timestamped signature (../webhook-signature.ts) so a receiver can drop a
 * replay. Everything in v1 and v2 is unchanged in shape, so existing
 * receivers keep working untouched.
 */
export const WEBHOOK_PAYLOAD_SCHEMA_VERSION = 7;

export interface WebhookCredentials {
  url: string;
  secret: string;
}

/**
 * The bytes of one request: the payload plus a fresh `delivery_id`. Added
 * here rather than in buildWebhookPayload so the id belongs to the request,
 * the test included, and is inside what is signed.
 */
export function deliveryBody(payload: Record<string, unknown>, deliveryId: string = randomUUID()): string {
  return JSON.stringify({ ...payload, delivery_id: deliveryId });
}

export function buildWebhookPayload(article: CanonicalArticle): Record<string, unknown> {
  const hero = article.media?.hero ?? null;
  const heroFigure = hero ? renderHeroFigure(hero) : "";
  const dataset = extractDataset(article.bodyHtml, article.title);

  return {
    // ── v1 — frozen ────────────────────────────────────────────────────────
    event: "article.publish",
    title: article.title,
    slug: article.slug || null,
    html: renderFullHtml(article, { afterTitle: heroFigure }),
    keyword: article.keyword || null,
    scheduled_date: article.scheduledDate,
    // ── v2 — additive ──────────────────────────────────────────────────────
    schema_version: WEBHOOK_PAYLOAD_SCHEMA_VERSION,
    article_id: article.articleId || null,
    body_html: `${heroFigure}${article.bodyHtml}`,
    excerpt: article.excerpt,
    seo: {
      // The document's meta title when it has one; the headline otherwise,
      // which is what this field always carried.
      meta_title: canonicalMetaTitle(article) ?? article.title,
      meta_description: canonicalMetaDescription(article),
    },
    headings: article.headings,
    // ── v3 / v4 — additive ─────────────────────────────────────────────────
    // Inline images and the hero are both in html/body_html as <figure>.
    // Videos are never embedded (embed mechanics are destination-specific).
    // media.hero is still sent for OG images and card thumbnails; `embedded`
    // is true whenever the figure is in the body, so a receiver that also
    // renders media.hero does not show the same picture twice.
    media: {
      hero: article.media?.hero
        ? {
            url: article.media.hero.url,
            alt: article.media.hero.alt,
            caption: article.media.hero.caption,
            embedded: true,
          }
        : null,
      images: (article.media?.images ?? []).map((image) => ({
        url: image.url,
        alt: image.alt,
        caption: image.caption,
        slot: image.slot,
      })),
      videos: (article.media?.videos ?? []).map((video) => ({
        provider: video.provider,
        video_id: video.videoId,
        url: video.url,
        embed_url: video.embedUrl,
        title: video.title,
        thumbnail_url: video.thumbnailUrl,
        slot: video.slot,
      })),
    },
    // ── v5 — additive ──────────────────────────────────────────────────────
    // What a receiver needs to render the same structured data we do: the
    // FAQ as pairs (read from the body's tree; [] when the article has no
    // FAQ section), and when the published document last changed (null when
    // it never did: a first delivery, or a retry of one).
    faq: extractFaq(article.bodyHtml).map((pair) => ({ question: pair.question, answer: pair.answer })),
    date_modified: canonicalDateModified(article),
    // ── v6 — additive ──────────────────────────────────────────────────────
    // The article's "From our data" section as a Dataset: null when it has
    // none, which is most articles (only an owner's published measurements
    // make one). `temporal_coverage` is null when the section names no period.
    dataset: dataset
      ? {
          name: dataset.name,
          description: dataset.description,
          temporal_coverage: dataset.temporalCoverage,
          heading_id: dataset.headingId,
        }
      : null,
  };
}

export class WebhookAdapter implements PublisherAdapter {
  readonly type = "webhook" as const;
  private readonly url: string;
  private readonly secret: string;

  constructor(credentials: WebhookCredentials) {
    this.url = normalizeHttpUrl(credentials.url, "Webhook URL");
    if (!credentials.secret) throw new Error("Webhook secret is required");
    this.secret = credentials.secret;
  }

  private async send(payload: Record<string, unknown>): Promise<Response> {
    const rawBody = deliveryBody(payload);
    try {
      return await fetchWithTimeout(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          // Both schemes: X-Signature (v1, body only) for receivers not yet
          // moved, X-GTF-Signature + X-GTF-Timestamp (v2) for the rest.
          ...signatureHeaders(this.secret, rawBody),
        },
        body: rawBody,
      });
    } catch (err) {
      throw wrapFetchError(err, this.url);
    }
  }

  async testConnection(): Promise<void> {
    const res = await this.send({ event: "test" });
    if (!res.ok) {
      throw new Error(
        `Webhook endpoint rejected the test request (${res.status} ${res.statusText})`
      );
    }
  }

  async deliver(article: CanonicalArticle): Promise<DeliveryResult> {
    const payload = buildWebhookPayload(article);
    const res = await this.send(payload);
    if (!res.ok) {
      throw new Error(`Webhook publish failed (${res.status} ${res.statusText})`);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error("Webhook endpoint did not return JSON — expected {url}");
    }
    const url = (data as { url?: unknown })?.url;
    if (typeof url !== "string" || !url) {
      throw new Error('Webhook endpoint must respond with JSON {url: "..."}');
    }
    return { url, externalId: url, payload, response: data };
  }
}
