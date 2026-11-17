"use client";

import { useState } from "react";
import { Copy, Check, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AI_ANSWER_CRAWLERS, AI_TRAINING_CRAWLERS } from "@/lib/ai-crawlers";

const PROMPT = `I use GetTrafficFast to auto-generate SEO blog articles and I want to publish them on my own website using its Webhook integration. Please add a webhook receiver endpoint to my site.

First, detect my framework/stack from the codebase and implement this idiomatically (for example a Next.js Route Handler, an Express route, a Django/Rails/Laravel controller, etc.).

Contract, implement it EXACTLY:
- Expose a public HTTPS endpoint that accepts POST with Content-Type: application/json.
- Each request includes an "X-GTF-Timestamp" header (Unix seconds) and an "X-GTF-Signature" header of the form "v2=<hex>", where <hex> is the hex-encoded HMAC-SHA256 of the string timestamp + "." + RAW request body, keyed with a shared secret. Read the RAW body first and verify the signature with a timing-safe comparison BEFORE parsing JSON. If it doesn't match, or the timestamp is more than 300 seconds away from the server clock, respond 401. (An older "X-Signature" header, the HMAC of the body alone, is also sent; do not rely on it: it has no timestamp, so a captured request would verify forever.)
- Every request body has a "delivery_id" (unique per request; a retry is a new request with a new id). Remember the ids seen in the last 10 minutes (database table or cache) and answer 409 to one already seen, so a captured request cannot be replayed inside the 5-minute window.
- Store the shared secret in an environment variable named GTF_WEBHOOK_SECRET. Generate a long random value for it (I will paste the same value into GetTrafficFast).
- The JSON request body (content schema v2) looks like:
  {
    "event": "test" | "article.publish",
    "title": "Article title",
    "slug": "article-slug" | null,
    "html": "<h1>...</h1>...",        // legacy: full HTML including the <h1>
    "keyword": "target keyword" | null,
    "scheduled_date": "2026-07-20" | null,
    "schema_version": 2,
    "article_id": "stable-uuid",       // stable per article, across republishes
    "body_html": "<p>...</p><h2 id=\\"...\\">...</h2>...",  // no <h1>; h2/h3 have id anchors; starts with <figure class=\\"gtf-hero\\"> when there is a hero
    "excerpt": "plain-text excerpt",
    "seo": { "meta_title": "...", "meta_description": "..." },
    "headings": [{ "level": 2, "id": "...", "text": "..." }],
    "delivery_id": "uuid"              // unique per request
  }
- If event === "test": just return HTTP 200 (e.g. {"ok": true}). This is the connection test.
- If event === "article.publish": UPSERT the article keyed by "article_id" (store it in the article record; fall back to slug only if article_id is absent). GetTrafficFast can republish the same article to update it: the same article_id must UPDATE the existing post, never create a duplicate. Then return HTTP 200 with JSON EXACTLY in this shape:
    {"url": "https://<my-domain>/blog/<slug>"}
  That URL is the public address of the published post; GetTrafficFast stores it as the article's live URL.
- Render the post with "title" as the page's own <h1>, and "body_html" as the article body (it intentionally contains NO <h1>, so the title is never duplicated). When a hero image exists, body_html starts with <figure class="gtf-hero"><img ...></figure>: keep that figure, do not drop images. Use "seo.meta_title" / "seo.meta_description" for the <title> tag and meta description. "headings" (matching the id anchors in body_html) is available if you want a table of contents.
- CRITICAL, typography: body_html is semantic HTML (h2, h3, p, ul, ol, li, strong, em, a, figure, img) with almost NO classes (the hero is figure.gtf-hero). If the site uses Tailwind, its preflight resets headings and lists to plain text, so you MUST style the article container: either wrap it in Tailwind Typography classes (prose, e.g. "prose lg:prose-lg max-w-none", with prose-invert on dark themes) or add scoped CSS for the container covering h2 (~1.875rem bold, generous top margin), h3 (~1.5rem semibold), p (~1.125rem with bottom margin), ul/ol (bullets/numbers + indent), li spacing, strong, links, and figures/images (full width, rounded, margin under the hero). Verify the rendered post shows a clear visual hierarchy and the hero photo, not uniform text.
- Be idempotent: the same article may be delivered more than once (automatic retries and manual republish), so upsert, never insert duplicates.
- Respond within 10 seconds. Defer heavy work (image processing, mass revalidation).
- If my site is statically generated, revalidate the blog index and the post path after saving so new AND updated articles appear immediately.
- Also create the blog list/post pages if they don't already exist.
- Make the blog readable by AI search and answer engines. In robots.txt, add a group that names ${AI_ANSWER_CRAWLERS.join(", ")} and gives them the same rules as "User-agent: *" (a crawler named in its own group stops reading "*", so repeat its Disallow lines; never block the blog). Ask me before adding a group for the training crawlers (${AI_TRAINING_CRAWLERS.join(", ")}): allowing or blocking model training is my decision. Then serve /llms.txt as text/plain, generated from the stored articles on request (not a static file): "# <site name>", a "> " line saying what the site is, then "## Blog" with one line per published article, newest first, at most 50: "- [title](absolute post URL): meta description". Escape "[" and "]" in titles, collapse newlines to spaces, and list only published articles.

When you're done, tell me (1) the full public endpoint URL and (2) remind me to set GTF_WEBHOOK_SECRET. I'll paste the URL and the same secret into GetTrafficFast → Settings → Connections → Webhook to finish connecting.`;

export function AiAgentPrompt() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context); nothing to do.
    }
  }

  return (
    <Card className="p-6 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary shrink-0" />
          <h3 className="font-semibold">Let your AI coding agent build it</h3>
        </div>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? (
            <Check className="h-4 w-4 mr-1.5" />
          ) : (
            <Copy className="h-4 w-4 mr-1.5" />
          )}
          {copied ? "Copied!" : "Copy prompt"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Don&apos;t want to write the endpoint yourself? Copy this prompt and paste
        it into your AI coding agent (Cursor, Claude Code, Copilot, v0, …) inside
        your website&apos;s repository. It builds a webhook receiver that matches
        this integration exactly. Then paste the resulting endpoint URL and secret
        into the form above.
      </p>
      <pre className="text-xs bg-background border border-border rounded-md p-3 overflow-y-auto max-h-72 whitespace-pre-wrap break-words">
{PROMPT}
      </pre>
    </Card>
  );
}
