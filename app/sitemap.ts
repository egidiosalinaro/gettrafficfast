import { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { listPosts } from "@/lib/blog/posts";

/**
 * Blog entries are read from the database rather than hardcoded: a sitemap
 * listing three posts that no longer exist is worse than no sitemap at all,
 * and it is the first thing a crawler reads.
 */
async function blogRoutes(baseUrl: string): Promise<MetadataRoute.Sitemap> {
  try {
    const posts = await listPosts();
    return posts.map((post) => ({
      url: `${baseUrl}/blog/${post.slug}`,
      lastModified: post.date ? new Date(post.date) : new Date(),
      changeFrequency: "weekly" as const,
      priority: 0.7,
    }));
  } catch (error) {
    console.error("sitemap: could not load blog posts", error);
    return [];
  }
}

// Generated per request, not at build time: a post published today must be in
// the sitemap today, without a redeploy.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || SITE_URL;

  const routes: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${baseUrl}/pricing`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/blog`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    // The documentation: how the product works and how it measures, read by
    // people and by agents deciding whether to connect it.
    {
      url: `${baseUrl}/docs`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    // The MCP reference: the page MCP registries and agent directories link to.
    {
      url: `${baseUrl}/docs/mcp`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    // No redirect is listed (lib/legacy-redirects.ts): a sitemap must list
    // only pages that answer 200. Search Console reported one as "Page with
    // redirect" on 2026-11-12.
    {
      url: `${baseUrl}/privacy-policy`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/terms-and-conditions`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];

  return [...routes, ...(await blogRoutes(baseUrl))];
}
