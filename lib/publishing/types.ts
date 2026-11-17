import { CanonicalArticle } from "@/lib/content/types";
import { IntegrationType } from "@/lib/integrations/types";

/**
 * The publishing boundary.
 *
 * An adapter's only job is to translate a Canonical Article into whatever its
 * destination expects and to perform the delivery. Adapters never parse
 * Markdown, never sanitise, never extract titles, never touch a regex on
 * content — by the time an article reaches one, all of that has happened and
 * the document is guaranteed valid.
 *
 * Adding a destination (Ghost, Shopify, Medium, …) means implementing this
 * interface and registering it. Nothing else in the platform changes.
 */

export interface DeliveryResult {
  /** Public URL of the published post. */
  url: string;
  /** Destination-side identifier, for idempotent updates. */
  externalId: string;
  /** What was sent — recorded for the delivery log. */
  payload?: unknown;
  /** What came back — recorded for the delivery log. */
  response?: unknown;
}

/**
 * What the platform knows about a PREVIOUS delivery of this article. Present
 * on a refresh, absent on a first publication — a destination that can update
 * in place uses it to update instead of creating a duplicate.
 */
export interface DeliveryContext {
  externalId?: string | null;
}

export interface PublisherAdapter {
  readonly type: IntegrationType;
  /** Verifies credentials/reachability without publishing anything. */
  testConnection(): Promise<void>;
  deliver(article: CanonicalArticle, context?: DeliveryContext): Promise<DeliveryResult>;
}

/** Minimal HTML escaping for plain-text values injected into markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The full-document rendering of a Canonical Article: the title as an <h1>
 * followed by the body. Destinations that render their own title should use
 * `bodyHtml` instead; this exists for the ones that expect a single blob.
 *
 * `afterTitle` is markup to sit between the title and the body. It exists for
 * the hero, which belongs above the article but below its title: receivers
 * that treat this field as one blob still find the <h1> first, and some of
 * them extract the title from there.
 */
export function renderFullHtml(
  article: CanonicalArticle,
  options: { afterTitle?: string } = {}
): string {
  const afterTitle = options.afterTitle ?? "";
  return `<h1>${escapeHtml(article.title)}</h1>\n${afterTitle}${article.bodyHtml}`;
}
