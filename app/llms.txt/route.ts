import { DOC_SECTIONS } from "@/components/docs/sections";
import { listPosts } from "@/lib/blog/posts";
import { buildLlmsTxt, LLMS_TXT_POST_CAP, type LlmsTxtPost } from "@/lib/llms-txt";
import { SITE_NAME, SITE_SUMMARY, SITE_URL } from "@/lib/site";

/**
 * /llms.txt: the public site as a plain-text list for language models and
 * the agents that read it (lib/llms-txt.ts builds it, docs/BLOG.md explains
 * it). Public in the middleware and allowed in robots.txt
 * (lib/public-paths.ts).
 *
 * The posts are the published blog, the same rows /blog and the sitemap
 * read: `blog_posts` holds only what the webhook receiver stored, so a draft
 * (which lives in `articles`, unpublished) cannot appear here.
 *
 * Built per request, like the sitemap, so a post published today is listed
 * today without a redeploy and nothing reads the database at build time; the
 * CDN keeps a copy for an hour. When the posts cannot be read, the file is
 * still served without them, and kept only five minutes.
 */

export const dynamic = "force-dynamic";

const TAGLINE = "A content operating system for being found on search engines and in AI answer engines.";

async function loadPosts(): Promise<LlmsTxtPost[] | null> {
  try {
    return await listPosts(LLMS_TXT_POST_CAP);
  } catch (error) {
    console.error("llms.txt: could not load blog posts", error);
    return null;
  }
}

export async function GET(): Promise<Response> {
  const posts = await loadPosts();
  const body = buildLlmsTxt({
    siteUrl: SITE_URL,
    siteName: SITE_NAME,
    tagline: TAGLINE,
    summary: SITE_SUMMARY,
    docSections: DOC_SECTIONS,
    posts,
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": posts
        ? "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400"
        : "public, max-age=0, s-maxage=300",
    },
  });
}
