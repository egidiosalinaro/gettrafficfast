import type { Metadata } from "next";
import Link from "next/link";
import { LandingHeader } from "@/components/landing/header";
import { LandingFooter } from "@/components/landing/footer";
import { listPosts } from "@/lib/blog/posts";
import { blogJsonLd, blogUrl, breadcrumbJsonLd, jsonLdScript } from "@/lib/blog/structured-data";

/**
 * The blog: the product's own output, published by the product.
 *
 * It used to be three hardcoded posts signed "GetTrafficFast Team", dated
 * December 2024, which is exactly the kind of thing this product is supposed
 * to make unnecessary. Now it reads the articles generated for this site's own
 * business, and shows an empty state when there are none.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Blog - GetTrafficFast",
  description:
    "Articles written by GetTrafficFast for GetTrafficFast: same pipeline, same schedule, no editing pass a customer would not get.",
  alternates: { canonical: blogUrl() },
  openGraph: {
    title: "Blog - GetTrafficFast",
    description:
      "Articles written by GetTrafficFast for GetTrafficFast: same pipeline, same schedule.",
    siteName: "GetTrafficFast",
    type: "website",
    url: "/blog",
  },
};

function formatDate(date: string | null): string | null {
  if (!date) return null;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    // A stored day is a UTC day.
    timeZone: "UTC",
  });
}

async function loadSafely() {
  try {
    return await listPosts();
  } catch (error) {
    console.error("blog: could not load posts", error);
    return [];
  }
}

export default async function BlogPage() {
  const posts = await loadSafely();

  return (
    <div className="min-h-screen flex flex-col">
      {[blogJsonLd(posts), breadcrumbJsonLd()].map((block) => (
        <script
          key={String(block["@type"])}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdScript(block) }}
        />
      ))}
      <LandingHeader />
      <main className="flex-1">
        <div className="w-full max-w-[1200px] mx-auto px-5 py-20">
          <div className="mb-16">
            <h1 className="text-4xl md:text-5xl font-bold mb-4">Blog</h1>
            <p className="text-xl text-muted-foreground max-w-2xl">
              Every post here was researched, written and published by
              GetTrafficFast, for GetTrafficFast. It is the product running on
              its own domain, which is also the only demo worth trusting.
            </p>
          </div>

          {posts.length > 0 ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
              {posts.map((post) => {
                const date = formatDate(post.date);
                return (
                  <article
                    key={post.slug}
                    className="bg-card border rounded-lg p-6 hover:shadow-lg transition-shadow"
                  >
                    {date && (
                      <time className="text-sm text-muted-foreground mb-4 block">
                        {date}
                      </time>
                    )}
                    <h2 className="text-xl font-semibold mb-3">
                      <Link
                        href={`/blog/${post.slug}`}
                        className="hover:text-primary transition-colors"
                      >
                        {post.title}
                      </Link>
                    </h2>
                    <p className="text-muted-foreground mb-4 line-clamp-3">
                      {post.excerpt}
                    </p>
                    <Link
                      href={`/blog/${post.slug}`}
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      Read more →
                    </Link>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border p-8 max-w-[640px]">
              <p className="mb-2 font-medium">No posts yet.</p>
              <p className="text-muted-foreground text-sm">
                The invented sample posts that used to fill this page are gone.
                What appears here next will have come out of the same pipeline a
                customer pays for, on the same daily schedule.
              </p>
            </div>
          )}
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
